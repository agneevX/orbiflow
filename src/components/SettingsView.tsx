import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCog,
  FolderOpen,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
} from 'lucide-react';
import type { PersistenceMode, ServerConfig, ServerStats } from '../types/telemetry';
import { formatBytes } from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface SettingsViewProps {
  serverConfig: ServerConfig;
  serverStats: ServerStats;
  onSaveSettings: (cfg: Partial<ServerConfig>) => Promise<void>;
}

function generateClientRandomToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `of_${hex}`;
}

export function SettingsView({
  serverConfig,
  serverStats,
  onSaveSettings,
}: SettingsViewProps) {
  const [probeToken, setProbeToken] = useState(serverConfig.probeToken || '');
  const [showToken, setShowToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>(
    serverConfig.persistenceMode
  );
  const [cacheDir, setCacheDir] = useState(serverConfig.cacheDir || '/config/cache');
  const [inferDeviceNames, setInferDeviceNames] = useState(
    serverConfig.inferDeviceNames !== false
  );
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  useEffect(() => {
    setProbeToken(serverConfig.probeToken || '');
    setPersistenceMode(serverConfig.persistenceMode);
    setCacheDir(serverConfig.cacheDir || '/config/cache');
    setInferDeviceNames(serverConfig.inferDeviceNames !== false);
  }, [serverConfig]);

  const handleGenerateToken = () => {
    setProbeToken(generateClientRandomToken());
    setShowToken(true);
  };

  const handleCopyToken = async () => {
    if (!probeToken.trim()) return;
    try {
      await navigator.clipboard.writeText(probeToken.trim());
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } catch {
      // Clipboard API fallback ignored
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({
        probeToken: probeToken.trim() || serverConfig.probeToken,
        persistenceMode,
        cacheDir: cacheDir.trim() || '/config/cache',
        inferDeviceNames,
      });
      setSavedNotice('Settings saved to configuration file');
      setTimeout(() => setSavedNotice(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  const activeCacheDiffers =
    serverStats.activeCacheDir &&
    cacheDir.trim() &&
    serverStats.activeCacheDir !== cacheDir.trim();

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Persistent Configuration File & Shared Router Agent Token */}
      <section className="app-surface border rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0 flex-1">
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <FileCog className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>Persistent Configuration</span>
            </h2>
            <p className="text-xs app-text-muted">
              All settings, shared agent token, device aliases, alert rules, and notification
              channels are stored in the <span className="font-mono app-text-secondary">/config</span>{' '}
              <TechTerm
                label="Docker volume"
                tip="A persistent folder mounted from your host machine into /config inside the container so settings survive restarts and image upgrades without application environment variables."
              />
              . The container only uses <span className="font-mono app-text-secondary">PUID</span>,{' '}
              <span className="font-mono app-text-secondary">PGID</span>, and{' '}
              <span className="font-mono app-text-secondary">TZ</span> and runs as non-root.
            </p>
          </div>
          <div
            data-testid="config-file-path"
            className="font-mono text-xs app-input border rounded-xl px-3.5 py-1.5 app-text-secondary shrink-0"
          >
            {serverStats.configPath}
          </div>
        </div>

        <div className="pt-3 border-t app-border space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="probe-token-input"
              className="flex items-center gap-1.5 text-xs font-medium"
            >
              <KeyRound className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
              <span>Shared Router Agent Token</span>
            </label>
            <button
              type="button"
              data-testid="regenerate-token-btn"
              onClick={handleGenerateToken}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400 transition-colors"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              <span>Regenerate random token</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="probe-token-input"
              data-testid="probe-token-input"
              type={showToken ? 'text' : 'password'}
              value={probeToken}
              onChange={(e) => setProbeToken(e.target.value)}
              placeholder="Auto-generated random token"
              className="flex-1 min-w-0 app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => setShowToken((prev) => !prev)}
              aria-label={showToken ? 'Hide shared agent token' : 'Show shared agent token'}
              title={showToken ? 'Hide token' : 'Show token'}
              className="inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-surface app-row-hover transition-colors shrink-0"
            >
              {showToken ? (
                <EyeOff className="h-4 w-4 app-text-muted" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4 app-text-muted" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={handleCopyToken}
              aria-label="Copy shared agent token"
              title="Copy token"
              className="inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-surface app-row-hover transition-colors shrink-0"
            >
              {copiedToken ? (
                <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4 app-text-muted" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="text-[11px] app-text-muted leading-relaxed">
            Authenticates traffic snapshots pushed by your router agent via the{' '}
            <span className="font-mono app-text-secondary">X-Probe-Token</span> header so
            unauthorized devices on your network cannot spoof traffic data. Automatically generated
            randomly on first start and synced to the scripts in the Agent tab.
          </p>
        </div>
      </section>

      {/* Traffic History & Cache Storage */}
      <section className="app-surface border rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="font-display text-sm font-semibold flex items-center gap-2">
            <Database className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
            <span>Traffic History Storage</span>
          </h2>
          <p className="text-xs app-text-muted mt-1">
            Choose whether traffic snapshots stay in memory or are cached on disk inside your
            configured storage folder.
          </p>
        </div>

        <div className="space-y-2.5">
          <label className="flex items-start gap-3 p-3.5 rounded-xl border app-border app-input cursor-pointer">
            <input
              type="radio"
              name="persistenceMode"
              value="memory"
              checked={persistenceMode === 'memory'}
              onChange={() => setPersistenceMode('memory')}
              className="mt-0.5 text-sky-500 focus:ring-sky-500"
            />
            <div>
              <div className="text-xs font-semibold">Memory Only (Zero Disk Writes)</div>
              <div className="text-xs app-text-muted mt-0.5">
                Keeps 15-minute high-resolution samples and 24-hour summaries in RAM. Clears
                traffic history on restart while preserving{' '}
                <span className="font-mono">config.json</span>.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3.5 rounded-xl border app-border app-input cursor-pointer">
            <input
              type="radio"
              name="persistenceMode"
              value="disk"
              checked={persistenceMode === 'disk'}
              onChange={() => setPersistenceMode('disk')}
              className="mt-0.5 text-sky-500 focus:ring-sky-500"
            />
            <div>
              <div className="text-xs font-semibold">
                Disk Cache (
                <TechTerm
                  label="JSONL"
                  tip="JSON Lines — a lightweight append-only text format where each line stores one timestamped traffic snapshot, rotated automatically above 5 MB."
                />{' '}
                + State Snapshot)
              </div>
              <div className="text-xs app-text-muted mt-0.5">
                Saves traffic history and auto-rotated snapshot logs to disk so charts remain
                populated across restarts.
              </div>
            </div>
          </label>
        </div>

        {/* Configurable Cache Directory */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="cache-dir-input"
              className="flex items-center gap-1.5 text-xs font-medium"
            >
              <FolderOpen className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
              Disk Storage Location
            </label>
            {cacheDir !== '/config/cache' && (
              <button
                type="button"
                onClick={() => setCacheDir('/config/cache')}
                className="text-[11px] text-sky-500 hover:text-sky-400"
              >
                Reset to /config/cache
              </button>
            )}
          </div>
          <input
            id="cache-dir-input"
            data-testid="cache-dir-input"
            type="text"
            value={cacheDir}
            onChange={(e) => setCacheDir(e.target.value)}
            placeholder="/config/cache"
            className="w-full app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
          />
          <p className="text-[11px] app-text-muted">
            Default: <span className="font-mono">/config/cache</span>
            {activeCacheDiffers && (
              <>
                {' '}
                · Active path:{' '}
                <span className="font-mono app-text-secondary">
                  {serverStats.activeCacheDir}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="pt-2 border-t app-border flex items-center justify-between text-xs font-mono app-text-muted tabular-nums">
          <span>Snapshots recorded: {serverStats.persistedSnapshots}</span>
          <span>Disk usage: {formatBytes(serverStats.diskLogSizeBytes)}</span>
        </div>
      </section>

      {/* Device Naming */}
      <section className="app-surface border rounded-2xl p-5 space-y-3">
        <div>
          <h2 className="font-display text-sm font-semibold flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
            <span>Device Naming</span>
          </h2>
          <p className="text-xs app-text-muted mt-1">
            Control how unnamed local devices (such as devices using Private Wi-Fi MAC addresses)
            are labeled when no custom alias, LAN DNS, or DHCP hostname is found.
          </p>
        </div>

        <label className="flex items-start gap-3 p-3.5 rounded-xl border app-border app-input cursor-pointer">
          <input
            type="checkbox"
            data-testid="infer-device-names-toggle"
            checked={inferDeviceNames}
            onChange={(e) => setInferDeviceNames(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
          />
          <div>
            <div className="text-xs font-semibold">Inferred Device Names</div>
            <div className="text-xs app-text-muted mt-0.5">
              Infer device types (for example, Apple Device, Gaming Device, or Smart Home / IoT)
              from active traffic patterns. Turn this off to show raw IP addresses for unnamed
              devices instead.
            </div>
          </div>
        </label>
      </section>

      <div className="flex items-center justify-between gap-4">
        <div className="text-xs font-medium text-emerald-500 min-h-[16px]">
          {savedNotice && (
            <span className="inline-flex items-center gap-1">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {savedNotice}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-xl app-btn-primary disabled:opacity-60 text-xs font-semibold transition-colors"
        >
          {saving ? 'Saving Settings...' : 'Save Settings'}
        </button>
      </div>
    </form>
  );
}
