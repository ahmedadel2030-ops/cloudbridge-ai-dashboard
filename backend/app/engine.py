"""Diagnostic engine: rules over evidence, then an Operations Research decision.

Design rule of the whole project: the RULES find the problem and collect the
evidence. The AI layer may only EXPLAIN that evidence in simple words. It never
creates findings of its own.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

DOWNTIME_COST_PER_MIN = 60.0  # USD per minute of downtime (editable)
STALE_AFTER_SEC = 90


@dataclass(frozen=True)
class Rule:
    id: str
    kind: str          # root-cause family
    label: str
    weight: float      # how strongly this rule points to the root cause
    severity: str


RULES = {
    "R-HB-06": Rule("R-HB-06", "unreachable", "Host unreachable", 0.90, "critical"),
    "R-SVC-05": Rule("R-SVC-05", "service", "Service down", 0.80, "critical"),
    "R-MEM-02": Rule("R-MEM-02", "memory", "Memory exhaustion", 0.60, "high"),
    "R-DSK-03": Rule("R-DSK-03", "disk", "Disk nearly full", 0.60, "high"),
    "R-CPU-01": Rule("R-CPU-01", "cpu", "CPU saturation", 0.50, "high"),
    "R-LAT-04": Rule("R-LAT-04", "latency", "High latency", 0.30, "medium"),
}

# action, cost USD, downtime minutes, success probability, penalty USD if it fails
OPTIONS = {
    "cpu": [
        ("Restart service", 5, 2, 0.70, 400),
        ("Scale out (add node)", 40, 0, 0.90, 200),
        ("Roll back last release", 15, 4, 0.80, 300),
        ("Do nothing", 0, 30, 0.10, 800),
    ],
    "memory": [
        ("Restart service", 5, 2, 0.75, 400),
        ("Increase memory limit", 20, 3, 0.85, 250),
        ("Fail over to standby", 60, 1, 0.92, 300),
        ("Do nothing", 0, 25, 0.10, 800),
    ],
    "disk": [
        ("Clean logs and temp files", 2, 0, 0.60, 300),
        ("Expand volume", 25, 1, 0.95, 200),
        ("Move data to cold storage", 30, 0, 0.80, 250),
        ("Do nothing", 0, 40, 0.05, 900),
    ],
    "service": [
        ("Restart service", 5, 2, 0.80, 400),
        ("Roll back last release", 15, 4, 0.85, 300),
        ("Fail over to standby", 60, 1, 0.92, 300),
        ("Do nothing", 0, 45, 0.00, 900),
    ],
    "latency": [
        ("Scale out (add node)", 40, 0, 0.85, 200),
        ("Restart service", 5, 2, 0.60, 300),
        ("Re-route traffic", 10, 1, 0.75, 250),
        ("Do nothing", 0, 20, 0.15, 600),
    ],
    "unreachable": [
        ("Power-cycle host", 10, 5, 0.60, 500),
        ("Fail over to standby", 60, 1, 0.92, 300),
        ("Escalate to on-call engineer", 30, 12, 0.90, 200),
        ("Do nothing", 0, 60, 0.00, 1200),
    ],
}

RUNBOOK = {
    "cpu": ["Check top processes on the host", "Compare with last deploy time", "Apply the recommended action", "Watch CPU for 10 minutes"],
    "memory": ["Check memory by process", "Look for a leak after the last release", "Apply the recommended action", "Confirm memory drops below 80%"],
    "disk": ["Find the biggest folders", "Check log rotation", "Apply the recommended action", "Confirm free space above 20%"],
    "service": ["Read the service log", "Check dependencies it needs", "Apply the recommended action", "Confirm the health check is green"],
    "latency": ["Check CPU and network on the path", "Compare with the baseline", "Apply the recommended action", "Confirm p95 latency is back to normal"],
    "unreachable": ["Ping the host and its gateway", "Check the hypervisor or cloud console", "Apply the recommended action", "Confirm heartbeats are back"],
}

LAYER_NEIGHBOURS = {
    "Virtualization": ["Compute", "Application"],
    "Compute": ["Application"],
    "Storage": ["Virtualization", "Application"],
    "Network": ["Cloud", "Application"],
    "Cloud": ["Application"],
    "Application": [],
}


def expected_cost(cost: float, downtime: float, success: float, penalty: float) -> float:
    """expected = action cost + downtime x $/min + (1 - success) x penalty."""
    return round(cost + downtime * DOWNTIME_COST_PER_MIN + (1 - success) * penalty, 2)


def evaluate_host(host: dict, now: float | None = None) -> list[dict]:
    """Return the evidence items (rule hits) for one host."""
    now = now or time.time()
    ev: list[dict] = []

    def hit(rule_id: str, msg: str, value):
        r = RULES[rule_id]
        ev.append({"rule": rule_id, "label": r.label, "message": msg, "value": value,
                   "source": host.get("source", "agent"), "at": host.get("last_seen", now)})

    if now - host.get("last_seen", now) > STALE_AFTER_SEC:
        hit("R-HB-06", f"No heartbeat for {int(now - host['last_seen'])}s (limit {STALE_AFTER_SEC}s)", int(now - host["last_seen"]))
    for svc, up in (host.get("services") or {}).items():
        if not up:
            hit("R-SVC-05", f"Service '{svc}' reported down", svc)
    if host.get("mem", 0) >= 92:
        hit("R-MEM-02", f"Memory {host['mem']:.0f}% (limit 92%)", host["mem"])
    if host.get("disk", 0) >= 90:
        hit("R-DSK-03", f"Disk {host['disk']:.0f}% full (limit 90%)", host["disk"])
    if host.get("cpu", 0) >= 90:
        hit("R-CPU-01", f"CPU {host['cpu']:.0f}% (limit 90%)", host["cpu"])
    if host.get("latency", 0) >= 400:
        hit("R-LAT-04", f"Latency {host['latency']:.0f} ms (limit 400 ms)", host["latency"])
    return ev


def build_incident(host: dict, evidence: list[dict]) -> dict:
    """Pick the root cause (highest-weight rule), score confidence, price the options."""
    top = max(evidence, key=lambda e: RULES[e["rule"]].weight)
    rule = RULES[top["rule"]]
    confidence = min(0.98, 0.55 + 0.10 * (len(evidence) - 1) + rule.weight * 0.30)
    opts = []
    for action, cost, down, succ, pen in OPTIONS[rule.kind]:
        opts.append({"action": action, "cost": cost, "downtime": down, "success": succ,
                     "penalty": pen, "expected": expected_cost(cost, down, succ, pen)})
    best = min(opts, key=lambda o: o["expected"])["action"]
    sev = max((RULES[e["rule"]].severity for e in evidence),
              key=lambda s: ["low", "medium", "high", "critical"].index(s))
    blast = [host["layer"]] + LAYER_NEIGHBOURS.get(host["layer"], [])
    return {
        "title": f"{rule.label} on {host['name']}",
        "severity": sev,
        "kind": rule.kind,
        "root_cause": {"label": rule.label, "rule": rule.id, "confidence": round(confidence, 2)},
        "evidence": evidence,
        "blast_radius": blast,
        "options": opts,
        "recommended": best,
        "runbook": RUNBOOK[rule.kind],
        "explanation": explain(host, rule, evidence, best),
    }


def explain(host: dict, rule: Rule, evidence: list[dict], best: str) -> str:
    """Plain-words explanation built ONLY from the evidence list.

    To use a real LLM, send it exactly `evidence` and ask it to explain; never let
    it add facts. This template keeps the demo free and deterministic.
    """
    facts = "; ".join(e["message"] for e in evidence)
    return (f"{host['name']} ({host['layer']} layer) has a problem: {rule.label.lower()}. "
            f"What the system measured: {facts}. "
            f"Cheapest option by expected cost: {best}.")
