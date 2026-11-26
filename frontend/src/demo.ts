// Offline demo data source: simulated fleet, same shape as the live API.
import { buildIncident, evaluateHost } from './engine';
import type { AuditEntry, Host, Incident, Source, State } from './types';
import { LAYERS } from './types';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a = 1, b = 99) => Math.max(a, Math.min(b, v));
const FLEET: [string, string, string, string][] = [
  ['esx-prod-01', 'Virtualization', 'VMware ESXi 8', 'DC1 (on-prem)'], ['esx-prod-02', 'Virtualization', 'VMware ESXi 8', 'DC1 (on-prem)'],
  ['san-store-01', 'Storage', 'Storage array', 'DC1 (on-prem)'], ['ipsec-gw-eu', 'Network', 'VPN gateway', 'DC1 to AWS'],
  ['api-gateway-aws', 'Cloud', 'AWS EC2', 'eu-central-1'], ['rds-orders', 'Cloud', 'AWS RDS', 'eu-central-1'],
  ['app-vmss-az', 'Application', 'Azure VMSS', 'West Europe'], ['k8s-workers', 'Compute', 'Kubernetes', 'Hybrid'],
];

export function createDemoSource(): Source {
  const now = () => Date.now() / 1000;
  const hosts = new Map<string, Host>();
  const base = new Map<string, { cpu: number; mem: number; disk: number; lat: number }>();
  const fault = new Map<string, 'cpu' | 'disk' | 'service' | 'unreachable'>();
  const lastDown = new Map<string, number>();
  const open = new Map<string, Incident>();
  const resolved: Incident[] = [];
  const audit: AuditEntry[] = [];
  const series = { t: [] as number[], latency: [] as number[], cpu: [] as number[] };
  let seq = 2040;
  const subs = new Set<(s: State) => void>();
  const log = (actor: string, action: string, detail: string) => { audit.unshift({ ts: now(), actor, action, detail }); audit.length = Math.min(audit.length, 40); };

  const put = (name: string, layer: string, platform: string, env: string, source = 'agent') => {
    base.set(name, { cpu: rnd(32, 62), mem: rnd(42, 70), disk: rnd(35, 62), lat: rnd(70, 170) });
    const b = base.get(name)!;
    hosts.set(name, { name, layer, platform, env, source, cpu: b.cpu, mem: b.mem, disk: b.disk, latency: b.lat, services: { main: true }, last_seen: now(), status: 'healthy', cpu_hist: Array.from({ length: 30 }, () => b.cpu + rnd(-6, 6)) });
  };
  FLEET.forEach((f) => put(...f));
  for (let i = 60; i > 0; i--) { const r = Math.max(0, 30 - i) / 30; series.t.push(now() - i * 2); series.latency.push(rnd(110, 150) + r * 75); series.cpu.push(rnd(44, 52) + r * 7); }
  fault.set('esx-prod-01', 'cpu');
  { const h = hosts.get('esx-prod-01')!; h.cpu = 96; h.mem = 85; h.latency = 540; h.cpu_hist = Array.from({ length: 30 }, (_, i) => 55 + (i / 29) * 40 + rnd(-3, 3)); }

  function step() {
    const t = now();
    for (const h of hosts.values()) {
      const b = base.get(h.name)!; const f = fault.get(h.name);
      const target = (v: number, x: number) => v + (x - v) * 0.3 + rnd(-2.5, 2.5);
      h.cpu = clamp(target(h.cpu, f === 'cpu' ? 97 : b.cpu));
      h.mem = clamp(target(h.mem, f === 'cpu' ? 85 : b.mem));
      h.disk = clamp(target(h.disk, f === 'disk' ? 94 : b.disk) , 1, 99.5);
      h.latency = Math.max(20, target(h.latency, f === 'cpu' ? 520 : f === 'service' ? 700 : b.lat));
      h.services = { main: f !== 'service' };
      if (f !== 'unreachable') h.last_seen = t; else if (!lastDown.has(h.name)) { lastDown.set(h.name, t); h.last_seen = t - 100; }
      h.cpu_hist = [...h.cpu_hist.slice(-29), h.cpu];
    }
    const arr = [...hosts.values()];
    series.t.push(t); series.latency.push(arr.reduce((a, h) => a + h.latency, 0) / arr.length); series.cpu.push(arr.reduce((a, h) => a + h.cpu, 0) / arr.length);
    ['t', 'latency', 'cpu'].forEach((k) => { const a = (series as any)[k]; if (a.length > 60) a.shift(); });
    // detect
    for (const h of arr) {
      const ev = evaluateHost(h, t);
      const inc = open.get(h.name);
      if (ev.length && !inc && !fault.has(h.name + '#fixed')) {
        const built = buildIncident(h, ev);
        const i: Incident = { id: `INC-${++seq}`, status: 'Open', detected_at: t, host: h.name, layer: h.layer, ...built };
        if (!series.t.length || seq === 2041) i.detected_at = series.t[Math.max(0, series.t.length - 31)]; open.set(h.name, i); log('engine', 'detected', `${i.id}: ${i.title}`);
      } else if (ev.length && inc) {
        Object.assign(inc, buildIncident(h, ev));
      }
      h.status = !ev.length ? 'healthy' : ev.length === 1 && ev[0].rule === 'R-LAT-04' ? 'warning' : 'critical';
    }
  }
  const snapshot = (): State => {
    const t = now(); const arr = [...hosts.values()].map((h) => ({ ...h, services: { ...h.services }, cpu_hist: [...h.cpu_hist] }));
    const layers = LAYERS.map((L) => { const hs = arr.filter((h) => h.layer === L); if (!hs.length) return { name: L, health: null, hosts: 0 }; const bad = hs.filter((h) => h.status === 'critical').length + 0.5 * hs.filter((h) => h.status === 'warning').length; return { name: L, health: Math.round(100 * (1 - bad / hs.length)), hosts: hs.length }; });
    const sc = layers.filter((l) => l.health !== null).map((l) => l.health as number);
    const incs = [...open.values()].sort((a, b) => b.detected_at - a.detected_at);
    const mttr = resolved.length ? resolved.reduce((a, r) => a + ((r.resolved_at || t) - r.detected_at), 0) / resolved.length / 60 : 0;
    return { mode: 'demo', now: t, hosts: arr, incidents: incs, resolved: [...resolved], layers, kpis: { health: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : 100, open_incidents: incs.length, mttr_min: Math.round(mttr * 10) / 10, evidence: incs.reduce((a, i) => a + i.evidence.length, 0) + resolved.length * 3, rules: 6 }, series: { t: [...series.t], latency: [...series.latency], cpu: [...series.cpu] }, audit: [...audit] };
  };
  const emit = () => { const s = snapshot(); subs.forEach((cb) => cb(s)); };
  step();
  const timer = typeof window !== 'undefined' ? setInterval(() => { step(); emit(); }, 2000) : undefined;
  void timer;

  return {
    mode: 'demo', apiBase: 'http://localhost:8000',
    subscribe(cb) { subs.add(cb); cb(snapshot()); return () => subs.delete(cb); },
    async apply(id, action) {
      const inc = [...open.values()].find((i) => i.id === id); if (!inc) return;
      inc.status = 'Resolved'; inc.resolved_at = now(); inc.applied_action = action;
      resolved.unshift(inc); open.delete(inc.host); fault.delete(inc.host);
      const h = hosts.get(inc.host)!; const b = base.get(h.name)!; h.last_seen = now(); lastDown.delete(h.name);
      h.cpu = b.cpu; h.mem = b.mem; h.disk = b.disk; h.latency = b.lat; h.services = { main: true };
      log('operator', 'applied', `${inc.id}: ${action}`); log('engine', 'resolved', `${inc.id}: ${inc.host} healthy again`); emit();
    },
    async ingestText(name, text) {
      try {
        let rows: any[];
        if (name.toLowerCase().endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
          const j = JSON.parse(text); rows = Array.isArray(j) ? j : j.records || [j];
        } else {
          const lines = text.trim().split(/\r?\n/); const head = lines.shift()!.split(',').map((x) => x.trim().toLowerCase());
          rows = lines.filter(Boolean).map((l) => { const c = l.split(','); const o: any = {}; head.forEach((k, i) => (o[k] = (c[i] || '').trim())); if ('service_up' in o && o.service_up !== '') o.services = { [o.service || 'app']: ['1', 'true', 'up', 'yes'].includes(String(o.service_up).toLowerCase()) }; return o; });
        }
        let n = 0;
        for (const r of rows) {
          if (!r.host) continue;
          const num = (k: string, d: number) => (r[k] === undefined || r[k] === '' ? d : Number(r[k]));
          const cpu = num('cpu', 0), mem = num('mem', 0), disk = num('disk', 0), lat = num('latency', 0);
          if ([cpu, mem, disk].some((v) => Number.isNaN(v) || v < 0 || v > 100)) return { accepted: n, error: `Row for "${r.host}": cpu, mem and disk must be numbers from 0 to 100.` };
          if (!hosts.has(r.host)) put(r.host, r.layer || 'Compute', r.platform || 'Linux', r.env || 'prod', 'upload');
          const h = hosts.get(r.host)!; Object.assign(h, { cpu, mem, disk, latency: lat, last_seen: now(), source: 'upload' }); if (r.services) h.services = r.services;
          base.set(h.name, { cpu: Math.min(cpu, 60), mem: Math.min(mem, 65), disk: Math.min(disk, 60), lat: Math.min(lat || 100, 160) });
          if (cpu >= 90 || mem >= 92 || disk >= 90 || lat >= 400) fault.set(h.name, cpu >= 90 ? 'cpu' : disk >= 90 ? 'disk' : 'cpu');
          n++;
        }
        log('upload', 'ingest', `${name}: ${n} records`); step(); emit(); return { accepted: n };
      } catch (e: any) { return { accepted: 0, error: 'Could not read the data: ' + e.message }; }
    },
    inject(kind) {
      const pick = kind === 'disk' ? 'san-store-01' : kind === 'service' ? 'app-vmss-az' : 'ipsec-gw-eu';
      if (open.has(pick)) return; fault.set(pick, kind === 'disk' ? 'disk' : kind === 'service' ? 'service' : 'unreachable'); log('demo', 'injected', `${kind} fault on ${pick}`); step(); emit();
    },
  };
                                                                                                        }
