// TypeScript mirror of backend/app/engine.py (used by the offline demo).
import type { Evidence, Host, Incident, Option } from './types';

export const DOWNTIME_COST_PER_MIN = 60;
export const STALE_AFTER_SEC = 90;
type Kind = 'cpu' | 'memory' | 'disk' | 'service' | 'latency' | 'unreachable';
export const RULES: Record<string, { kind: Kind; label: string; weight: number; sev: Incident['severity'] }> = {
  'R-HB-06': { kind: 'unreachable', label: 'Host unreachable', weight: 0.9, sev: 'critical' },
  'R-SVC-05': { kind: 'service', label: 'Service down', weight: 0.8, sev: 'critical' },
  'R-MEM-02': { kind: 'memory', label: 'Memory exhaustion', weight: 0.6, sev: 'high' },
  'R-DSK-03': { kind: 'disk', label: 'Disk nearly full', weight: 0.6, sev: 'high' },
  'R-CPU-01': { kind: 'cpu', label: 'CPU saturation', weight: 0.5, sev: 'high' },
  'R-LAT-04': { kind: 'latency', label: 'High latency', weight: 0.3, sev: 'medium' },
};
const T: Record<Kind, [string, number, number, number, number][]> = {
  cpu: [['Restart service', 5, 2, 0.7, 400], ['Scale out (add node)', 40, 0, 0.9, 200], ['Roll back last release', 15, 4, 0.8, 300], ['Do nothing', 0, 30, 0.1, 800]],
  memory: [['Restart service', 5, 2, 0.75, 400], ['Increase memory limit', 20, 3, 0.85, 250], ['Fail over to standby', 60, 1, 0.92, 300], ['Do nothing', 0, 25, 0.1, 800]],
  disk: [['Clean logs and temp files', 2, 0, 0.6, 300], ['Expand volume', 25, 1, 0.95, 200], ['Move data to cold storage', 30, 0, 0.8, 250], ['Do nothing', 0, 40, 0.05, 900]],
  service: [['Restart service', 5, 2, 0.8, 400], ['Roll back last release', 15, 4, 0.85, 300], ['Fail over to standby', 60, 1, 0.92, 300], ['Do nothing', 0, 45, 0, 900]],
  latency: [['Scale out (add node)', 40, 0, 0.85, 200], ['Restart service', 5, 2, 0.6, 300], ['Re-route traffic', 10, 1, 0.75, 250], ['Do nothing', 0, 20, 0.15, 600]],
  unreachable: [['Power-cycle host', 10, 5, 0.6, 500], ['Fail over to standby', 60, 1, 0.92, 300], ['Escalate to on-call engineer', 30, 12, 0.9, 200], ['Do nothing', 0, 60, 0, 1200]],
};
const RUNBOOK: Record<Kind, string[]> = {
  cpu: ['Check top processes on the host', 'Compare with last deploy time', 'Apply the recommended action', 'Watch CPU for 10 minutes'],
  memory: ['Check memory by process', 'Look for a leak after the last release', 'Apply the recommended action', 'Confirm memory drops below 80%'],
  disk: ['Find the biggest folders', 'Check log rotation', 'Apply the recommended action', 'Confirm free space above 20%'],
  service: ['Read the service log', 'Check dependencies it needs', 'Apply the recommended action', 'Confirm the health check is green'],
  latency: ['Check CPU and network on the path', 'Compare with the baseline', 'Apply the recommended action', 'Confirm p95 latency is back to normal'],
  unreachable: ['Ping the host and its gateway', 'Check the hypervisor or cloud console', 'Apply the recommended action', 'Confirm heartbeats are back'],
};
const NEIGH: Record<string, string[]> = {
  Virtualization: ['Compute', 'Application'], Compute: ['Application'], Storage: ['Virtualization', 'Application'],
  Network: ['Cloud', 'Application'], Cloud: ['Application'], Application: [],
};
export const expectedCost = (c: number, d: number, s: number, p: number) => Math.round((c + d * DOWNTIME_COST_PER_MIN + (1 - s) * p) * 100) / 100;

export function evaluateHost(h: Host, now: number): Evidence[] {
  const ev: Evidence[] = [];
  const hit = (rule: string, message: string, value: number | string) => ev.push({ rule, label: RULES[rule].label, message, value, source: h.source, at: now });
  if (now - h.last_seen > STALE_AFTER_SEC) hit('R-HB-06', `No heartbeat for ${Math.round(now - h.last_seen)}s (limit ${STALE_AFTER_SEC}s)`, Math.round(now - h.last_seen));
  for (const [s, up] of Object.entries(h.services)) if (!up) hit('R-SVC-05', `Service '${s}' reported down`, s);
  if (h.mem >= 92) hit('R-MEM-02', `Memory ${h.mem.toFixed(0)}% (limit 92%)`, h.mem);
  if (h.disk >= 90) hit('R-DSK-03', `Disk ${h.disk.toFixed(0)}% full (limit 90%)`, h.disk);
  if (h.cpu >= 90) hit('R-CPU-01', `CPU ${h.cpu.toFixed(0)}% (limit 90%)`, h.cpu);
  if (h.latency >= 400) hit('R-LAT-04', `Latency ${h.latency.toFixed(0)} ms (limit 400 ms)`, h.latency);
  return ev;
}

export function buildIncident(h: Host, ev: Evidence[]): Omit<Incident, 'id' | 'status' | 'detected_at' | 'host' | 'layer'> {
  const top = ev.reduce((a, b) => (RULES[b.rule].weight > RULES[a.rule].weight ? b : a));
  const r = RULES[top.rule];
  const confidence = Math.min(0.98, 0.55 + 0.1 * (ev.length - 1) + r.weight * 0.3);
  const options: Option[] = T[r.kind].map(([action, cost, downtime, success, penalty]) => ({ action, cost, downtime, success, penalty, expected: expectedCost(cost, downtime, success, penalty) }));
  const best = options.reduce((a, b) => (b.expected < a.expected ? b : a)).action;
  const order = ['low', 'medium', 'high', 'critical'];
  const severity = ev.map((e) => RULES[e.rule].sev).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));
  return {
    title: `${r.label} on ${h.name}`, severity, kind: r.kind,
    root_cause: { label: r.label, rule: top.rule, confidence: Math.round(confidence * 100) / 100 },
    evidence: ev, blast_radius: [h.layer, ...(NEIGH[h.layer] || [])], options, recommended: best, runbook: RUNBOOK[r.kind],
    explanation: `${h.name} (${h.layer} layer) has a problem: ${r.label.toLowerCase()}. What the system measured: ${ev.map((e) => e.message).join('; ')}. Cheapest option by expected cost: ${best}.`,
  };
}
