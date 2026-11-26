"""CloudBridge AI API.

  POST /api/ingest            one record or {"records":[...]}   (header X-API-Key)
  POST /api/ingest/upload     JSON or CSV file                  (header X-API-Key)
  GET  /api/state             everything the dashboard needs
  POST /api/incidents/{id}/apply   {"action": "..."}  simulate or trigger a fix
  GET  /api/health
"""
from __future__ import annotations

import csv
import io
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db as store
from .engine import RULES, build_incident, evaluate_host

API_KEY = os.environ.get("CB_API_KEY", "dev-key-change-me")
LAYERS = ["Network", "Compute", "Storage", "Virtualization", "Cloud", "Application"]

app = FastAPI(title="CloudBridge AI", version="1.0.0")


def require_key(x_api_key: str | None = Header(default=None)):
    if x_api_key != API_KEY:
        raise HTTPException(401, "Missing or wrong X-API-Key")


class Record(BaseModel):
    host: str = Field(min_length=1, max_length=120)
    layer: str | None = None
    platform: str | None = None
    env: str | None = None
    cpu: float | None = Field(default=None, ge=0, le=100)
    mem: float | None = Field(default=None, ge=0, le=100)
    disk: float | None = Field(default=None, ge=0, le=100)
    latency: float | None = Field(default=None, ge=0, le=600000)
    services: dict[str, bool] | None = None
    ts: float | None = None


class Batch(BaseModel):
    records: list[Record] = Field(max_length=5000)


@app.get("/api/health")
def health():
    return {"ok": True, "time": time.time()}


@app.post("/api/ingest", dependencies=[Depends(require_key)])
def ingest(body: dict):
    raw = body.get("records") if "records" in body else [body]
    try:
        recs = Batch(records=raw).records
    except Exception as e:  # pydantic validation
        raise HTTPException(422, str(e)[:400])
    for r in recs:
        store.upsert_record(r.model_dump(exclude_none=True), "agent")
    return {"accepted": len(recs)}


