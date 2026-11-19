import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Database,
  FileCog,
  FolderOpen,
  Globe,
  MapPin,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { PersistenceMode, ServerConfig, ServerStats } from '../types/telemetry';
import { formatBytes } from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface SettingsViewProps {
  serverConfig: ServerConfig;
  serverStats: ServerStats;
  onSaveSettings: (cfg: Partial<ServerConfig>) => Promise<void>;
  onClearRdnsCache: () => Promise<void>;
  onReloadGeoip: () => Promise<void>;
  onUploadGeoip: (file: File) => Promise<{ ok: boolean; message: string }>;
}

export function SettingsView({
  serverConfig,
  serverStats,
  onSaveSettings,
  onClearRdnsCache,
  onReloadGeoip,
  onUploadGeoip,
}: SettingsViewProps) {
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>(
    serverConfig.persistenceMode
  );
  const [cacheDir, setCacheDir] = useState(serverConfig.cacheDir || '/config/cache');
  const [geoipEnabled, setGeoipEnabled] = useState(serverConfig.geoipEnabled ?? true);
  const [geoipDir, setGeoipDir] = useState(serverConfig.geoipDir || '/config/geoip');
  const [rdnsEnabled, setRdnsEnabled] = useState(serverConfig.rdnsEnabled);
  const [rdnsTtlSec, setRdnsTtlSec] = useState(serverConfig.rdnsTtlSec);
  const [rdnsSkipPrivate, setRdnsSkipPrivate] = useState(serverConfig.rdnsSkipPrivate);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [geoipNotice, setGeoipNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [reloadingGeoip, setReloadingGeoip] = useState(false);
  const [uploadingGeoip, setUploadingGeoip] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPersistenceMode(serverConfig.persistenceMode);
    setCacheDir(serverConfig.cacheDir || '/config/cache');
    setGeoipEnabled(serverConfig.geoipEnabled ?? true);
    setGeoipDir(serverConfig.geoipDir || '/config/geoip');
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
        cacheDir: cacheDir.trim() || '/config/cache',
        geoipEnabled,
        geoipDir: geoipDir.trim() || '/config/geoip',
        rdnsEnabled,
        rdnsTtlSec: Math.max(60, Number(rdnsTtlSec) || 3600),
        rdnsSkipPrivate,
      });
      setSavedNotice('Settings saved to configuration file');
      setTimeout(() => setSavedNotice(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  const handleReloadDatabases = async () => {
    setReloadingGeoip(true);
    try {
      await onReloadGeoip();
      setGeoipNotice({ ok: true, text: 'Scanned MaxMind folder for .mmdb files' });
      setTimeout(() => setGeoipNotice(null), 3000);
    } finally {
      setReloadingGeoip(false);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingGeoip(true);
    setGeoipNotice(null);
    try {
      const res = await onUploadGeoip(file);
      setGeoipNotice({ ok: res.ok, text: res.message });
      setTimeout(() => setGeoipNotice(null), 4000);
    } finally {
      setUploadingGeoip(false);
    }
  };

  const activeCacheDiffers =
    serverStats.activeCacheDir &&
    cacheDir.trim() &&
    serverStats.activeCacheDir !== cacheDir.trim();

  const activeGeoipDiffers =
    serverStats.geoipActiveDir &&
    geoipDir.trim() &&
    serverStats.geoipActiveDir !== geoipDir.trim();

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      {/* Persistent Configuration File Info */}
      <section className="app-surface border rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <FileCog className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>Persistent Configuration Volume</span>
            </h2>
            <p className="text-xs app-text-muted">
              Server settings and alert rules are always saved in the{' '}
              <span className="font-mono app-text-secondary">/config</span>{' '}
              <TechTerm
                label="Docker volume"
                tip="A persistent folder mounted from your host machine into /config inside the container so settings survive restarts and image upgrades."
              />
              .
            </p>
          </div>
          <div
            data-testid="config-file-path"
            className="font-mono text-xs app-input border rounded-xl px-3.5 py-1.5 app-text-secondary"
          >
            {serverStats.configPath}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Traffic History & Cache Storage */}
        <section className="app-surface border rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>Traffic History Storage</span>
            </h2>
            <p className="text-xs app-text-muted mt-1">
              Choose whether traffic snapshots stay in memory or are cached on disk inside your configured storage folder.
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
                  Keeps 15-minute high-resolution samples and 24-hour summaries in RAM. Clears traffic history on restart while preserving{' '}
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
                  Saves traffic history and auto-rotated snapshot logs to disk so charts remain populated across restarts.
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

        {/* Cached Reverse DNS */}
        <section className="app-surface border rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <Globe className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>
                Host Name Lookup (
                <TechTerm
                  label="Reverse DNS"
                  tip="Converts numeric internet IP addresses (like 142.250.80.46) into human-readable domain names using DNS PTR records."
                />
                )
              </span>
            </h2>
            <p className="text-xs app-text-muted mt-1">
              Built-in service matching works offline with zero DNS queries. Enable live{' '}
              <TechTerm
                label="PTR"
                tip="Pointer Record — the DNS record type used to look up a hostname from an IP address."
              />{' '}
              lookups only when needed; results are cached in memory to keep DNS traffic minimal.
            </p>
          </div>

          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs font-medium">
                Enable live{' '}
                <TechTerm
                  label="PTR"
                  tip="Queries your local DNS resolver to resolve unknown external IP addresses into hostnames."
                />{' '}
                lookups
              </span>
              <input
                type="checkbox"
                checked={rdnsEnabled}
                onChange={(e) => setRdnsEnabled(e.target.checked)}
                className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs font-medium">
                Skip private local IPs (
                <TechTerm
                  label="RFC1918"
                  tip="Standard private home/office network address ranges (192.168.x.x, 10.x.x.x, 172.16–31.x.x) that are already named by your router."
                />
                )
              </span>
              <input
                type="checkbox"
                checked={rdnsSkipPrivate}
                onChange={(e) => setRdnsSkipPrivate(e.target.checked)}
                className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="rdns-ttl" className="text-xs font-medium">
                Cache{' '}
                <TechTerm
                  label="TTL"
                  tip="Time To Live — how many seconds a resolved hostname stays cached before looking it up again."
                />{' '}
                (seconds)
              </label>
              <input
                id="rdns-ttl"
                type="number"
                min={60}
                max={86400}
                value={rdnsTtlSec}
                onChange={(e) => setRdnsTtlSec(Number(e.target.value) || 3600)}
                className="w-28 app-input border rounded-xl px-3 py-1.5 text-xs font-mono tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="pt-2 border-t app-border flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-mono app-text-muted tabular-nums">
              Cached: {serverStats.rdnsCacheSize} · Hits: {serverStats.rdnsHits} · Misses:{' '}
              {serverStats.rdnsMisses}
            </span>
            <button
              type="button"
              onClick={onClearRdnsCache}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-row-hover text-xs font-medium transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
              Flush Cache
            </button>
          </div>
        </section>
      </div>

      {/* MaxMind GeoIP2 / GeoLite2 Database Card */}
      <section
        data-testid="maxmind-settings-card"
        className="app-surface border rounded-2xl p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>
                MaxMind IP Location &amp; Network Database (
                <TechTerm
                  label="MMDB"
                  tip="MaxMind DB binary format used by free GeoLite2-City.mmdb, GeoLite2-Country.mmdb, and GeoLite2-ASN.mmdb databases for offline IP geolocation and ISP/organization lookup."
                />
                )
              </span>
            </h2>
            <p className="text-xs app-text-muted mt-1">
              Drop <span className="font-mono app-text-secondary">GeoLite2-City.mmdb</span> (or{' '}
              <span className="font-mono app-text-secondary">GeoLite2-Country.mmdb</span>) and{' '}
              <span className="font-mono app-text-secondary">GeoLite2-ASN.mmdb</span> into the
              database folder below or upload them directly for offline city, country, and{' '}
              <TechTerm
                label="ASN"
                tip="Autonomous System Number — identifies the network operator or cloud provider (e.g. AS15169 Google LLC, AS13335 Cloudflare) owning a public IP address."
              />{' '}
              enrichment with zero external API calls.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer shrink-0 pt-0.5">
            <span>Enabled</span>
            <input
              type="checkbox"
              data-testid="geoip-enabled-toggle"
              checked={geoipEnabled}
              onChange={(e) => setGeoipEnabled(e.target.checked)}
              className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="geoip-dir-input"
                className="flex items-center gap-1.5 text-xs font-medium"
              >
                <FolderOpen className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                MaxMind Database Folder
              </label>
              {geoipDir !== '/config/geoip' && (
                <button
                  type="button"
                  onClick={() => setGeoipDir('/config/geoip')}
                  className="text-[11px] text-sky-500 hover:text-sky-400"
                >
                  Reset to /config/geoip
                </button>
              )}
            </div>
            <input
              id="geoip-dir-input"
              data-testid="geoip-dir-input"
              type="text"
              value={geoipDir}
              onChange={(e) => setGeoipDir(e.target.value)}
              placeholder="/config/geoip"
              className="w-full app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
            <p className="text-[11px] app-text-muted">
              Default: <span className="font-mono">/config/geoip</span>
              {activeGeoipDiffers && (
                <>
                  {' '}
                  · Active:{' '}
                  <span className="font-mono app-text-secondary">
                    {serverStats.geoipActiveDir}
                  </span>
                </>
              )}
            </p>
          </div>

          <div className="rounded-xl border app-border app-input p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="app-text-muted">City / Country DB</span>
              <span
                data-testid="geoip-city-status"
                className={`font-mono ${
                  serverStats.geoipCityLoaded ? 'text-emerald-500 font-medium' : 'app-text-muted'
                }`}
              >
                {serverStats.geoipCityLoaded
                  ? serverStats.geoipCityFile || 'Loaded'
                  : 'Not installed'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="app-text-muted">ASN / Organization DB</span>
              <span
                data-testid="geoip-asn-status"
                className={`font-mono ${
                  serverStats.geoipAsnLoaded ? 'text-emerald-500 font-medium' : 'app-text-muted'
                }`}
              >
                {serverStats.geoipAsnLoaded
                  ? serverStats.geoipAsnFile || 'Loaded'
                  : 'Not installed'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1.5 border-t app-border">
              <span className="app-text-muted">Cached IP Lookups</span>
              <span className="font-mono app-text-secondary tabular-nums">
                {serverStats.geoipLookups}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs min-h-[18px]">
            {geoipNotice && (
              <span className={geoipNotice.ok ? 'text-emerald-500 font-medium' : 'text-red-500'}>
                {geoipNotice.text}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mmdb"
              onChange={handleFileSelected}
              className="hidden"
              aria-label="Upload MaxMind MMDB database file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingGeoip}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover disabled:opacity-60 text-xs font-medium transition-colors"
            >
              <Upload className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
              {uploadingGeoip ? 'Uploading...' : 'Upload .mmdb File'}
            </button>
            <button
              type="button"
              data-testid="reload-geoip-btn"
              onClick={handleReloadDatabases}
              disabled={reloadingGeoip}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover disabled:opacity-60 text-xs font-medium transition-colors"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 app-text-muted ${reloadingGeoip ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Reload Databases
            </button>
          </div>
        </div>
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
          {saving ? 'Saving Settings...' : 'Save Server Settings'}
        </button>
      </div>
    </form>
  );
}
