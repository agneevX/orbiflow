import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCog,
  FolderOpen,
  Gauge,
  Globe,
  KeyRound,
  LayoutGrid,
  MonitorSmartphone,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import type {
  BandwidthUnit,
  DetectedSubnet,
  FeatureVisibility,
  PersistenceMode,
  PublicSatelliteConfig,
  SatelliteTelemetry,
  ServerConfig,
  ServerStats,
  TimeFormat,
  VlanConfig,
} from '../types/telemetry';
import { formatBytes } from '../lib/formatters';
import {
  DEFAULT_FEATURE_VISIBILITY,
  sanitizeFeatureVisibility,
  validateDnsServer,
} from '../lib/tablePreferences';
import { sanitizeVlanConfigs, validateVlanCidr } from '../lib/vlanUtils';
import { TechTerm } from './TechTerm';
import { SatelliteManager, type SatelliteSavePayload } from './SatelliteManager';

interface SettingsViewProps {
  serverConfig: ServerConfig;
  serverStats: ServerStats;
  detectedSubnets?: DetectedSubnet[];
  satellites: SatelliteTelemetry[];
  satelliteConfigs: PublicSatelliteConfig[];
  unit: BandwidthUnit;
  onChangeUnit: (u: BandwidthUnit) => void;
  onSaveSettings: (cfg: Partial<ServerConfig>) => Promise<void>;
  onSaveSatellite: (payload: SatelliteSavePayload) => Promise<{ ok: boolean; error?: string }>;
  onDeleteSatellite: (id: string) => Promise<void>;
  onTestSatellite: (
    payload: SatelliteSavePayload
  ) => Promise<{ ok: boolean; error?: string; summary?: string }>;
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
  detectedSubnets = [],
  satellites,
  satelliteConfigs,
  unit,
  onChangeUnit,
  onSaveSettings,
  onSaveSatellite,
  onDeleteSatellite,
  onTestSatellite,
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
  const [rdnsServer, setRdnsServer] = useState(serverConfig.rdnsServer || '');
  const [rdnsServerError, setRdnsServerError] = useState('');
  const [lanDnsEnabled, setLanDnsEnabled] = useState(serverConfig.lanDnsEnabled !== false);
  const [lanDnsServer, setLanDnsServer] = useState(serverConfig.lanDnsServer || '');
  const [lanDnsServerError, setLanDnsServerError] = useState('');
  const [stripLanDomain, setStripLanDomain] = useState(serverConfig.stripLanDomain !== false);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(serverConfig.timeFormat || '12h');
  const [featureVisibility, setFeatureVisibility] = useState<FeatureVisibility>(() =>
    sanitizeFeatureVisibility(serverConfig.featureVisibility)
  );
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  // VLAN editor state (managed in its own section so additions/removals save immediately)
  const [vlanNameInput, setVlanNameInput] = useState('');
  const [vlanCidrInput, setVlanCidrInput] = useState('');
  const [vlanIdInput, setVlanIdInput] = useState('');
  const [vlanError, setVlanError] = useState('');
  const [savingVlan, setSavingVlan] = useState(false);

  const configuredVlans = sanitizeVlanConfigs(serverConfig.vlans);

  // Serialize server-side config fields so periodic 3s telemetry ticks never undo unsaved checkboxes
  const serverConfigSignature = JSON.stringify({
    probeToken: serverConfig.probeToken || '',
    persistenceMode: serverConfig.persistenceMode,
    cacheDir: serverConfig.cacheDir || '/config/cache',
    inferDeviceNames: serverConfig.inferDeviceNames !== false,
    rdnsServer: serverConfig.rdnsServer || '',
    lanDnsEnabled: serverConfig.lanDnsEnabled !== false,
    lanDnsServer: serverConfig.lanDnsServer || '',
    stripLanDomain: serverConfig.stripLanDomain !== false,
    timeFormat: serverConfig.timeFormat || '12h',
    featureVisibility: sanitizeFeatureVisibility(serverConfig.featureVisibility),
  });
  const lastSyncedSigRef = useRef(serverConfigSignature);