def _parse_csv(text: str) -> list[dict]:
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        rec = {k.strip().lower(): (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k}
        if not rec.get("host"):
            continue
        if "service_up" in rec and rec.get("service_up") != "":
            rec["services"] = {rec.get("service", "app"): rec["service_up"].lower() in ("1", "true", "up", "yes")}
        for k in ("service_up", "service"):
            rec.pop(k, None)
        out.append(rec)
    return out


@app.post("/api/ingest/upload", dependencies=[Depends(require_key)])
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > 5_000_000:
        raise HTTPException(413, "File too large (max 5 MB)")
    text = data.decode("utf-8", errors="replace")
    try:
        raw = json.loads(text) if (file.filename or "").lower().endswith(".json") else _parse_csv(text)
        if isinstance(raw, dict):
            raw = raw.get("records", [raw])
        recs = Batch(records=raw).records
    except Exception as e:
        raise HTTPException(422, f"Could not read file: {str(e)[:300]}")
    for r in recs:
        store.upsert_record(r.model_dump(exclude_none=True), "upload")
    store.audit("api", "upload", f"{file.filename}: {len(recs)} records")
    return {"accepted": len(recs)}


def _host_view(row, now):
    d = dict(row)
    d["services"] = json.loads(d["services"] or "{}")
    d["last_seen"] = float(d["last_seen"])
    return d


def compute_state() -> dict:
    c = store.db()
    now = time.time()
    rows = c.execute("SELECT * FROM hosts ORDER BY name").fetchall()
    hosts, incidents, rules_hit, evidence_count = [], [], 0, 0
    for row in rows:
        h = _host_view(row, now)
        ev = evaluate_host(h, now)
        hist = c.execute("SELECT cpu FROM samples WHERE host=? ORDER BY ts DESC LIMIT 30", (h["name"],)).fetchall()
        h["cpu_hist"] = [r["cpu"] for r in reversed(hist)]
        existing = c.execute("SELECT * FROM incidents WHERE host=? AND status!='Resolved' ORDER BY detected_at DESC LIMIT 1",
                             (h["name"],)).fetchone()
        recent_fix = c.execute("SELECT 1 FROM incidents WHERE host=? AND status='Resolved' AND resolved_at>?",
                               (h["name"], now - 120)).fetchone()
        if ev and not recent_fix:
            inc = build_incident(h, ev)
            inc_id = existing["id"] if existing else f"INC-{int(now) % 100000:05d}-{secrets.token_hex(2)}"
            if not existing:
                c.execute("INSERT INTO incidents(id,host,status,detected_at,payload) VALUES(?,?,?,?,?)",
                          (inc_id, h["name"], "Open", now, "{}"))
                store.audit("engine", "detected", f"{inc_id}: {inc['title']}")
            detected = existing["detected_at"] if existing else now
            inc.update({"id": inc_id, "host": h["name"], "layer": h["layer"], "status": "Open", "detected_at": detected})
            incidents.append(inc)
            rules_hit += len(ev)
            evidence_count += len(ev)
            h["status"] = "critical" if inc["severity"] in ("critical", "high") else "warning"
        else:
            if existing and not ev:  # problem went away by itself
                c.execute("UPDATE incidents SET status='Resolved', resolved_at=? WHERE id=?", (now, existing["id"]))
            h["status"] = "healthy"
        hosts.append(h)
    c.commit()
    resolved = c.execute("SELECT detected_at, resolved_at FROM incidents WHERE status='Resolved' AND resolved_at IS NOT NULL").fetchall()
    mttr = round(sum(r["resolved_at"] - r["detected_at"] for r in resolved) / len(resolved) / 60, 1) if resolved else 0
    layers = []
    for L in LAYERS:
        hs = [h for h in hosts if h["layer"] == L]
        if not hs:
            layers.append({"name": L, "health": None, "hosts": 0})
            continue
        bad = sum(1 for h in hs if h["status"] == "critical") + 0.5 * sum(1 for h in hs if h["status"] == "warning")
        layers.append({"name": L, "health": round(100 * (1 - bad / len(hs))), "hosts": len(hs)})
    scored = [l["health"] for l in layers if l["health"] is not None]
    health = round(sum(scored) / len(scored)) if scored else 100
    ser = c.execute("SELECT CAST(ts/60 AS INT)*60 AS t, AVG(latency) AS lat, AVG(cpu) AS cpu FROM samples "
                    "GROUP BY t ORDER BY t DESC LIMIT 60").fetchall()[::-1]
    audit = c.execute("SELECT ts,actor,action,detail FROM audit ORDER BY id DESC LIMIT 30").fetchall()
    return {
        "mode": "live", "now": now, "hosts": hosts, "incidents": incidents, "layers": layers,
        "kpis": {"health": health, "open_incidents": len(incidents), "mttr_min": mttr,
                 "evidence": evidence_count, "rules": len(RULES)},
        "series": {"t": [r["t"] for r in ser], "latency": [r["lat"] for r in ser], "cpu": [r["cpu"] for r in ser]},
        "audit": [dict(a) for a in audit],
    }


@app.get("/api/state")
def state():
    return compute_state()


class Apply(BaseModel):
    action: str


@app.post("/api/incidents/{inc_id}/apply", dependencies=[Depends(require_key)])
def apply_fix(inc_id: str, body: Apply):
    c = store.db()
    row = c.execute("SELECT * FROM incidents WHERE id=?", (inc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Unknown incident")
    if row["status"] == "Resolved":
        return {"status": "Resolved"}
    # This demo records the decision. Wire a real executor (Ansible, SSM, vCenter API) here.
    c.execute("UPDATE incidents SET status='Resolved', resolved_at=?, applied_action=? WHERE id=?",
              (time.time(), body.action, inc_id))
    c.commit()
    store.audit("operator", "applied", f"{inc_id}: {body.action}")
    return {"status": "Resolved", "action": body.action}


FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = FRONTEND / path
        return FileResponse(f if f.is_file() else FRONTEND / "index.html")
