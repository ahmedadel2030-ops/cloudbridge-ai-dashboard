export type Sev = 'critical' | 'high' | 'medium' | 'low';
export type Status = 'healthy' | 'warning' | 'critical';
export const LAYERS = ['Network', 'Compute', 'Storage', 'Virtualization', 'Cloud', 'Application'] as const;

export interface Host {
  name: string; layer: string; platform: string; env: string; source: string;
  cpu: number; mem: number; disk: number; latency: number;
  services: Record<string, boolean>; last_seen: number; status: Status; cpu_hist: number[];
}
export interface Evidence { rule: string; label: string; message: string; value: number | string; source: string; at: number }
export interface Option { action: string; cost: number; downtime: number; success: number; penalty: number; expected: number }
export interface Incident {
  id: string; title: string; severity: Sev; kind: string; host: string; layer: string;
  status: 'Open' | 'Resolved'; detected_at: number; resolved_at?: number; applied_action?: string;
  root_cause: { label: string; rule: string; confidence: number };
  evidence: Evidence[]; blast_radius: string[]; options: Option[]; recommended: string;
  runbook: string[]; explanation: string;
}
export interface AuditEntry { ts: number; actor: string; action: string; detail: string }
export interface State {
  mode: 'demo' | 'live'; now: number; hosts: Host[]; incidents: Incident[]; resolved?: Incident[];
  layers: { name: string; health: number | null; hosts: number }[];
  kpis: { health: number; open_incidents: number; mttr_min: number; evidence: number; rules: number };
  series: { t: number[]; latency: number[]; cpu: number[] };
  audit: AuditEntry[];
}
export interface Source {
  mode: 'demo' | 'live';
  subscribe(cb: (s: State) => void): () => void;
  apply(id: string, action: string): Promise<void>;
  ingestText(name: string, text: string): Promise<{ accepted: number; error?: string }>;
  inject?(kind: 'disk' | 'service' | 'unreachable'): void;
  setKey?(k: string): void;
  apiBase: string;
}
