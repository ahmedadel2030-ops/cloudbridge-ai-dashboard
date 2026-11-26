"""CloudBridge collector agent.

Run it on any server. It measures CPU, memory and disk with psutil and sends them
to the CloudBridge API every INTERVAL seconds.

  pip install psutil requests
  python collector.py --api http://localhost:8000 --key dev-key-change-me \
      --host web-01 --layer Compute --service nginx

Everything it sends is plain JSON over HTTP. Nothing is uploaded by hand.
"""
import argparse
import socket
import time

import psutil
import requests


def measure(args) -> dict:
    t0 = time.time()
    latency = None
    if args.probe:
        try:
            requests.get(args.probe, timeout=5)
            latency = (time.time() - t0) * 1000
        except requests.RequestException:
            latency = 5000.0
    services = {}
    names = {p.info["name"] for p in psutil.process_iter(["name"])}
    for s in args.service or []:
        services[s] = any(s.lower() in (n or "").lower() for n in names)
    rec = {
        "host": args.host, "layer": args.layer, "platform": args.platform, "env": args.env,
        "cpu": psutil.cpu_percent(interval=1), "mem": psutil.virtual_memory().percent,
        "disk": psutil.disk_usage("/").percent, "services": services,
    }
    if latency is not None:
        rec["latency"] = latency
    return rec


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--api", default="http://localhost:8000")
    p.add_argument("--key", default="dev-key-change-me")
    p.add_argument("--host", default=socket.gethostname())
    p.add_argument("--layer", default="Compute")
    p.add_argument("--platform", default="Linux")
    p.add_argument("--env", default="prod")
    p.add_argument("--service", action="append", help="process name to watch (repeatable)")
    p.add_argument("--probe", help="URL to time, becomes latency_ms")
    p.add_argument("--interval", type=int, default=15)
    p.add_argument("--once", action="store_true")
    a = p.parse_args()
    while True:
        rec = measure(a)
        try:
            r = requests.post(f"{a.api}/api/ingest", json=rec, headers={"X-API-Key": a.key}, timeout=10)
            print(time.strftime("%H:%M:%S"), r.status_code, rec)
        except requests.RequestException as e:
            print("send failed, will retry:", e)
        if a.once:
            break
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
