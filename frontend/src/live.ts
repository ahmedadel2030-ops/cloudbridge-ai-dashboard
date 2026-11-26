// Live data source: talks to the FastAPI backend.
import type { Source, State } from './types';

export function createLiveSource(apiBase = ''): Source {
  let key = (() => { try { return localStorage.getItem('cb_key') || 'dev-key-change-me'; } catch { return 'dev-key-change-me'; } })();
  const subs = new Set<(s: State) => void>();
  let last: State | null = null;
  const poll = async () => {
    try { const r = await fetch(`${apiBase}/api/state`); if (r.ok) { last = await r.json(); subs.forEach((cb) => cb(last!)); } } catch { /* offline */ }
  };
  setInterval(poll, 3000);
  const H = () => ({ 'X-API-Key': key });
  return {
    mode: 'live', apiBase: apiBase || location.origin,
    subscribe(cb) { subs.add(cb); if (last) cb(last); else poll(); return () => subs.delete(cb); },
    async apply(id, action) {
      await fetch(`${apiBase}/api/incidents/${id}/apply`, { method: 'POST', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      await poll();
    },
    async ingestText(name, text) {
      const fd = new FormData(); fd.append('file', new Blob([text]), name);
      const r = await fetch(`${apiBase}/api/ingest/upload`, { method: 'POST', headers: H(), body: fd });
      const j = await r.json().catch(() => ({}));
      await poll();
      return r.ok ? { accepted: j.accepted } : { accepted: 0, error: typeof j.detail === 'string' ? j.detail : 'Upload failed (check the API key)' };
    },
    setKey(k) { key = k; try { localStorage.setItem('cb_key', k); } catch { /* ignore */ } },
  };
}
