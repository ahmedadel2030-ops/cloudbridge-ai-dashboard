import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Host, Incident, Source, State } from './types';
import { LAYERS } from './types';

const COLOR = { healthy: '#34d399', warning: '#fbbf24', critical: '#f87171', critical_sev: '#f87171', high: '#fb923c', medium: '#fbbf24', low: '#38bdf8' } as Record<string, string>;
const ago = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const usd = (n: number) => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/* ---------- small visual pieces ---------- */
function Spark({ data, color, w = 84, h = 24 }: { data: number[]; color: string; w?: number; h?: number }) {
  if (data.length < 2) return <svg width={w} height={h} />;
  const mx = Math.max(...data), mn = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)}`).join(' ');
  return <svg width={w} height={h} className="cb-spark" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}
function Ring({ v }: { v: number }) {
  const c = v >= 90 ? COLOR.healthy : v >= 70 ? COLOR.warning : COLOR.critical; const r = 34, L = 2 * Math.PI * r;
  return <svg viewBox="0 0 90 90" className="cb-ring" role="img" aria-label={`Health ${v} percent`}>
    <circle cx="45" cy="45" r={r} fill="none" stroke="#1c2740" strokeWidth="9" />
    <circle cx="45" cy="45" r={r} fill="none" stroke={c} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * L} ${L}`} transform="rotate(-90 45 45)" style={{ transition: 'stroke-dasharray .6s' }} />
    <text x="45" y="50" textAnchor="middle" fill="#e6edf7" fontSize="21" fontWeight="700">{v}</text>
  </svg>;
}
function Badge({ sev }: { sev: string }) { return <span className="cb-badge" style={{ color: COLOR[sev], borderColor: COLOR[sev] + '66', background: COLOR[sev] + '1a' }}>{sev}</span>; }
function Dot({ s }: { s: string }) { return <span className="cb-dot" style={{ background: COLOR[s] }} />; }
function Card({ title, right, children, cls = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; cls?: string }) {
  return <section className={`cb-card ${cls}`}>{title && <header><h3>{title}</h3><div>{right}</div></header>}{children}</section>;
}