  useEffect(() => {
    if (serverConfigSignature === lastSyncedSigRef.current) return;
    lastSyncedSigRef.current = serverConfigSignature;
    setProbeToken(serverConfig.probeToken || '');
    setPersistenceMode(serverConfig.persistenceMode);
    setCacheDir(serverConfig.cacheDir || '/config/cache');
    setInferDeviceNames(serverConfig.inferDeviceNames !== false);
    setRdnsServer(serverConfig.rdnsServer || '');
    setLanDnsEnabled(serverConfig.lanDnsEnabled !== false);
    setLanDnsServer(serverConfig.lanDnsServer || '');
    setStripLanDomain(serverConfig.stripLanDomain !== false);
    setTimeFormat(serverConfig.timeFormat || '12h');
    setFeatureVisibility(sanitizeFeatureVisibility(serverConfig.featureVisibility));
  }, [serverConfigSignature, serverConfig]);

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
    const dnsCheck = validateDnsServer(rdnsServer);
    if (!dnsCheck.ok) {
      setRdnsServerError(dnsCheck.error || 'Invalid reverse DNS server address');
      return;
    }
    const lanDnsCheck = validateDnsServer(lanDnsServer);
    if (!lanDnsCheck.ok) {
      setLanDnsServerError(lanDnsCheck.error || 'Invalid private DNS server address');
      return;
    }
    setRdnsServerError('');
    setLanDnsServerError('');
    setSaving(true);
    try {
      await onSaveSettings({
        probeToken: probeToken.trim() || serverConfig.probeToken,
        persistenceMode,
        cacheDir: cacheDir.trim() || '/config/cache',
        inferDeviceNames,
        rdnsServer: dnsCheck.value,
        lanDnsEnabled,
        lanDnsServer: lanDnsCheck.value,
        stripLanDomain,
        timeFormat,
        featureVisibility,
      });
      setSavedNotice('Settings saved to configuration file');
      setTimeout(() => setSavedNotice(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  const handleAddVlan = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = vlanNameInput.trim().slice(0, 40);
    if (!cleanName) {
      setVlanError('Enter a VLAN name (e.g. Docker Containers, IoT, Guest)');
      return;
    }
    const cidrCheck = validateVlanCidr(vlanCidrInput);
    if (!cidrCheck.ok) {
      setVlanError(cidrCheck.error || 'Invalid subnet CIDR');
      return;
    }
    let parsedVlanId: number | undefined;
    if (vlanIdInput.trim()) {
      const n = Number(vlanIdInput.trim());
      if (!Number.isInteger(n) || n < 1 || n > 4094) {
        setVlanError('VLAN ID must be an integer between 1 and 4094');
        return;
      }
      parsedVlanId = n;
    }

    setVlanError('');
    setSavingVlan(true);
    try {
      const nextEntry: VlanConfig = {
        id: `vlan-${cidrCheck.value.replace(/[^a-zA-Z0-9]/g, '-')}`,
        name: cleanName,
        cidr: cidrCheck.value,
        ...(parsedVlanId !== undefined ? { vlanId: parsedVlanId } : {}),
      };
      const nextList = [
        ...configuredVlans.filter((v) => v.cidr !== cidrCheck.value),
        nextEntry,
      ];
      await onSaveSettings({ vlans: nextList });
      setVlanNameInput('');
      setVlanCidrInput('');
      setVlanIdInput('');
    } finally {
      setSavingVlan(false);
    }
  };

  const handleRemoveVlan = async (cidr: string) => {
    setSavingVlan(true);
    try {
      const nextList = configuredVlans.filter((v) => v.cidr !== cidr);
      await onSaveSettings({ vlans: nextList });
    } finally {
      setSavingVlan(false);
    }
  };

  const activeCacheDiffers =
    serverStats.activeCacheDir &&
    cacheDir.trim() &&
    serverStats.activeCacheDir !== cacheDir.trim();

  return (
    <div className="space-y-6 max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Persistent Configuration File & Shared Router Agent Token */}
        <section className="app-surface border rounded-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 min-w-0 flex-1">
              <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                <FileCog className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
                <span>Persistent Configuration</span>
              </h2>
              <p className="text-xs app-text-muted">
                All settings, shared agent token, satellite SSH connections, device aliases, alert
                rules, and notification channels are stored in the{' '}
                <span className="font-mono app-text-secondary">/config</span>{' '}
                <TechTerm
                  label="Docker volume"
                  tip="A persistent folder mounted from your host machine into /config inside the container so settings survive restarts and image upgrades without application environment variables."
                />
                . The container only uses <span className="font-mono app-text-secondary">PUID</span>
                , <span className="font-mono app-text-secondary">PGID</span>, and{' '}
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

        {/* Public Reverse DNS & Time Display */}
        <section className="app-surface border rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold flex items-center gap-2">
              <Globe className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
              <span>Reverse DNS &amp; Display</span>
            </h2>
            <p className="text-xs app-text-muted mt-1">
              Configure reverse PTR lookups for both public internet IPs and private LAN/VLAN IPs,
              plus speed units and clock format.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="rdns-server-input"
                className="flex items-center gap-1.5 text-xs font-medium"
              >
                <Globe className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                Public Reverse DNS Server (PTR Lookups)
              </label>
              {rdnsServer && (
                <button
                  type="button"
                  onClick={() => {
                    setRdnsServer('');
                    setRdnsServerError('');
                  }}
                  className="text-[11px] text-sky-500 hover:text-sky-400"
                >
                  Use container DNS
                </button>
              )}
            </div>
            <input
              id="rdns-server-input"
              data-testid="rdns-server-input"
              type="text"
              value={rdnsServer}
              onChange={(e) => {
                setRdnsServer(e.target.value);
                if (rdnsServerError) setRdnsServerError('');
              }}
              placeholder="Container DNS default (e.g. 1.1.1.1, 8.8.8.8, or 9.9.9.9)"
              className="w-full app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
            {rdnsServerError ? (
              <p role="alert" className="text-[11px] text-rose-500 font-medium">
                {rdnsServerError}
              </p>
            ) : (
              <p className="text-[11px] app-text-muted leading-relaxed">
                Used for reverse PTR lookups of public internet IP addresses. Leave blank to use
                the container&apos;s default DNS resolver.
              </p>
            )}
          </div>

          {/* Private IP Reverse DNS (PTR Lookups) */}
          <div className="pt-3 border-t app-border space-y-3">
            <label className="flex items-start gap-3 p-3.5 rounded-xl border app-border app-input cursor-pointer">
              <input
                type="checkbox"
                data-testid="lan-dns-enabled-toggle"
                checked={lanDnsEnabled}
                onChange={(e) => setLanDnsEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
              />
              <div>
                <div className="text-xs font-semibold">
                  Resolve Reverse PTR for Private IPs (LAN &amp; VLANs)
                </div>
                <div className="text-xs app-text-muted mt-0.5">
                  Look up hostnames for private RFC1918 addresses (e.g. 10.x, 192.168.x, 172.16–31.x)
                  via reverse PTR queries. Uses the container&apos;s DNS resolver by default.
                </div>
              </div>
            </label>

            {lanDnsEnabled && (
              <div className="space-y-3 pl-1">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="lan-dns-server-input"
                      className="flex items-center gap-1.5 text-xs font-medium"
                    >
                      <Server className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                      Private Reverse DNS Server
                    </label>
                    {lanDnsServer && (
                      <button
                        type="button"
                        onClick={() => {
                          setLanDnsServer('');
                          setLanDnsServerError('');
                        }}
                        className="text-[11px] text-sky-500 hover:text-sky-400"
                      >
                        Use container DNS
                      </button>
                    )}
                  </div>
                  <input
                    id="lan-dns-server-input"
                    data-testid="lan-dns-server-input"
                    type="text"
                    value={lanDnsServer}
                    onChange={(e) => {
                      setLanDnsServer(e.target.value);
                      if (lanDnsServerError) setLanDnsServerError('');
                    }}
                    placeholder="Container DNS default (e.g. 10.0.0.1, 192.168.1.1, or Pi-hole IP)"
                    className="w-full app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                  {lanDnsServerError ? (
                    <p role="alert" className="text-[11px] text-rose-500 font-medium">
                      {lanDnsServerError}
                    </p>
                  ) : (
                    <p className="text-[11px] app-text-muted leading-relaxed">
                      Leave blank to query the container&apos;s default DNS server (
                      <span className="font-mono">/etc/resolv.conf</span>). Or enter a local router,
                      Pi-hole, or AdGuard Home IP.
                    </p>
                  )}
                </div>

                <label className="flex items-center gap-2.5 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    data-testid="strip-lan-domain-toggle"
                    checked={stripLanDomain}
                    onChange={(e) => setStripLanDomain(e.target.checked)}
                    className="h-3.5 w-3.5 rounded text-sky-500 focus:ring-sky-500"
                  />
                  <span className="app-text-secondary">
                    Strip local domain suffix (e.g. show <span className="font-mono">nas</span>{' '}
                    instead of <span className="font-mono">nas.lan</span>)
                  </span>
                </label>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono app-text-muted tabular-nums">
              <span>
                Private PTR: {serverStats.lanDnsResolved} resolved · {serverStats.lanDnsCacheSize}{' '}
                cached
              </span>
              <span>Public PTR: {serverStats.rdnsCacheSize} cached</span>
            </div>
          </div>

          <div className="pt-3 border-t app-border flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Gauge className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                <span>Speed Unit</span>
              </div>
              <p className="text-[11px] app-text-muted mt-0.5">
                Preferred throughput unit for tables, charts, and tooltips (Home Download/Upload stay in Mbps).
              </p>
            </div>
            <div
              role="group"
              aria-label="Bandwidth speed unit"
              className="grid grid-cols-2 app-input border rounded-xl p-1 w-36 shrink-0"
            >
              {(['Mbps', 'MB/s'] as BandwidthUnit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  data-testid={`settings-speed-unit-${u === 'MB/s' ? 'mbs' : 'mbps'}`}
                  aria-pressed={unit === u}
                  onClick={() => onChangeUnit(u)}
                  className={`py-1 text-xs font-mono font-medium rounded-lg transition-colors ${
                    unit === u ? 'app-surface font-semibold' : 'app-text-muted'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t app-border flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Clock className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                <span>Clock (Time Format)</span>
              </div>
              <p className="text-[11px] app-text-muted mt-0.5">
                Controls timestamps on graphs, alerts, and connection details.
              </p>
            </div>
            <div
              role="group"
              aria-label="Time display format"
              className="grid grid-cols-2 app-input border rounded-xl p-1 w-36 shrink-0"
            >
              {(['12h', '24h'] as TimeFormat[]).map((tf) => (
                <button
                  key={tf}
                  type="button"
                  data-testid={`settings-time-format-${tf}`}
                  aria-pressed={timeFormat === tf}
                  onClick={() => setTimeFormat(tf)}
                  className={`py-1 text-xs font-medium rounded-lg transition-colors ${
                    timeFormat === tf ? 'app-surface font-semibold' : 'app-text-muted'
                  }`}
                >
                  {tf === '12h' ? '12-hour' : '24-hour'}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* App Features & Sections Visibility */}
        <section
          data-testid="feature-visibility-section"
          className="app-surface border rounded-2xl p-5 space-y-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                <LayoutGrid className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
                <span>App Features &amp; Sections</span>
              </h2>
              <p className="text-xs app-text-muted mt-1">
                Disable sections or navigation pages you don&apos;t need to keep the dashboard
                focused. Home and Settings always remain accessible.
              </p>
            </div>
            {Object.values(featureVisibility).some((v) => !v) && (
              <button
                type="button"
                data-testid="feature-enable-all-btn"
                onClick={() => setFeatureVisibility({ ...DEFAULT_FEATURE_VISIBILITY })}
                className="text-[11px] font-medium text-sky-500 hover:text-sky-400 transition-colors shrink-0"
              >
                Enable all
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {(
              [
                {
                  key: 'flows',
                  label: 'Flows Diagram',
                  desc: 'Internet traffic flow diagram on Home',
                },
                {
                  key: 'topDevices',
                  label: 'Top Devices',
                  desc: 'Top local clients card on Home',
                },
                {
                  key: 'topDestinations',
                  label: 'Top Destinations',
                  desc: 'Top internet services card on Home',
                },
                {
                  key: 'trafficMap',
                  label: 'Network Map',
                  desc: 'Network Map tab inside Devices showing router, satellites & clients',
                },
                {
                  key: 'connections',
                  label: 'Connections',
                  desc: 'Live and recent connection tracking table',
                },
                {
                  key: 'devices',
                  label: 'Device List',
                  desc: 'Connected LAN devices table & custom aliases inside Devices',
                },
                {
                  key: 'alerts',
                  label: 'Alerts',
                  desc: 'Traffic alert rules, history & notifications',
                },
                {
                  key: 'agent',
                  label: 'Agent',
                  desc: 'Router probe script & SSH installer page',
                },
              ] as Array<{ key: keyof FeatureVisibility; label: string; desc: string }>
            ).map((item) => (
              <label
                key={item.key}
                className="flex items-start gap-3 p-3 rounded-xl border app-border app-input cursor-pointer"
              >
                <input
                  type="checkbox"
                  data-testid={`feature-toggle-${item.key}`}
                  checked={featureVisibility[item.key]}
                  onChange={(e) =>
                    setFeatureVisibility((prev) => ({
                      ...prev,
                      [item.key]: e.target.checked,
                    }))
                  }
                  className="mt-0.5 h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold">{item.label}</div>
                  <div className="text-[11px] app-text-muted mt-0.5 leading-snug">{item.desc}</div>
                </div>
              </label>
            ))}
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
            {saving ? 'Saving Settings...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* VLANs & Subnets Management — saves immediately outside main settings form */}
      <section
        data-testid="vlans-section"
        className="app-surface border rounded-2xl p-5 space-y-4"
      >
        <div>
          <h2 className="font-display text-sm font-semibold flex items-center gap-2">
            <Network className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
            <span>VLANs &amp; Subnets</span>
          </h2>
          <p className="text-xs app-text-muted mt-1">
            Secondary subnets (such as a Docker container VLAN like{' '}
            <span className="font-mono app-text-secondary">10.0.1.0/24</span>) are auto-detected
            from router interfaces and observed traffic. Name any subnet here to label and filter
            devices across Devices and Network Map.
          </p>
        </div>

        {/* Auto-Detected Subnets */}
        {detectedSubnets.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium app-text-muted">Detected Subnets</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {detectedSubnets.map((sub) => {
                const alreadyConfigured = configuredVlans.some((v) => v.cidr === sub.cidr);
                return (
                  <div
                    key={sub.cidr}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border app-border app-input text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono font-medium truncate">{sub.cidr}</span>
                        {sub.isPrimary && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500 shrink-0">
                            Primary
                          </span>
                        )}
                        {!sub.isPrimary && sub.vlanId !== undefined && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 shrink-0">
                            VLAN {sub.vlanId}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] app-text-muted truncate mt-0.5">
                        {sub.name || 'Unnamed subnet'} · {sub.hostCount}{' '}
                        {sub.hostCount === 1 ? 'device' : 'devices'}
                        {sub.iface ? ` · ${sub.iface}` : ''}
                      </div>
                    </div>
                    {!sub.isPrimary && !alreadyConfigured && (
                      <button
                        type="button"
                        onClick={() => {
                          setVlanCidrInput(sub.cidr);
                          setVlanIdInput(sub.vlanId !== undefined ? String(sub.vlanId) : '');
                          setVlanNameInput(
                            sub.vlanId !== undefined ? `VLAN ${sub.vlanId}` : 'Docker VLAN'
                          );
                        }}
                        className="text-[11px] font-medium text-sky-500 hover:text-sky-400 shrink-0"
                      >
                        Name
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Configured Custom VLANs */}
        {configuredVlans.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium app-text-muted">Named VLANs</div>
            <div className="divide-y app-border border app-border rounded-xl overflow-hidden">
              {configuredVlans.map((v) => (
                <div
                  key={v.cidr}
                  data-testid={`vlan-row-${v.cidr}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 app-input text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate flex items-center gap-2">
                      <span>{v.name}</span>
                      {v.vlanId !== undefined && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
                          ID {v.vlanId}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono app-text-muted">{v.cidr}</div>
                  </div>
                  <button
                    type="button"
                    disabled={savingVlan}
                    onClick={() => void handleRemoveVlan(v.cidr)}
                    aria-label={`Remove VLAN ${v.name}`}
                    className="p-1.5 rounded-lg app-text-muted hover:text-rose-500 transition-colors shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add VLAN Form */}
        <form onSubmit={handleAddVlan} className="pt-2 border-t app-border space-y-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
            <div className="sm:col-span-5">
              <label htmlFor="vlan-name-input" className="block text-[11px] app-text-muted mb-1">
                VLAN Name
              </label>
              <input
                id="vlan-name-input"
                data-testid="vlan-name-input"
                type="text"
                value={vlanNameInput}
                onChange={(e) => {
                  setVlanNameInput(e.target.value);
                  if (vlanError) setVlanError('');
                }}
                placeholder="e.g. Docker Containers"
                className="w-full app-input border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="vlan-cidr-input" className="block text-[11px] app-text-muted mb-1">
                Subnet CIDR
              </label>
              <input
                id="vlan-cidr-input"
                data-testid="vlan-cidr-input"
                type="text"
                value={vlanCidrInput}
                onChange={(e) => {
                  setVlanCidrInput(e.target.value);
                  if (vlanError) setVlanError('');
                }}
                placeholder="e.g. 10.0.1.0/24"
                className="w-full app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="vlan-id-input" className="block text-[11px] app-text-muted mb-1">
                VLAN ID (opt.)
              </label>
              <input
                id="vlan-id-input"
                data-testid="vlan-id-input"
                type="number"
                min={1}
                max={4094}
                value={vlanIdInput}
                onChange={(e) => {
                  setVlanIdInput(e.target.value);
                  if (vlanError) setVlanError('');
                }}
                placeholder="10"
                className="w-full app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {vlanError && (
            <p role="alert" className="text-[11px] text-rose-500 font-medium">
              {vlanError}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="vlan-add-btn"
              disabled={savingVlan}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl app-btn-primary text-xs font-semibold disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{savingVlan ? 'Saving...' : 'Add / Update VLAN'}</span>
            </button>
          </div>
        </form>
      </section>

      {/* Orbi Satellites (Stateless SSH Polling) — separate from main settings form so nested forms never occur */}
      <section className="app-surface border rounded-2xl p-5 space-y-4">
        <h2 className="font-display text-sm font-semibold flex items-center gap-2">
          <Radio className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
          <span>Orbi Satellites (Stateless SSH)</span>
        </h2>
        <SatelliteManager
          configs={satelliteConfigs}
          satellites={satellites}
          unit={unit}
          onSaveSatellite={onSaveSatellite}
          onDeleteSatellite={onDeleteSatellite}
          onTestSatellite={onTestSatellite}
        />
      </section>
    </div>
  );
}
