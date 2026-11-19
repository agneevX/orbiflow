import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Trash2 } from 'lucide-react';
import type { AlertEvent, AlertRule } from '../types/telemetry';
import { formatTimestamp } from '../lib/formatters';

interface AlertsViewProps {
  rules: AlertRule[];
  alerts: AlertEvent[];
  onSaveRules: (rules: AlertRule[]) => Promise<void>;
  onAcknowledgeAlert: (id: string) => Promise<void>;
  onClearAlerts: () => Promise<void>;
}

const METRIC_UNITS: Record<AlertRule['metric'], string> = {
  wan_rx_mbps: 'Mb/s',
  wan_tx_mbps: 'Mb/s',
  host_flows: 'connections / device',
  total_flows: 'total connections',
};

export function AlertsView({
  rules,
  alerts,
  onSaveRules,
  onAcknowledgeAlert,
  onClearAlerts,
}: AlertsViewProps) {
  const [draftRules, setDraftRules] = useState<AlertRule[]>(rules);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');

  useEffect(() => {
    setDraftRules(rules);
  }, [rules]);

  const handleToggleRule = (id: string) => {
    setDraftRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const handleThresholdChange = (id: string, rawVal: string) => {
    const val = Math.max(1, Number(rawVal) || 1);
    setDraftRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, threshold: val } : r))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveRules(draftRules);
      setSavedNote('Rules updated');
      setTimeout(() => setSavedNote(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <form
        onSubmit={handleSubmit}
        className="xl:col-span-5 app-surface border rounded-2xl p-5 space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold">
              Bandwidth &amp; Connection Rules
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              Evaluated server-side on every incoming traffic snapshot
            </p>
          </div>
          {savedNote && (
            <span className="text-xs font-medium text-emerald-500 inline-flex items-center gap-1">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {savedNote}
            </span>
          )}
        </div>

        <div className="divide-y app-border">
          {draftRules.map((rule) => (
            <div key={rule.id} className="py-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`rule-toggle-${rule.id}`}
                  className="text-sm font-medium cursor-pointer"
                >
                  {rule.name}
                </label>
                <input
                  id={`rule-toggle-${rule.id}`}
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => handleToggleRule(rule.id)}
                  className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label
                  htmlFor={`rule-threshold-${rule.id}`}
                  className="text-xs app-text-muted whitespace-nowrap"
                >
                  Trigger above
                </label>
                <input
                  id={`rule-threshold-${rule.id}`}
                  type="number"
                  min={1}
                  max={100000}
                  value={rule.threshold}
                  onChange={(e) => handleThresholdChange(rule.id, e.target.value)}
                  className="w-24 app-input border rounded-xl px-2.5 py-1 text-xs font-mono tabular-nums focus:outline-none focus:border-sky-500"
                />
                <span className="text-xs font-mono app-text-muted">
                  {METRIC_UNITS[rule.metric]}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 px-4 rounded-xl app-btn-primary disabled:opacity-60 text-xs font-semibold transition-colors"
          >
            {saving ? 'Saving Rules...' : 'Save Threshold Rules'}
          </button>
        </div>
      </form>

      <section className="xl:col-span-7 app-surface border rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b app-border flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-sm font-semibold">
              Triggered Alert Events ({alerts.length})
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              20-second cooldown per rule to prevent duplicate notifications
            </p>
          </div>
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={onClearAlerts}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-row-hover text-xs transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
              Clear All
            </button>
          )}
        </div>

        {alerts.length === 0 ? (
          <div className="py-12 px-6 text-center space-y-2">
            <CheckCircle2 className="h-7 w-7 text-emerald-500 mx-auto" aria-hidden="true" />
            <p className="text-sm font-medium">No threshold violations</p>
            <p className="text-xs app-text-muted max-w-sm mx-auto">
              Lower a threshold (for example, set High Download Usage to 15 Mb/s) to verify live alerting.
            </p>
          </div>
        ) : (
          <div className="divide-y app-border">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`p-4 flex items-start justify-between gap-4 ${
                  alert.acknowledged ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <AlertTriangle
                    className={`h-4 w-4 mt-0.5 shrink-0 ${
                      alert.severity === 'critical' ? 'text-red-500' : 'text-amber-500'
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{alert.ruleName}</span>
                      <span className="app-text-muted">·</span>
                      <span
                        className={`font-mono uppercase ${
                          alert.severity === 'critical' ? 'text-red-500' : 'text-amber-500'
                        }`}
                      >
                        {alert.severity}
                      </span>
                      <span className="app-text-muted">·</span>
                      <span className="font-mono app-text-muted tabular-nums">
                        {formatTimestamp(alert.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs app-text-secondary mt-1">{alert.message}</p>
                  </div>
                </div>

                {!alert.acknowledged && (
                  <button
                    type="button"
                    onClick={() => onAcknowledgeAlert(alert.id)}
                    className="px-2.5 py-1 rounded-xl border app-border app-row-hover text-xs whitespace-nowrap shrink-0"
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
