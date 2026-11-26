import os
import tempfile
import time

os.environ["CB_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["CB_API_KEY"] = "k"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.engine import expected_cost  # noqa: E402

client = TestClient(main.app)
H = {"X-API-Key": "k"}


def test_expected_cost_formula():
    assert expected_cost(5, 2, 0.7, 400) == 5 + 2 * 60 + 0.3 * 400


def test_auth_required():
    assert client.post("/api/ingest", json={"host": "a"}).status_code == 401


def test_ingest_detects_incident_and_resolves():
    r = client.post("/api/ingest", headers=H, json={"host": "esx-1", "layer": "Virtualization", "cpu": 95, "mem": 50, "disk": 40, "latency": 120})
    assert r.json()["accepted"] == 1
    s = client.get("/api/state").json()
    assert s["kpis"]["open_incidents"] == 1
    inc = s["incidents"][0]
    assert inc["root_cause"]["rule"] == "R-CPU-01"
    assert inc["recommended"] in [o["action"] for o in inc["options"]]
    done = client.post(f"/api/incidents/{inc['id']}/apply", headers=H, json={"action": inc["recommended"]})
    assert done.json()["status"] == "Resolved"
    assert client.get("/api/state").json()["kpis"]["open_incidents"] == 0


def test_validation_rejects_bad_values():
    r = client.post("/api/ingest", headers=H, json={"host": "x", "cpu": 900})
    assert r.status_code == 422


def test_csv_upload():
    csv_text = "host,layer,cpu,mem,disk,latency\nweb-1,Application,20,30,40,100\nweb-2,Application,30,95,40,100\n"
    r = client.post("/api/ingest/upload", headers=H, files={"file": ("d.csv", csv_text, "text/csv")})
    assert r.json()["accepted"] == 2
    hosts = {h["name"]: h for h in client.get("/api/state").json()["hosts"]}
    assert hosts["web-2"]["status"] != "healthy"