function LineChart({ s, markAt }: { s: State['series']; markAt?: number }) {
  const W = 760, H = 230, p = 34, n = s.t.length;
  if (n < 2) return null;
  const mxL = Math.max(...s.latency, 200) * 1.1, mxC = 100;
  const X = (i: number) => p + (i / (n - 1)) * (W - p - 12);
  const path = (d: number[], mx: number) => d.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(H - 26 - (v / mx) * (H - 26 - 14)).toFixed(1)}`).join('');
  const area = path(s.latency, mxL) + `L${X(n - 1)},${H - 26}L${X(0)},${H - 26}Z`;
  const mi = markAt ? s.t.findIndex((t) => t >= markAt) : -1;
  return <svg viewBox={`0 0 ${W} ${H}`} className="cb-chart" role="img" aria-label="Average latency and CPU over time">
    <defs><linearGradient id="gl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#38bdf8" stopOpacity=".32" /><stop offset="1" stopColor="#38bdf8" stopOpacity="0" /></linearGradient></defs>
    {[0, 1, 2, 3].map((i) => { const y = 14 + (i * (H - 40)) / 3; return <g key={i}><line x1={p} x2={W - 12} y1={y} y2={y} stroke="#1c2740" /><text x={p - 6} y={y + 4} fill="#6f7f9f" fontSize="10" textAnchor="end">{Math.round(mxL * (1 - i / 3))}</text></g>; })}
    <path d={area} fill="url(#gl)" /><path d={path(s.latency, mxL)} fill="none" stroke="#38bdf8" strokeWidth="2" />
    <path d={path(s.cpu, mxC)} fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeDasharray="5 3" />
    {mi > 0 && <g><line x1={X(mi)} x2={X(mi)} y1={8} y2={H - 26} stroke="#f87171" strokeDasharray="3 3" /><text x={X(mi) + 6} y={20} fill="#f87171" fontSize="11">Incident detected</text></g>}
    <text x={p} y={H - 8} fill="#6f7f9f" fontSize="10">{hhmm(s.t[0])}</text><text x={W - 12} y={H - 8} fill="#6f7f9f" fontSize="10" textAnchor="end">{hhmm(s.t[n - 1])}</text>
  </svg>;
}

/* ---------- topology ---------- */
const COLS = ['Storage', 'Virtualization', 'Compute', 'Network', 'Cloud', 'Application'];
const EDGES: [string, string][] = [['Storage', 'Virtualization'], ['Virtualization', 'Compute'], ['Compute', 'Application'], ['Network', 'Cloud'], ['Cloud', 'Application'], ['Virtualization', 'Application']];
function Topology({ hosts, onPick, sel }: { hosts: Host[]; onPick: (h: Host) => void; sel?: string }) {
  const W = 760, colW = (W - 40) / COLS.length;
  const pos = new Map<string, { x: number; y: number }>(); let maxN = 1;
  COLS.forEach((L, ci) => { const hs = hosts.filter((h) => h.layer === L); maxN = Math.max(maxN, hs.length); hs.forEach((h, i) => pos.set(h.name, { x: 20 + colW * ci + colW / 2, y: 58 + i * 52 })); });
  const H = 58 + maxN * 52 + 10;
  const layerHosts = (L: string) => hosts.filter((h) => h.layer === L);
  return <svg viewBox={`0 0 ${W} ${H}`} className="cb-topo" role="img" aria-label="Topology of monitored hosts by layer">
    {COLS.map((L, ci) => <text key={L} x={20 + colW * ci + colW / 2} y={20} textAnchor="middle" fill="#6f7f9f" fontSize="11" letterSpacing=".06em">{L.toUpperCase()}</text>)}
    {EDGES.map(([a, b]) => layerHosts(a).flatMap((ha) => layerHosts(b).map((hb) => { const pa = pos.get(ha.name)!, pb = pos.get(hb.name)!; const bad = ha.status === 'critical' && hb.status !== 'healthy' || hb.status === 'critical' && ha.status !== 'healthy'; return <line key={ha.name + hb.name} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={bad ? '#f8717199' : '#26344f'} strokeWidth={bad ? 1.6 : 1} />; })))}
    {hosts.map((h) => { const p = pos.get(h.name); if (!p) return null; return <g key={h.name} onClick={() => onPick(h)} style={{ cursor: 'pointer' }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(h)} aria-label={`${h.name} ${h.status}`}>
      {h.status !== 'healthy' && <circle cx={p.x} cy={p.y} r="19" fill="none" stroke={COLOR[h.status]} strokeOpacity=".4" className="cb-pulse" />}
      <circle cx={p.x} cy={p.y} r="13" fill="#0f172a" stroke={COLOR[h.status]} strokeWidth={sel === h.name ? 3.5 : 2} />
      <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="10" fill="#e6edf7">{Math.round(h.cpu)}</text>
      <text x={p.x} y={p.y + 29} textAnchor="middle" fontSize="9.5" fill="#9fb0cc">{h.name.length > 15 ? h.name.slice(0, 14) + '…' : h.name}</text></g>; })}
  </svg>;
}

/* ---------- pages ---------- */
function Overview({ st, go }: { st: State; go: (p: string, id?: string) => void }) {
  const k = st.kpis; const first = st.incidents[st.incidents.length - 1];
  const cpuAvg = st.series.cpu.slice(-30);
  const kp: [string, string, React.ReactNode, string][] = [
    ['Open incidents', String(k.open_incidents), <Spark data={st.series.latency.slice(-30)} color={k.open_incidents ? COLOR.critical : COLOR.healthy} />, k.open_incidents ? 'needs attention' : 'all clear'],
    ['MTTR', k.mttr_min ? `${k.mttr_min} min` : '—', <Spark data={cpuAvg} color="#a78bfa" />, k.mttr_min ? 'mean time to resolve' : 'no fixes yet'],
    ['Evidence items', String(k.evidence), <Spark data={st.series.latency.slice(-30)} color="#38bdf8" />, 'collected by rules'],
    ['Rules matched', String(k.open_incidents ? st.incidents.reduce((a, i) => a + i.evidence.length, 0) : 0), <Spark data={cpuAvg} color="#fbbf24" />, `of ${k.rules} active rules`],
  ];
  return <>
    <div className="cb-kpis">
      <Card cls="cb-kpi cb-kpi-health"><div className="cb-kl">Platform health</div><div className="cb-krow"><Ring v={k.health} /><div className="cb-ksub">{k.open_incidents === 0 && k.health >= 95 ? 'Healthy' : k.health >= 70 ? 'Degraded' : 'Critical'}<small>{st.hosts.length} hosts, {LAYERS.length} layers</small></div></div></Card>
      {kp.map(([l, v, sp, sub]) => <Card key={l} cls="cb-kpi"><div className="cb-kl">{l}</div><div className="cb-krow"><div className="cb-kv">{v}</div>{sp}</div><div className="cb-ks">{sub}</div></Card>)}
    </div>
    <div className="cb-grid2">
      <Card title="Latency and CPU, all hosts" right={<span className="cb-legend"><i style={{ background: '#38bdf8' }} />latency ms<i style={{ background: '#a78bfa' }} />CPU %</span>}><LineChart s={st.series} markAt={first?.detected_at} /></Card>
      <Card title="Health by layer">
        {st.layers.map((l) => <div className="cb-layer" key={l.name}><span>{l.name}</span><div className="cb-bar"><div style={{ width: `${l.health ?? 0}%`, background: l.health === null ? '#26344f' : l.health >= 90 ? COLOR.healthy : l.health >= 70 ? COLOR.warning : COLOR.critical }} /></div><b>{l.health === null ? 'n/a' : l.health + '%'}</b></div>)}
      </Card>
    </div>
    <div className="cb-grid2 cb-g2b">
      <Card title="Active incidents" right={<button className="cb-link" onClick={() => go('incidents')}>View all</button>}>
        {st.incidents.length === 0 && <p className="cb-empty">No open incidents. Everything the rules watch is inside its limits.</p>}
        {st.incidents.map((i) => <button key={i.id} className="cb-row" onClick={() => go('incidents', i.id)}><Badge sev={i.severity} /><span className="cb-rt"><b>{i.title}</b><small>{i.id} · {i.layer} · {ago(st.now - i.detected_at)} ago · {Math.round(i.root_cause.confidence * 100)}% confidence</small></span><span className="cb-arrow">›</span></button>)}
      </Card>
      <Card title="Recent activity">{st.audit.slice(0, 6).map((a, i) => <div className="cb-act" key={i}><time>{hhmm(a.ts)}</time><span><b>{a.actor}</b> {a.action}</span><small>{a.detail}</small></div>)}</Card>
    </div>
    <Card title="Topology" right={<span className="cb-legend"><i style={{ background: COLOR.healthy }} />healthy<i style={{ background: COLOR.warning }} />warning<i style={{ background: COLOR.critical }} />critical · number = CPU %</span>}><Topology hosts={st.hosts} onPick={(h) => go('infra', h.name)} /></Card>
  </>;
}

function IncidentDetail({ inc, src, now }: { inc: Incident; src: Source; now: number }) {
  const [ex, setEx] = useState(false); const [typed, setTyped] = useState(''); const [pick, setPick] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setEx(false); setTyped(''); setPick(null); }, [inc.id]);
  useEffect(() => { if (!ex) return; let i = 0; const t = setInterval(() => { i += 3; setTyped(inc.explanation.slice(0, i)); if (i >= inc.explanation.length) clearInterval(t); }, 16); return () => clearInterval(t); }, [ex, inc.explanation]);
  const mx = Math.max(...inc.options.map((o) => o.expected));
  const res = inc.status === 'Resolved';
  const run = async (a: string) => { setBusy(true); await src.apply(inc.id, a); setBusy(false); setPick(null); };
  return <div className="cb-detail">
    <div className="cb-dh"><div><Badge sev={inc.severity} /> <span className={`cb-st ${res ? 'ok' : ''}`}>{inc.status}</span><h2>{inc.title}</h2><p>{inc.id} · host {inc.host} · {inc.layer} layer · {res ? `resolved with “${inc.applied_action}”` : `detected ${ago(now - inc.detected_at)} ago`}</p></div></div>
    <div className="cb-grid2 cb-g3">
      <Card title="Root cause"><div className="cb-rc"><b>{inc.root_cause.label}</b><code>{inc.root_cause.rule}</code></div>
        <div className="cb-conf"><div className="cb-bar big"><div style={{ width: `${inc.root_cause.confidence * 100}%` }} /></div><span>{Math.round(inc.root_cause.confidence * 100)}% confidence</span></div>
        <div className="cb-lbl">Blast radius</div><div className="cb-chips">{inc.blast_radius.map((b) => <span key={b}>{b}</span>)}</div></Card>
      <Card title="AI explanation" right={<small className="cb-note">explains the evidence only</small>}>
        {!ex ? <><p className="cb-empty">The AI never invents findings. It reads the evidence below and explains it in plain words.</p><button className="cb-btn" onClick={() => setEx(true)}>Explain this incident</button></> : <p className="cb-ai">{typed}<span className="cb-caret" /></p>}</Card>
    </div>
    <Card title={`Evidence chain (${inc.evidence.length})`}><ol className="cb-tl">{inc.evidence.map((e, i) => <li key={i}><i /><div><b>{e.label}</b> <code>{e.rule}</code><p>{e.message}</p><small>source: {e.source} · {hhmm(e.at)}</small></div></li>)}</ol></Card>
    <Card title="Operations Research: choose the cheapest fix" right={<small className="cb-note">expected cost = action + downtime × $60/min + (1 − success) × penalty</small>}>
      <div className="cb-tw"><table className="cb-table"><thead><tr><th>Action</th><th>Cost</th><th>Downtime</th><th>Success</th><th>Penalty</th><th>Expected cost</th><th /></tr></thead><tbody>
        {inc.options.map((o) => { const best = o.action === inc.recommended; return <tr key={o.action} className={best ? 'best' : ''}><td>{o.action}{best && <span className="cb-rec">recommended</span>}</td><td>{usd(o.cost)}</td><td>{o.downtime} min</td><td>{Math.round(o.success * 100)}%</td><td>{usd(o.penalty)}</td>
          <td><div className="cb-cost"><div style={{ width: `${(o.expected / mx) * 100}%`, background: best ? COLOR.healthy : '#3b4a6b' }} /><b>{usd(o.expected)}</b></div></td>
          <td>{!res && <button className="cb-mini" onClick={() => setPick(o.action)}>Choose</button>}</td></tr>; })}</tbody></table></div>
      {!res && <div className="cb-actions">{pick ? <div className="cb-confirm"><span>Run “<b>{pick}</b>” on {inc.host}?</span><button className="cb-btn" disabled={busy} onClick={() => run(pick)}>{busy ? 'Applying…' : 'Confirm'}</button><button className="cb-btn ghost" onClick={() => setPick(null)}>Cancel</button></div> : <button className="cb-btn" onClick={() => setPick(inc.recommended)}>Apply recommended: {inc.recommended}</button>}</div>}
      {src.mode === 'demo' && !res && <p className="cb-foot">Demo mode: applying a fix only simulates it. In live mode the decision is recorded and your own executor can run it.</p>}
    </Card>
    <Card title="Runbook"><ol className="cb-run">{inc.runbook.map((r) => <li key={r}>{r}</li>)}</ol></Card>
  </div>;
}

function Incidents({ st, src, sel, setSel }: { st: State; src: Source; sel?: string; setSel: (s: string) => void }) {
  const all = [...st.incidents, ...(st.resolved || [])];
  const cur = all.find((i) => i.id === sel) || all[0];
  return <div className="cb-split">
    <div className="cb-list">{all.length === 0 && <p className="cb-empty">No incidents yet.</p>}{all.map((i) => <button key={i.id} className={`cb-row ${cur?.id === i.id ? 'on' : ''}`} onClick={() => setSel(i.id)}><Badge sev={i.severity} /><span className="cb-rt"><b>{i.title}</b><small>{i.id} · {i.status}</small></span></button>)}
      {src.inject && <div className="cb-sim"><small>Demo controls</small><button className="cb-mini" onClick={() => src.inject!('disk')}>+ Disk full</button><button className="cb-mini" onClick={() => src.inject!('service')}>+ Service down</button><button className="cb-mini" onClick={() => src.inject!('unreachable')}>+ Host unreachable</button></div>}</div>
    {cur ? <IncidentDetail inc={cur} src={src} now={st.now} /> : <p className="cb-empty">Select an incident.</p>}
  </div>;
}

function Infra({ st, focus, go }: { st: State; focus?: string; go: (p: string, id?: string) => void }) {
  const [q, setQ] = useState(''); const [layer, setLayer] = useState('All'); const [status, setStatus] = useState('All'); const [sort, setSort] = useState<[keyof Host, number]>(['status', -1]); const [sel, setSel] = useState<string | undefined>(focus);
  useEffect(() => setSel(focus), [focus]);
  const rank = { critical: 2, warning: 1, healthy: 0 } as Record<string, number>;
  const rows = useMemo(() => st.hosts.filter((h) => (layer === 'All' || h.layer === layer) && (status === 'All' || h.status === status) && (h.name + h.platform + h.env).toLowerCase().includes(q.toLowerCase())).sort((a, b) => { const k = sort[0]; const av = k === 'status' ? rank[a.status] : (a[k] as any), bv = k === 'status' ? rank[b.status] : (b[k] as any); return (av > bv ? 1 : av < bv ? -1 : 0) * sort[1]; }), [st.hosts, q, layer, status, sort]);
  const th = (k: keyof Host, l: string) => <th onClick={() => setSort([k, sort[0] === k ? -sort[1] : -1])} className="sortable">{l}{sort[0] === k ? (sort[1] > 0 ? ' ▲' : ' ▼') : ''}</th>;
  const cur = st.hosts.find((h) => h.name === sel);
  return <>
    <Card title="Topology"><Topology hosts={st.hosts} sel={sel} onPick={(h) => setSel(h.name)} /></Card>
    {cur && <Card title={cur.name} right={<button className="cb-link" onClick={() => setSel(undefined)}>Close</button>}><div className="cb-hd"><div><small>Platform</small><b>{cur.platform}</b></div><div><small>Environment</small><b>{cur.env}</b></div><div><small>Layer</small><b>{cur.layer}</b></div><div><small>Source</small><b>{cur.source}</b></div><div><small>CPU / Mem / Disk</small><b>{cur.cpu.toFixed(0)} / {cur.mem.toFixed(0)} / {cur.disk.toFixed(0)}%</b></div><div><small>Last seen</small><b>{ago(st.now - cur.last_seen)} ago</b></div><Spark data={cur.cpu_hist} color={COLOR[cur.status]} w={160} h={36} />{st.incidents.find((i) => i.host === cur.name) && <button className="cb-btn" onClick={() => go('incidents', st.incidents.find((i) => i.host === cur.name)!.id)}>Open incident</button>}</div></Card>}
    <Card title={`Monitored assets (${rows.length})`} right={<div className="cb-filters"><input placeholder="Search host, platform…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><select value={layer} onChange={(e) => setLayer(e.target.value)} aria-label="Layer"><option value="All">All layers</option>{LAYERS.map((l) => <option key={l}>{l}</option>)}</select><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="All">All statuses</option><option value="healthy">healthy</option><option value="warning">warning</option><option value="critical">critical</option></select></div>}>
      <div className="cb-tw"><table className="cb-table"><thead><tr>{th('status', 'Status')}{th('name', 'Host')}{th('platform', 'Platform')}{th('layer', 'Layer')}{th('cpu', 'CPU')}{th('mem', 'Memory')}{th('disk', 'Disk')}<th className="hide-sm">Trend</th></tr></thead><tbody>
        {rows.map((h) => <tr key={h.name} onClick={() => setSel(h.name)} className={sel === h.name ? 'best' : ''} style={{ cursor: 'pointer' }}><td><Dot s={h.status} />{h.status}</td><td><b>{h.name}</b><small className="cb-env">{h.env}{h.source === 'upload' ? ' · uploaded' : ''}</small></td><td>{h.platform}</td><td>{h.layer}</td><td>{h.cpu.toFixed(0)}%</td><td>{h.mem.toFixed(0)}%</td><td>{h.disk.toFixed(0)}%</td><td className="hide-sm"><Spark data={h.cpu_hist} color={COLOR[h.status]} /></td></tr>)}
        {rows.length === 0 && <tr><td colSpan={8} className="cb-empty">No hosts match these filters. <button className="cb-link" onClick={() => { setQ(''); setLayer('All'); setStatus('All'); }}>Reset filters</button></td></tr>}</tbody></table></div></Card>
  </>;
}

function Code({ children }: { children: string }) {
  const [c, setC] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(children); setC('Copied'); } catch { setC('Select the text and copy it'); } setTimeout(() => setC(''), 2200); };
  return <div className="cb-code"><button onClick={copy} type="button">{c || 'Copy'}</button><pre>{children}</pre></div>;
}

const SAMPLE_CSV = `host,layer,platform,env,cpu,mem,disk,latency,service_up,service
web-01,Application,Ubuntu 22.04,prod,41,55,48,120,1,nginx
db-01,Storage,PostgreSQL,prod,52,71,62,90,1,postgres
esx-lab-03,Virtualization,VMware ESXi,lab,96,89,50,610,1,vpxa
`;
function Connect({ st, src }: { st: State; src: Source }) {
  const [key, setKey] = useState(src.mode === 'live' ? 'dev-key-change-me' : 'your-api-key');
  const [text, setText] = useState(SAMPLE_CSV); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null); const fileRef = useRef<HTMLInputElement>(null);
  const send = async (name: string, body: string) => { const r = await src.ingestText(name, body); setMsg(r.error ? { ok: false, t: r.error } : { ok: true, t: `Accepted ${r.accepted} record(s). Check the Infrastructure page.` }); };
  const api = src.apiBase;
  const step = (n: number, t: string, d: string) => <div className="cb-step"><i>{n}</i><div><b>{t}</b><p>{d}</p></div></div>;
  return <>
    <Card title="How data gets into CloudBridge">
      <div className="cb-steps">{step(1, 'Agent measures', 'A tiny program on each server reads CPU, memory, disk and whether services are running.')}{step(2, 'API receives', 'The agent sends the numbers as JSON over HTTP to the CloudBridge API. The API checks the key and the values.')}{step(3, 'Engine decides', 'Rules compare the numbers with limits, collect evidence, find the root cause and price the fixes.')}{step(4, 'Dashboard shows', 'This page reads the result every few seconds. Nobody uploads files by hand.')}</div>
      {src.mode === 'demo' && <p className="cb-foot">You are in demo mode: the data is simulated in your browser and the upload box below really works on it. Run the repository to connect real servers.</p>}
    </Card>
    <div className="cb-grid2">
      <Card title="A. Run the platform"><Code>{`git clone https://github.com/ahmedadel2030-ops/cloudbridge-ai-dashboard
