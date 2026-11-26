"""SQLite storage. One file, no setup. Swap for Postgres in production."""
import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("CB_DB", os.path.join(os.path.dirname(__file__), "..", "cloudbridge.db"))
_lock = threading.Lock()


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


_c = None


def db() -> sqlite3.Connection:
    global _c
    if _c is None:
        _c = conn()
        init(_c)
    return _c


def reset(path: str | None = None):
    global _c, DB_PATH
    if path:
        DB_PATH = path
    _c = None


def init(c: sqlite3.Connection):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS hosts(
      name TEXT PRIMARY KEY, layer TEXT, platform TEXT, env TEXT, source TEXT,
      cpu REAL, mem REAL, disk REAL, latency REAL, services TEXT, last_seen REAL);
    CREATE TABLE IF NOT EXISTS samples(
      id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, ts REAL,
      cpu REAL, mem REAL, disk REAL, latency REAL);
    CREATE INDEX IF NOT EXISTS ix_samples ON samples(host, ts);
    CREATE TABLE IF NOT EXISTS incidents(
      id TEXT PRIMARY KEY, host TEXT, status TEXT, detected_at REAL, resolved_at REAL,
      applied_action TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, action TEXT, detail TEXT);
    """)
    c.commit()


def upsert_record(rec: dict, source: str = "agent"):
    """rec: host, layer, platform, env, cpu, mem, disk, latency, services{}, ts"""
    ts = float(rec.get("ts") or time.time())
    with _lock:
        c = db()
        old = c.execute("SELECT * FROM hosts WHERE name=?", (rec["host"],)).fetchone()
        layer = rec.get("layer") or (old["layer"] if old else "Compute")
        platform = rec.get("platform") or (old["platform"] if old else "Linux")
        env = rec.get("env") or (old["env"] if old else "prod")
        def val(k):
            v = rec.get(k)
            return float(v) if v not in (None, "") else (old[k] if old else 0.0)
        services = rec.get("services")
        if services is None:
            services = json.loads(old["services"]) if old else {}
        c.execute("""INSERT INTO hosts(name,layer,platform,env,source,cpu,mem,disk,latency,services,last_seen)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(name) DO UPDATE SET layer=excluded.layer, platform=excluded.platform,
                     env=excluded.env, source=excluded.source, cpu=excluded.cpu, mem=excluded.mem,
                     disk=excluded.disk, latency=excluded.latency, services=excluded.services,
                     last_seen=excluded.last_seen""",
                  (rec["host"], layer, platform, env, source, val("cpu"), val("mem"), val("disk"),
                   val("latency"), json.dumps(services), ts))
        c.execute("INSERT INTO samples(host,ts,cpu,mem,disk,latency) VALUES(?,?,?,?,?,?)",
                  (rec["host"], ts, val("cpu"), val("mem"), val("disk"), val("latency")))
        c.commit()


def audit(actor: str, action: str, detail: str):
    with _lock:
        c = db()
        c.execute("INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)", (time.time(), actor, action, detail))
        c.commit()
