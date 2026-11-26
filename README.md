# CloudBridge AI

An intelligent hybrid cloud troubleshooting platform. It collects evidence from every layer of a hybrid infrastructure (network, compute, storage, virtualization, cloud, application), finds the root cause with a rules engine, picks the cheapest fix with Operations Research, and uses AI only to explain the evidence in plain words.

> Graduation project, class of 2027. The built-in demo runs on simulated data.

![Overview](docs/img/overview.png)

## Principles

- **Rules find, AI explains.** Findings come from deterministic rules with a visible rule ID, source and time. The AI layer receives only the evidence list and cannot add findings.
- **Decisions have a price.** Each incident lists the possible actions and ranks them by expected cost:
  `expected cost = action cost + downtime minutes x $60 + (1 - success probability) x failure penalty`
- **A human confirms.** Fixes run only after "Apply" and "Confirm". Every step is written to the activity log.

## Features

| Area | What it does |
|---|---|
| Overview | Health score, open incidents, MTTR, evidence counter, latency and CPU chart, health by layer, topology map |
| Incidents | Root cause with confidence, blast radius, evidence chain, AI explanation, cost table, runbook, apply and confirm |
| Infrastructure | Searchable, filterable, sortable asset table with per-host trend and detail panel |
| Connect data | Agent, HTTP API and CSV/JSON upload, with copyable commands |
| Backend | FastAPI, SQLite, API key auth, input validation, 5 automated tests |

| Incident | Infrastructure |
|---|---|
| ![Incident](docs/img/incident.png) | ![Infrastructure](docs/img/infrastructure.png) |

## Quick start

### Option 1: Docker

```bash
docker compose up --build
# open http://localhost:8000
```

Set your own key: `CB_API_KEY=my-secret docker compose up --build`

### Option 2: local

```bash
# 1. frontend
cd frontend && npm install && npm run build && cd ..

# 2. backend (serves the API and the built dashboard)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
CB_API_KEY=dev-key-change-me uvicorn app.main:app --port 8000
```

Open http://localhost:8000. With no data yet the dashboard is empty. Add `?demo=1` to the URL for the offline simulator.

For frontend development with hot reload: `cd frontend && npm run dev` (proxies `/api` to port 8000).

## Sending data

The dashboard reads what the API stores. Data arrives in one of three ways.

**1. Agent on each server**

```bash
pip install psutil requests
python agent/collector.py --api http://localhost:8000 --key dev-key-change-me \
  --host web-01 --layer Compute --service nginx
```

**2. HTTP request** (any tool, any language)

```bash
curl -X POST http://localhost:8000/api/ingest \
  -H "X-API-Key: dev-key-change-me" -H "Content-Type: application/json" \
  -d '{"host":"web-01","layer":"Application","cpu":42,"mem":58,"disk":47,"latency":130,"services":{"nginx":true}}'
```

**3. File upload** (CSV or JSON) from the Connect data page, or:

```bash
curl -X POST http://localhost:8000/api/ingest/upload -H "X-API-Key: dev-key-change-me" -F file=@data.csv
```

CSV columns: `host, layer, platform, env, cpu, mem, disk, latency, service_up, service`.

Fake fleet for testing: `python agent/simulate_fleet.py --incident` (an incident appears on `esx-prod-01` after 20 seconds).

## API

| Method and path | Purpose | Auth |
|---|---|---|
| `POST /api/ingest` | One record or `{"records": [...]}` | `X-API-Key` |
| `POST /api/ingest/upload` | CSV or JSON file, max 5 MB | `X-API-Key` |
| `GET /api/state` | Hosts, incidents, KPIs, series, activity | none |
| `POST /api/incidents/{id}/apply` | Record the chosen action | `X-API-Key` |
| `GET /api/health` | Liveness | none |

Interactive docs: http://localhost:8000/docs

## Diagnostic rules

| Rule | Condition | Root cause family |
|---|---|---|
| R-HB-06 | no heartbeat for 90 s | Host unreachable |
| R-SVC-05 | a monitored service reports down | Service down |
| R-MEM-02 | memory at or above 92% | Memory exhaustion |
| R-DSK-03 | disk at or above 90% | Disk nearly full |
| R-CPU-01 | CPU at or above 90% | CPU saturation |
| R-LAT-04 | latency at or above 400 ms | High latency |

The root cause is the matching rule with the highest weight. Confidence is `0.55 + 0.10 x (extra matching rules) + 0.30 x weight`, capped at 98%. Rules and costs live in `backend/app/engine.py`.

## Project layout

```
backend/    FastAPI app, rules engine, SQLite storage, tests
frontend/   React + TypeScript dashboard (Vite). Includes an offline simulator
agent/      collector.py (real metrics) and simulate_fleet.py (fake data)
docs/       market research and screenshots
```

Run the tests: `cd backend && python -m pytest -q`

## Limits and next steps

- "Apply" records the decision. Connecting an executor (Ansible, cloud APIs, vCenter) is the next step.
- The AI explanation is a template built from the evidence. An LLM can replace it as long as it receives only the evidence list.
- SQLite is for demos. Use PostgreSQL for production.
- Authentication on read endpoints and multi-tenant support are not implemented.

## Research

The design is based on a review of 50 companies in hybrid cloud AIOps and observability: [docs/market-research.md](docs/market-research.md).