cd cloudbridge-ai-dashboard
docker compose up --build
# dashboard + API: http://localhost:8000`}</Code></Card>
      <Card title="B. Connect a server (agent)"><Code>{`pip install psutil requests
python agent/collector.py --api ${api} --key ${key} \\
  --host web-01 --layer Compute --service nginx`}</Code><label className="cb-lbl">API key<input value={key} onChange={(e) => { setKey(e.target.value); src.setKey?.(e.target.value); }} /></label></Card>
    </div>
    <Card title="C. Send data with one HTTP request"><Code>{`curl -X POST ${api}/api/ingest \\
  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\
  -d '{"host":"web-01","layer":"Application","cpu":42,"mem":58,"disk":47,"latency":130,"services":{"nginx":true}}'`}</Code></Card>
    <Card title="D. Upload a file (CSV or JSON)" right={<small className="cb-note">columns: host, layer, platform, env, cpu, mem, disk, latency, service_up, service</small>}>
      <textarea className="cb-ta" value={text} onChange={(e) => setText(e.target.value)} aria-label="Data to upload" spellCheck={false} />
      <div className="cb-actions"><button className="cb-btn" onClick={() => send('pasted.csv', text)}>Send this data</button>
        <button className="cb-btn ghost" onClick={() => fileRef.current?.click()}>Choose a file…</button>
        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const t = await f.text(); setText(t.slice(0, 20000)); await send(f.name, t); } e.target.value = ''; }} /></div>
      {msg && <p className={`cb-msg ${msg.ok ? 'ok' : 'err'}`} role="status">{msg.t}</p>}
      <p className="cb-foot">Try it: the sample row for esx-lab-03 has CPU 96%, so the engine opens a new incident for it.</p>
    </Card>
    <Card title="API reference"><div className="cb-tw"><table className="cb-table"><tbody>
      {[['POST /api/ingest', 'One record or {"records":[…]}. Needs X-API-Key.'], ['POST /api/ingest/upload', 'CSV or JSON file. Needs X-API-Key.'], ['GET /api/state', 'Everything the dashboard shows.'], ['POST /api/incidents/{id}/apply', 'Record the chosen fix. Needs X-API-Key.']].map(([a, b]) => <tr key={a}><td><code>{a}</code></td><td>{b}</td></tr>)}</tbody></table></div></Card>
  </>;
}

