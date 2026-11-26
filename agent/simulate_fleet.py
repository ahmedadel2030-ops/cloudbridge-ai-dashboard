"""Send fake but realistic data for 8 hosts, so the dashboard has something to show.

  python simulate_fleet.py --api http://localhost:8000 --key dev-key-change-me
Press Ctrl+C to stop. Use --incident to inject the demo problem on esx-prod-01.
"""
import argparse
import random
import time

import requests

FLEET = [
    ("esx-prod-01", "Virtualization", "VMware ESXi", "DC1"), ("esx-prod-02", "Virtualization", "VMware ESXi", "DC1"),
    ("san-store-01", "Storage", "Storage array", "DC1"), ("ipsec-gw-eu", "Network", "VPN gateway", "DC1-AWS"),
    ("api-gateway-aws", "Cloud", "AWS EC2", "eu-central-1"), ("rds-orders", "Cloud", "AWS RDS", "eu-central-1"),
    ("app-vmss-az", "Application", "Azure VMSS", "westeurope"), ("k8s-workers", "Compute", "Kubernetes", "hybrid"),
]

p = argparse.ArgumentParser()
p.add_argument("--api", default="http://localhost:8000")
p.add_argument("--key", default="dev-key-change-me")
p.add_argument("--incident", action="store_true")
p.add_argument("--interval", type=float, default=5)
a = p.parse_args()
start = time.time()
while True:
    recs = []
    for name, layer, platform, env in FLEET:
        cpu, mem, disk, lat = random.uniform(30, 65), random.uniform(40, 70), random.uniform(35, 60), random.uniform(60, 180)
        if a.incident and name == "esx-prod-01" and time.time() - start > 20:
            cpu, mem, lat = random.uniform(93, 98), random.uniform(86, 94), random.uniform(420, 700)
        recs.append({"host": name, "layer": layer, "platform": platform, "env": env,
                     "cpu": cpu, "mem": mem, "disk": disk, "latency": lat, "services": {"main": True}})
    r = requests.post(f"{a.api}/api/ingest", json={"records": recs}, headers={"X-API-Key": a.key}, timeout=10)
    print(time.strftime("%H:%M:%S"), r.status_code, r.json())
    time.sleep(a.interval)
