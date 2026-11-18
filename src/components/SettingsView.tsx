import { useEffect, useState } from 'react';
import { Check, Database, Globe, Monitor, Trash2 } from 'lucide-react';
import type { PersistenceMode, ServerConfig, ServerStats } from '../types/telemetry';
import { formatBytes } from '../lib/formatters';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEMES,
  type ThemeId,
  type ThemeSetting,
} from '../lib/themes';

interface SettingsViewProps {
  serverConfig: ServerConfig;
  serverStats: ServerStats;
  onSaveSettings: (cfg: Partial<ServerConfig>) => Promise<void>;
  onClearRdnsCache: () => Promise<void>;
  themeSetting: ThemeSetting;
  effectiveThemeId: ThemeId;
  systemPrefersDark: boolean;
  autoDarkTheme: ThemeId;
  autoLightTheme: ThemeId;
  onChangeThemeSetting: (setting: ThemeSetting) => void;
  onChangeAutoDarkTheme: (id: ThemeId) => void;
  onChangeAutoLightTheme: (id: ThemeId) => void;
}

export function SettingsView({
  serverConfig,
  serverStats,
  onSaveSettings,
  onClearRdnsCache,
  themeSetting,
  effectiveThemeId,
  systemPrefersDark,
  autoDarkTheme,
  autoLightTheme,
  onChangeThemeSetting,
  onChangeAutoDarkTheme,
  onChangeAutoLightTheme,
}: SettingsViewProps) {
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>(
    serverConfig.persistenceMode
  );
  const [rdnsEnabled, setRdnsEnabled] = useState(serverConfig.rdnsEnabled);
  const [rdnsTtlSec, setRdnsTtlSec] = useState(serverConfig.rdnsTtlSec);
  const [rdnsSkipPrivate, setRdnsSkipPrivate] = useState(serverConfig.rdnsSkipPrivate);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  useEffect(() => {
    setPersistenceMode(serverConfig.persistenceMode);
    setRdnsEnabled(serverConfig.rdnsEnabled);
    setRdnsTtlSec(serverConfig.rdnsTtlSec);
    setRdnsSkipPrivate(serverConfig.rdnsSkipPrivate);
  }, [serverConfig]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({
        persistenceMode,
        rdnsEnabled,
        rdnsTtlSec: Math.max(60, Number(rdnsTtlSec) || 3600),
        rdnsSkipPrivate,
      });
      setSavedNotice('Settings saved');
      setTimeout(() => setSavedNotice(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Persistence Mode */}
        <section className="app-surface border rounded-lg p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                <Database className="h-4 w-4 text-sky-500" aria-hidden="true" />
                Traffic Log Persistence
              </h2>
              <p className="text-xs app-text-muted mt-1">
                Choose whether snapshots from the Orbi agent stay purely in RAM or persist to disk in <span className="font-mono">/app/data</span>.
              </p>
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="flex items-start gap-3 p-3 rounded-md border app-border app-input cursor-pointer">
              <input
                type="radio"
                name="persistenceMode"
                value="memory"
                checked={persistenceMode === 'memory'}
                onChange={() => setPersistenceMode('memory')}
                className="mt-0.5 text-sky-500 focus:ring-sky-500"
              />
              <div>
                <div className="text-xs font-semibold">Memory Only (Zero Disk I/O)</div>
                <div className="text-xs app-text-muted mt-0.5">
                  Fastest mode with 15-minute high-res and 24-hour rollup ring buffers in RAM. Resets on container restart.
                </div>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3 rounded-md border app-border app-input cursor-pointer">
              <input
                type="radio"
                name="persistenceMode"
                value="disk"
                checked={persistenceMode === 'disk'}
                onChange={() => setPersistenceMode('disk')}
                className="mt-0.5 text-sky-500 focus:ring-sky-500"
              />
              <div>
                <div className="text-xs font-semibold">Disk Storage (JSONL + State Snapshot)</div>
                <div className="text-xs app-text-muted mt-0.5">
                  Persists traffic history, alert rules, and auto-rotated snapshot logs to <span className="font-mono">./data</span>.
                </div>
              </div>
            </label>
          </div>

          <div className="pt-2 border-t app-border flex items-center justify-between text-xs font-mono app-text-muted tabular-nums">
            <span>Snapshots recorded: {serverStats.persistedSnapshots}</span>
            <span>Disk usage: {formatBytes(serverStats.diskLogSizeBytes)}</span>
          </div>
        </section>

        {/* Cached Reverse DNS */}
        <section className="app-surface border rounded-lg p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4 text-sky-500" aria-hidden="true" />
                Cached Reverse DNS (PTR)
              </h2>
              <p className="text-xs app-text-muted mt-1">
                Built-in IP prefix mapping works offline with zero DNS queries. Enable PTR lookups only when needed; hits and NXDOMAINs are cached to avoid polluting DNS logs.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs font-medium">Enable live PTR lookups</span>
              <input
                type="checkbox"
                checked={rdnsEnabled}
                onChange={(e) => setRdnsEnabled(e.target.checked)}
                className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs font-medium">Skip private LAN IPs (RFC1918)</span>
              <input
                type="checkbox"
                checked={rdnsSkipPrivate}
                onChange={(e) => setRdnsSkipPrivate(e.target.checked)}
                className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="rdns-ttl" className="text-xs font-medium">
                Cache TTL (seconds)
              </label>
              <input
                id="rdns-ttl"
                type="number"
                min={60}
                max={86400}
                value={rdnsTtlSec}
                onChange={(e) => setRdnsTtlSec(Number(e.target.value) || 3600)}
                className="w-28 app-input border rounded-md px-2.5 py-1.5 text-xs font-mono tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="pt-2 border-t app-border flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-mono app-text-muted tabular-nums">
              Cached: {serverStats.rdnsCacheSize} · Hits: {serverStats.rdnsHits} · Misses: {serverStats.rdnsMisses}
            </span>
            <button
              type="button"
              onClick={onClearRdnsCache}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border app-border app-row-hover text-xs font-medium"
            >
              <Trash2 className="h-3 w-3 app-text-muted" aria-hidden="true" />
              Flush Cache
            </button>
          </div>
        </section>
      </div>

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
          className="px-5 py-2 rounded-md bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 text-xs font-semibold transition-colors"
        >
          {saving ? 'Saving Settings...' : 'Save Server Settings'}
        </button>
      </div>

      {/* Browser Appearance & Auto System Theme Pairing */}
      <section className="app-surface border rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <Monitor className="h-4 w-4 text-sky-500" aria-hidden="true" />
              Appearance &amp; Auto System Theme
            </h2>
            <p className="text-xs app-text-muted mt-1">
              Automatically follow your OS dark/light preference or lock to a specific palette. Currently active:{' '}
              <span className="font-medium app-text-secondary">
                {THEMES[effectiveThemeId].label}
              </span>
              {themeSetting === 'auto'
                ? ` (System ${systemPrefersDark ? 'Dark' : 'Light'})`
                : ' (Manual)'}
              .
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="settings-theme-mode" className="block text-xs font-medium">
              Theme Mode
            </label>
            <select
              id="settings-theme-mode"
              value={themeSetting}
              onChange={(e) => onChangeThemeSetting(e.target.value as ThemeSetting)}
              className="w-full app-input border rounded-md px-2.5 py-2 text-xs focus:outline-none focus:border-sky-500"
            >
              <option value="auto">
                Auto (System · {systemPrefersDark ? 'Dark' : 'Light'})
              </option>
              <optgroup label="Dark Themes">
                {DARK_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Light Themes">
                {LIGHT_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="auto-dark-theme" className="block text-xs font-medium">
              Auto Dark Palette
            </label>
            <select
              id="auto-dark-theme"
              value={autoDarkTheme}
              onChange={(e) => onChangeAutoDarkTheme(e.target.value as ThemeId)}
              className="w-full app-input border rounded-md px-2.5 py-2 text-xs focus:outline-none focus:border-sky-500"
            >
              {DARK_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="auto-light-theme" className="block text-xs font-medium">
              Auto Light Palette
            </label>
            <select
              id="auto-light-theme"
              value={autoLightTheme}
              onChange={(e) => onChangeAutoLightTheme(e.target.value as ThemeId)}
              className="w-full app-input border rounded-md px-2.5 py-2 text-xs focus:outline-none focus:border-sky-500"
            >
              {LIGHT_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </form>
  );
}