/* ---------- shell ---------- */
const NAV: [string, string, string][] = [['overview', 'Overview', '◧'], ['incidents', 'Incidents', '⚠'], ['infra', 'Infrastructure', '▦'], ['connect', 'Connect data', '⇪']];
export function App({ source }: { source: Source }) {
  const [st, setSt] = useState<State | null>(null); const [page, setPage] = useState('overview'); const [sel, setSel] = useState<string | undefined>();
  const [env, setEnv] = useState('All environments'); const [range, setRange] = useState('Last 2 min');
  useEffect(() => source.subscribe(setSt), [source]);
  const go = (p: string, id?: string) => { setPage(p); setSel(id); window.scrollTo?.(0, 0); };
  if (!st) return <div className="cb-app"><p className="cb-empty">Connecting to the API…</p></div>;
  const view = { ...st, hosts: env === 'All environments' ? st.hosts : st.hosts.filter((h) => h.env.includes(env)) };
  const envs = ['All environments', ...Array.from(new Set(st.hosts.map((h) => h.env)))];
  return <div className="cb-app">
    <aside className="cb-side"><div className="cb-logo"><span>☁</span><b>CloudBridge</b><em>AI</em></div>
      <nav>{NAV.map(([k, l, ic]) => <button key={k} className={page === k ? 'on' : ''} onClick={() => go(k)}><i>{ic}</i>{l}{k === 'incidents' && st.incidents.length > 0 && <u>{st.incidents.length}</u>}</button>)}</nav>
      <div className="cb-sidefoot">{source.mode === 'demo' ? 'Simulated data' : 'Live data'}<small>v1.0 concept prototype</small></div></aside>
    <main className="cb-main">
      <header className="cb-top"><div><h1>{NAV.find((n) => n[0] === page)![1]}</h1><small>Hybrid cloud troubleshooting · rules find it, AI explains it</small></div>
        <div className="cb-ctl"><select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">{envs.map((e) => <option key={e}>{e}</option>)}</select><select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range"><option>Last 2 min</option></select><span className={`cb-live ${source.mode}`}><i />{source.mode === 'demo' ? 'DEMO · SIMULATED' : 'LIVE'}</span></div></header>
      {page === 'overview' && <Overview st={view} go={go} />}
      {page === 'incidents' && <Incidents st={view} src={source} sel={sel} setSel={setSel} />}
      {page === 'infra' && <Infra st={view} focus={sel} go={go} />}
      {page === 'connect' && <Connect st={st} src={source} />}
      <footer className="cb-footer">CloudBridge AI · Graduation project, class of 2027. {source.mode === 'demo' ? 'All numbers on this page are simulated.' : ''}</footer>
    </main></div>;
}
