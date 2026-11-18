import { X, Filter } from 'lucide-react';
import type { BandwidthUnit, EnrichedFlow } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes, formatDuration, formatTimestamp } from '../lib/formatters';

interface FlowInspectorDrawerProps {
  flow: EnrichedFlow | null;
  unit: BandwidthUnit;
  theme: ThemePalette;
  onClose: () => void;
  onFilterByHost: (ip: string) => void;
}

export function FlowInspectorDrawer({
  flow,
  unit,
  theme,
  onClose,
  onFilterByHost,
}: FlowInspectorDrawerProps) {
  if (!flow) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flow-inspector-title"
    >
      <div
        className="fixed inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-md app-sidebar border-l h-full overflow-y-auto p-6 flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4 border-b app-border pb-4">
          <div>
            <p className="text-xs app-text-muted">Netfilter Connection Detail</p>
            <h2
              id="flow-inspector-title"
              className="font-display text-lg font-semibold mt-0.5"
            >
              {flow.app} ({flow.proto})
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connection inspector"
            className="p-1.5 rounded-md app-text-muted app-row-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="app-surface border rounded-md p-3">
            <div className="text-xs app-text-muted">Download (Rx)</div>
            <div
              className="font-mono text-base font-semibold mt-1 tabular-nums"
              style={{ color: theme.rxColor }}
            >
              {formatBandwidth(flow.rxBps, unit)}
            </div>
            <div className="font-mono text-xs app-text-muted mt-1 tabular-nums">
              {formatBytes(flow.rxBytes)} total
            </div>
          </div>

          <div className="app-surface border rounded-md p-3">
            <div className="text-xs app-text-muted">Upload (Tx)</div>
            <div
              className="font-mono text-base font-semibold mt-1 tabular-nums"
              style={{ color: theme.txColor }}
            >
              {formatBandwidth(flow.txBps, unit)}
            </div>
            <div className="font-mono text-xs app-text-muted mt-1 tabular-nums">
              {formatBytes(flow.txBytes)} total
            </div>
          </div>
        </div>

        <dl className="divide-y app-border text-xs">
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">LAN Client</dt>
            <dd className="font-mono text-right tabular-nums">
              {flow.srcHost} ({flow.srcIp}:{flow.sport})
            </dd>
          </div>
          {flow.srcMac && (
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="app-text-muted">Client MAC</dt>
              <dd className="font-mono app-text-secondary">{flow.srcMac}</dd>
            </div>
          )}
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">Remote IP</dt>
            <dd className="font-mono text-right tabular-nums">
              {flow.dstIp}:{flow.dport}
            </dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">Service / Hostname</dt>
            <dd className="text-right app-text-secondary">
              {flow.dstService}
              {flow.dstHost && flow.dstHost !== flow.dstIp ? ` (${flow.dstHost})` : ''}
            </dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">Conntrack State</dt>
            <dd className="font-mono app-text-secondary">
              {flow.state} · {flow.assured ? 'ASSURED' : 'UNASSURED'}
            </dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">Kernel TTL</dt>
            <dd className="font-mono app-text-secondary tabular-nums">{formatDuration(flow.ttl)}</dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="app-text-muted">First / Last Observed</dt>
            <dd className="font-mono app-text-secondary tabular-nums">
              {formatTimestamp(flow.firstSeen)} / {formatTimestamp(flow.lastSeen)}
            </dd>
          </div>
        </dl>

        <div className="mt-auto pt-4 border-t app-border flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              onFilterByHost(flow.srcIp);
              onClose();
            }}
            className="flex-1 inline-flex items-center justify-center gap-2 py-2 px-4 rounded-md bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors"
          >
            <Filter className="h-3.5 w-3.5" aria-hidden="true" />
            Filter All Connections from {flow.srcIp}
          </button>
        </div>
      </div>
    </div>
  );
}
