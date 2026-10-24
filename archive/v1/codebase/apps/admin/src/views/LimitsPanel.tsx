// Per-user limits (FR-15.8) and the admin-only auto-publish flag (spec §5.2): the API
// refuses it for a profile with medical guardrails (409, shown as the error) and audits
// every change.

export interface Limits {
  monthlyCapUsd: number;
  maxRunsPerDay: number;
  maxReqPerMin: number;
  autoPublish: boolean;
}

export interface LimitsState {
  userId: string;
  limits: Limits;
  spentUsd: number;
}

interface Props {
  value: LimitsState;
  busy: boolean;
  onChange: (next: LimitsState) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function LimitsPanel({ value, busy, onChange, onSave, onCancel }: Props) {
  const set = (patch: Partial<Limits>) => onChange({ ...value, limits: { ...value.limits, ...patch } });
  const number = (key: "monthlyCapUsd" | "maxRunsPerDay" | "maxReqPerMin", label: string, width: string) => (
    <div>
      <label>{label}</label>
      <input value={value.limits[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} style={{ width }} />
    </div>
  );
  return (
    <div className="panel">
      <h2>Limits (FR-15.8) — ${value.spentUsd.toFixed(2)} spent this month</h2>
      <div className="row">
        {number("monthlyCapUsd", "Monthly cap (USD)", "5rem")}
        {number("maxRunsPerDay", "Runs / day", "4rem")}
        {number("maxReqPerMin", "Requests / min", "4rem")}
        <div>
          <label>Auto-publish (spec §5.2)</label>
          <input type="checkbox" checked={value.limits.autoPublish} onChange={(e) => set({ autoPublish: e.target.checked })} />
        </div>
        <button className="primary" disabled={busy} onClick={onSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      <p className="muted">
        Suspension is an account state, never a $0 cap (FR-2.7). Auto-publish is refused for medical profiles and
        every change is audited.
      </p>
    </div>
  );
}
