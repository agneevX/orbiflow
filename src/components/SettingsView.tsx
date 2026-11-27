import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
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

type SettingsSectionId = 'general' | 'dns' | 'network' | 'system';

interface LanDnsTestResult {
  ok: boolean;
  ip: string;
  hostname: string | null;
  strippedHostname: string | null;
  method: 'custom-dns' | 'container-dns' | 'os-nss' | 'router-fallback' | 'none';
  server: string;
  latencyMs: number;
  error?: string;
}

interface SettingsViewProps {
  serverConfig: ServerConfig;
  serverStats: ServerStats;
  detectedSubnets?: DetectedSubnet[];
  sampleHostIp?: string;
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

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  subtitle: string;
  icon: typeof SlidersHorizontal;
}> = [
  {
    id: 'general',
    label: 'General',
    subtitle: 'Display units, naming, and visible sections',
    icon: SlidersHorizontal,
  },
  {
    id: 'dns',
    label: 'DNS & Hostnames',
    subtitle: 'Private LAN/VLAN and public reverse PTR lookups',
    icon: Globe,
  },
  {
    id: 'network',
    label: 'Network & Mesh',
    subtitle: 'VLAN subnets and Orbi SSH satellites',
    icon: Network,
  },
  {
    id: 'system',
    label: 'Storage & Agent',
    subtitle: 'Agent token, traffic history cache, and config file',
    icon: Database,
  },
];

const FEATURE_ITEMS: Array<{ key: keyof FeatureVisibility; label: string; desc: string }> = [
  { key: 'flows', label: 'Flows Diagram', desc: 'Live internet traffic flow paths on Home' },
  { key: 'topDevices', label: 'Top Devices', desc: 'Top active local clients card on Home' },
  {
    key: 'topDestinations',
    label: 'Top Destinations',
    desc: 'Top internet services card on Home',
  },
  {
    key: 'trafficMap',
    label: 'Network Map',
    desc: 'Interactive topology view inside Devices',
  },
  {
    key: 'connections',
    label: 'Connections',
    desc: 'Live and recent connection tracking table',
  },
  {
    key: 'devices',
    label: 'Device List',
    desc: 'Connected LAN devices table & custom aliases',
  },
  { key: 'alerts', label: 'Alerts', desc: 'Traffic alert rules, history & notifications' },
  { key: 'agent', label: 'Agent', desc: 'Router probe script & SSH installer page' },
];

const DNS_METHOD_LABELS: Record<LanDnsTestResult['method'], string> = {
  'custom-dns': 'Custom DNS',
  'container-dns': 'Container DNS',
  'os-nss': 'OS /etc/hosts',
  'router-fallback': 'Router gateway fallback',
  none: 'Unresolved',
};

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
  sampleHostIp,
  satellites,
  satelliteConfigs,
  unit,
  onChangeUnit,
  onSaveSettings,
  onSaveSatellite,
  onDeleteSatellite,
  onTestSatellite,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');

  // Form-backed server settings state
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

  // Diagnostic Reverse DNS test state
  const [dnsTestIp, setDnsTestIp] = useState(sampleHostIp || '');
  const [dnsTesting, setDnsTesting] = useState(false);
  const [dnsTestResult, setDnsTestResult] = useState<LanDnsTestResult | null>(null);

  // VLAN editor state (saves immediately in Network & Mesh section)
  const [vlanNameInput, setVlanNameInput] = useState('');
  const [vlanCidrInput, setVlanCidrInput] = useState('');
  const [vlanIdInput, setVlanIdInput] = useState('');
  const [vlanError, setVlanError] = useState('');
  const [savingVlan, setSavingVlan] = useState(false);

  const configuredVlans = sanitizeVlanConfigs(serverConfig.vlans);

  useEffect(() => {
    if (!dnsTestIp && sampleHostIp) {
      setDnsTestIp(sampleHostIp);
    }
  }, [sampleHostIp, dnsTestIp]);

  // Serialize server-side config fields so periodic 3s telemetry ticks never undo unsaved edits
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

  const currentFormSignature = useMemo(
    () =>
      JSON.stringify({
        probeToken,
        persistenceMode,
        cacheDir,
        inferDeviceNames,
        rdnsServer,
        lanDnsEnabled,
        lanDnsServer,
        stripLanDomain,
        timeFormat,
        featureVisibility: sanitizeFeatureVisibility(featureVisibility),
      }),
    [
      probeToken,
      persistenceMode,
      cacheDir,
      inferDeviceNames,
      rdnsServer,
      lanDnsEnabled,
      lanDnsServer,
      stripLanDomain,
      timeFormat,
      featureVisibility,
    ]
  );

  const isDirty = currentFormSignature !== serverConfigSignature;

  const handleResetChanges = () => {
    setProbeToken(serverConfig.probeToken || '');
    setPersistenceMode(serverConfig.persistenceMode);
    setCacheDir(serverConfig.cacheDir || '/config/cache');
    setInferDeviceNames(serverConfig.inferDeviceNames !== false);
    setRdnsServer(serverConfig.rdnsServer || '');
    setRdnsServerError('');
    setLanDnsEnabled(serverConfig.lanDnsEnabled !== false);
    setLanDnsServer(serverConfig.lanDnsServer || '');
    setLanDnsServerError('');
    setStripLanDomain(serverConfig.stripLanDomain !== false);
    setTimeFormat(serverConfig.timeFormat || '12h');
    setFeatureVisibility(sanitizeFeatureVisibility(serverConfig.featureVisibility));
  };

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
      setActiveSection('dns');
      return;
    }
    const lanDnsCheck = validateDnsServer(lanDnsServer);
    if (!lanDnsCheck.ok) {
      setLanDnsServerError(lanDnsCheck.error || 'Invalid private DNS server address');
      setActiveSection('dns');
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
      setSavedNotice('Settings saved');
      setTimeout(() => setSavedNotice(''), 2800);
    } finally {
      setSaving(false);
    }
  };

  const handleTestLanDns = async () => {
    const targetIp = dnsTestIp.trim();
    if (!targetIp) {
      setDnsTestResult({
        ok: false,
        ip: '',
        hostname: null,
        strippedHostname: null,
        method: 'none',
        server: lanDnsServer.trim() || 'container DNS',
        latencyMs: 0,
        error: 'Enter a LAN IP address to test (e.g. 192.168.1.1)',
      });
      return;
    }

    const serverCheck = validateDnsServer(lanDnsServer);
    if (!serverCheck.ok) {
      setLanDnsServerError(serverCheck.error || 'Invalid private DNS server address');
      return;
    }

    setDnsTesting(true);
    setDnsTestResult(null);
    try {
      const resp = await fetch('/api/dns/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: targetIp,
          server: serverCheck.value,
        }),
      });
      const data = (await resp.json()) as LanDnsTestResult;
      setDnsTestResult(data);
    } catch {
      setDnsTestResult({
        ok: false,
        ip: targetIp,
        hostname: null,
        strippedHostname: null,
        method: 'none',
        server: lanDnsServer.trim() || 'container DNS',
        latencyMs: 0,
        error: 'Failed to reach server DNS test endpoint',
      });
    } finally {
      setDnsTesting(false);
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

  const currentMeta =
    SETTINGS_SECTIONS.find((s) => s.id === activeSection) || SETTINGS_SECTIONS[0];

  return (
    <div className="max-w-5xl flex flex-col md:flex-row gap-6 items-start">
      {/* Left Settings Category Navigation (Horizontal bar on mobile, vertical rail on desktop) */}
      <nav
        aria-label="Settings sections"
        className="w-full md:w-52 shrink-0 flex md:flex-col gap-1 overflow-x-auto pb-1 md:pb-0 md:sticky md:top-20"
      >
        {SETTINGS_SECTIONS.map((sec) => {
          const Icon = sec.icon;
          const isActive = activeSection === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              data-testid={`settings-nav-${sec.id}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setActiveSection(sec.id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-colors whitespace-nowrap shrink-0 md:w-full text-left ${
                isActive
                  ? 'app-surface border app-border font-semibold'
                  : 'app-text-muted hover:opacity-100 app-row-hover border border-transparent font-medium'
              }`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${isActive ? 'text-sky-500' : 'app-text-muted'}`}
                aria-hidden="true"
              />
              <span>{sec.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Main Single-Elevation Settings Surface */}
      <div className="flex-1 min-w-0 w-full app-surface border rounded-2xl overflow-hidden">
        {/* Active Section Header */}
        <header className="px-5 sm:px-6 py-4 border-b app-border flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight">
              {currentMeta.label}
            </h2>
            <p className="text-xs app-text-muted mt-0.5">{currentMeta.subtitle}</p>
          </div>
          {activeSection === 'network' && (
            <span className="text-[11px] app-text-muted">Changes save automatically</span>
          )}
        </header>

        {/* Form-Backed Sections: General, DNS & Hostnames, Storage & Agent */}
        {activeSection !== 'network' ? (
          <form onSubmit={handleSubmit}>
            {/* GENERAL SECTION */}
            {activeSection === 'general' && (
              <div className="divide-y app-border">
                {/* Speed Unit Row */}
                <div className="px-5 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Speed Unit</div>
                    <p className="text-xs app-text-muted mt-0.5">
                      Throughput unit for tables, charts, and tooltips (Home Download/Upload stay in
                      Mbps).
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

                {/* Clock Format Row */}
                <div className="px-5 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Clock Format</div>
                    <p className="text-xs app-text-muted mt-0.5">
                      Controls timestamps across graphs, alerts, and connection details.
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

                {/* Inferred Device Names Row */}
                <label className="px-5 sm:px-6 py-4 flex items-start sm:items-center justify-between gap-4 cursor-pointer">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Inferred Device Names</div>
                    <p className="text-xs app-text-muted mt-0.5">
                      Infer device types (for example, Apple Device or Gaming Device) from active
                      traffic when no alias, reverse DNS, or DHCP hostname is available.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="infer-device-names-toggle"
                    checked={inferDeviceNames}
                    onChange={(e) => setInferDeviceNames(e.target.checked)}
                    className="mt-1 sm:mt-0 h-4 w-4 rounded text-sky-500 focus:ring-sky-500 shrink-0"
                  />
                </label>

                {/* App Features & Sections */}
                <div data-testid="feature-visibility-section" className="px-5 sm:px-6 py-5 space-y-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">Dashboard Sections</h3>
                      <p className="text-xs app-text-muted mt-0.5">
                        Hide panels or navigation tabs you do not need. Home and Settings always
                        stay accessible.
                      </p>
                    </div>
                    {Object.values(featureVisibility).some((v) => !v) && (
                      <button
                        type="button"
                        data-testid="feature-enable-all-btn"
                        onClick={() => setFeatureVisibility({ ...DEFAULT_FEATURE_VISIBILITY })}
                        className="text-xs font-medium text-sky-500 hover:text-sky-400 transition-colors shrink-0"
                      >
                        Enable all
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 divide-y sm:divide-y-0 app-border pt-1">
                    {FEATURE_ITEMS.map((item) => (
                      <label
                        key={item.key}
                        className="flex items-start justify-between gap-3 py-2.5 sm:border-b app-border cursor-pointer"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium">{item.label}</div>
                          <div className="text-[11px] app-text-muted mt-0.5 leading-snug">
                            {item.desc}
                          </div>
                        </div>
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
                          className="mt-0.5 h-4 w-4 rounded text-sky-500 focus:ring-sky-500 shrink-0"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* DNS & HOSTNAMES SECTION */}
            {activeSection === 'dns' && (
              <div className="divide-y app-border">
                {/* Private Reverse DNS (LAN & VLANs) */}
                <div className="px-5 sm:px-6 py-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium">Private Reverse DNS (LAN &amp; VLANs)</h3>
                      <p className="text-xs app-text-muted mt-0.5">
                        Resolve hostnames for private RFC1918 addresses (10.x, 192.168.x, 172.16–31.x)
                        via PTR queries. Defaults to container DNS with automatic OS and router
                        gateway fallback.
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Enable private reverse DNS for LAN and VLANs"
                      data-testid="lan-dns-enabled-toggle"
                      checked={lanDnsEnabled}
                      onChange={(e) => setLanDnsEnabled(e.target.checked)}
                      className="mt-1 h-4 w-4 rounded text-sky-500 focus:ring-sky-500 shrink-0"
                    />
                  </div>

                  {lanDnsEnabled && (
                    <div className="space-y-4 pt-1">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label
                            htmlFor="lan-dns-server-input"
                            className="text-xs font-medium app-text-secondary"
                          >
                            Private DNS Server (optional)
                          </label>
                          {lanDnsServer && (
                            <button
                              type="button"
                              onClick={() => {
                                setLanDnsServer('');
                                setLanDnsServerError('');
                              }}
                              className="text-xs text-sky-500 hover:text-sky-400"
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
                          placeholder="Container DNS default (or e.g. 192.168.1.1, 10.0.0.1, Pi-hole IP)"
                          className="w-full app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
                        />
                        {lanDnsServerError ? (
                          <p role="alert" className="text-xs text-rose-500 font-medium">
                            {lanDnsServerError}
                          </p>
                        ) : (
                          <p className="text-[11px] app-text-muted leading-relaxed">
                            Leave blank to query container DNS (<span className="font-mono">/etc/resolv.conf</span>),
                            OS <span className="font-mono">/etc/hosts</span>, and your auto-detected
                            router gateway. Enter your router, Pi-hole, or AdGuard Home IP to query
                            it directly.
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
                          Strip local domain suffix (show <span className="font-mono">nas</span>{' '}
                          instead of <span className="font-mono">nas.lan</span>)
                        </span>
                      </label>

                      {/* Inline Live Reverse DNS Test */}
                      <div className="pt-3 border-t app-border space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label
                            htmlFor="dns-test-ip-input"
                            className="text-xs font-medium app-text-secondary"
                          >
                            Test Reverse DNS Lookup
                          </label>
                          <span className="text-[11px] font-mono app-text-muted tabular-nums">
                            {serverStats.lanDnsResolved} resolved · {serverStats.lanDnsCacheSize}{' '}
                            cached
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id="dns-test-ip-input"
                            data-testid="dns-test-ip-input"
                            type="text"
                            value={dnsTestIp}
                            onChange={(e) => setDnsTestIp(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleTestLanDns();
                              }
                            }}
                            placeholder="192.168.1.1"
                            className="flex-1 min-w-0 app-input border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
                          />
                          <button
                            type="button"
                            data-testid="dns-test-btn"
                            disabled={dnsTesting}
                            onClick={() => void handleTestLanDns()}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border app-border app-row-hover text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-50 transition-colors"
                          >
                            {dnsTesting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Search className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                            )}
                            <span>{dnsTesting ? 'Testing...' : 'Test Lookup'}</span>
                          </button>
                        </div>

                        {dnsTestResult && (
                          <div
                            data-testid="dns-test-result"
                            className={`text-xs flex items-start gap-2 pt-0.5 ${
                              dnsTestResult.ok ? 'text-emerald-500' : 'text-amber-500'
                            }`}
                          >
                            {dnsTestResult.ok ? (
                              <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <AlertCircle
                                className="h-3.5 w-3.5 mt-0.5 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <div className="min-w-0 space-y-0.5">
                              {dnsTestResult.ok ? (
                                <div className="font-medium">
                                  Resolved to{' '}
                                  <span className="font-mono">
                                    {dnsTestResult.strippedHostname || dnsTestResult.hostname}
                                  </span>
                                  {dnsTestResult.hostname &&
                                    dnsTestResult.strippedHostname &&
                                    dnsTestResult.hostname !== dnsTestResult.strippedHostname && (
                                      <span className="font-mono app-text-muted font-normal">
                                        {' '}
                                        ({dnsTestResult.hostname})
                                      </span>
                                    )}
                                </div>
                              ) : (
                                <div className="font-medium">
                                  {dnsTestResult.error || 'No PTR record found'}
                                </div>
                              )}
                              <div className="text-[11px] font-mono app-text-muted tabular-nums">
                                {DNS_METHOD_LABELS[dnsTestResult.method]} · {dnsTestResult.server} ·{' '}
                                {dnsTestResult.latencyMs}ms
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Public Reverse DNS (Internet IPs) */}
                <div className="px-5 sm:px-6 py-5 space-y-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">Public Reverse DNS (Internet IPs)</h3>
                      <p className="text-xs app-text-muted mt-0.5">
                        Used to identify remote internet services and CDN endpoints.
                      </p>
                    </div>
                    <span className="text-[11px] font-mono app-text-muted tabular-nums">
                      {serverStats.rdnsCacheSize} cached
                    </span>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="rdns-server-input"
                        className="text-xs font-medium app-text-secondary"
                      >
                        Public DNS Server (optional)
                      </label>
                      {rdnsServer && (
                        <button
                          type="button"
                          onClick={() => {
                            setRdnsServer('');
                            setRdnsServerError('');
                          }}
                          className="text-xs text-sky-500 hover:text-sky-400"
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
                    {rdnsServerError && (
                      <p role="alert" className="text-xs text-rose-500 font-medium">
                        {rdnsServerError}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* STORAGE & AGENT SECTION */}
            {activeSection === 'system' && (
              <div className="divide-y app-border">
                {/* Shared Router Agent Token */}
                <div className="px-5 sm:px-6 py-5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <label htmlFor="probe-token-input" className="text-sm font-medium block">
                        Shared Router Agent Token
                      </label>
                      <p className="text-xs app-text-muted mt-0.5">
                        Authenticates snapshots sent via{' '}
                        <span className="font-mono app-text-secondary">X-Probe-Token</span> and
                        syncs with scripts in the Agent tab.
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid="regenerate-token-btn"
                      onClick={handleGenerateToken}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-500 hover:text-sky-400 transition-colors shrink-0"
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                      <span>Regenerate</span>
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
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
                      className="inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-row-hover transition-colors shrink-0"
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
                      className="inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-row-hover transition-colors shrink-0"
                    >
                      {copiedToken ? (
                        <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                      ) : (
                        <Copy className="h-4 w-4 app-text-muted" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Traffic History Storage */}
                <div className="px-5 sm:px-6 py-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium">Traffic History Storage</h3>
                      <p className="text-xs app-text-muted mt-0.5">
                        {persistenceMode === 'memory' ? (
                          <>
                            Keeps high-res samples and 6-hour summaries in RAM with zero disk
                            writes. Settings in <span className="font-mono">config.json</span>{' '}
                            always persist.
                          </>
                        ) : (
                          <>
                            Saves history and auto-rotated{' '}
                            <TechTerm
                              label="JSONL"
                              tip="JSON Lines — an append-only text format storing one timestamped snapshot per line, rotated automatically above 5 MB."
                            />{' '}
                            logs to disk so charts stay populated across restarts.
                          </>
                        )}
                      </p>
                    </div>
                    <div
                      role="group"
                      aria-label="Traffic history storage mode"
                      className="grid grid-cols-2 app-input border rounded-xl p-1 w-48 shrink-0"
                    >
                      {(
                        [
                          { id: 'memory', label: 'Memory Only' },
                          { id: 'disk', label: 'Disk Cache' },
                        ] as Array<{ id: PersistenceMode; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={persistenceMode === opt.id}
                          onClick={() => setPersistenceMode(opt.id)}
                          className={`py-1 text-xs font-medium rounded-lg transition-colors ${
                            persistenceMode === opt.id ? 'app-surface font-semibold' : 'app-text-muted'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="cache-dir-input"
                        className="text-xs font-medium app-text-secondary"
                      >
                        Disk Storage Location
                      </label>
                      {cacheDir !== '/config/cache' && (
                        <button
                          type="button"
                          onClick={() => setCacheDir('/config/cache')}
                          className="text-xs text-sky-500 hover:text-sky-400"
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
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono app-text-muted tabular-nums">
                      <span>
                        {activeCacheDiffers
                          ? `Active: ${serverStats.activeCacheDir}`
                          : 'Default: /config/cache'}
                      </span>
                      <span>
                        {serverStats.persistedSnapshots} snapshots ·{' '}
                        {formatBytes(serverStats.diskLogSizeBytes)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Configuration File */}
                <div className="px-5 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Configuration File</div>
                    <p className="text-xs app-text-muted mt-0.5">
                      Stored on the{' '}
                      <TechTerm
                        label="/config volume"
                        tip="A persistent host folder mounted into /config so settings, aliases, satellites, and alert rules survive container upgrades. Runs non-root using PUID, PGID, and TZ."
                      />
                      . Container uses only <span className="font-mono">PUID</span>,{' '}
                      <span className="font-mono">PGID</span>, and{' '}
                      <span className="font-mono">TZ</span>.
                    </p>
                  </div>
                  <div
                    data-testid="config-file-path"
                    className="font-mono text-xs app-text-secondary shrink-0"
                  >
                    {serverStats.configPath}
                  </div>
                </div>
              </div>
            )}

            {/* Sticky / Bottom Action Bar for Form-Backed Sections */}
            <footer className="px-5 sm:px-6 py-3.5 border-t app-border flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs min-h-[18px]">
                {savedNotice ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-500">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {savedNotice}
                  </span>
                ) : isDirty ? (
                  <span className="text-amber-500 font-medium">Unsaved changes</span>
                ) : (
                  <span className="app-text-muted">All changes saved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isDirty && (
                  <button
                    type="button"
                    onClick={handleResetChanges}
                    className="px-3 py-1.5 rounded-xl border app-border app-row-hover text-xs font-medium transition-colors"
                  >
                    Discard
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-1.5 rounded-xl app-btn-primary disabled:opacity-60 text-xs font-semibold transition-colors"
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </footer>
          </form>
        ) : (
          /* NETWORK & MESH SECTION (auto-saving VLANs & Satellites outside main form) */
          <div className="divide-y app-border">
            {/* VLANs & Subnets */}
            <div data-testid="vlans-section" className="px-5 sm:px-6 py-5 space-y-4">
              <div>
                <h3 className="text-sm font-medium">VLANs &amp; Subnets</h3>
                <p className="text-xs app-text-muted mt-0.5">
                  Secondary subnets (such as a Docker VLAN like{' '}
                  <span className="font-mono app-text-secondary">10.0.1.0/24</span>) are
                  auto-detected from router interfaces and traffic. Name any subnet to label and
                  filter devices.
                </p>
              </div>

              {detectedSubnets.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium app-text-muted">Detected Subnets</div>
                  <div className="divide-y app-border border-y app-border">
                    {detectedSubnets.map((sub) => {
                      const alreadyConfigured = configuredVlans.some((v) => v.cidr === sub.cidr);
                      return (
                        <div
                          key={sub.cidr}
                          className="flex items-center justify-between gap-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono font-medium truncate">{sub.cidr}</span>
                              {sub.isPrimary && (
                                <span className="text-[11px] font-medium text-emerald-500 shrink-0">
                                  Primary
                                </span>
                              )}
                              {!sub.isPrimary && sub.vlanId !== undefined && (
                                <span className="text-[11px] font-mono app-text-muted shrink-0">
                                  VLAN {sub.vlanId}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] app-text-muted truncate mt-0.5 tabular-nums">
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
                              className="text-xs font-medium text-sky-500 hover:text-sky-400 shrink-0"
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

              {configuredVlans.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium app-text-muted">Named VLANs</div>
                  <div className="divide-y app-border border-y app-border">
                    {configuredVlans.map((v) => (
                      <div
                        key={v.cidr}
                        data-testid={`vlan-row-${v.cidr}`}
                        className="flex items-center justify-between gap-3 py-2.5 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium truncate flex items-center gap-2">
                            <span>{v.name}</span>
                            {v.vlanId !== undefined && (
                              <span className="text-[11px] font-mono app-text-muted">
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

              {/* Add VLAN Inline Form */}
              <form onSubmit={handleAddVlan} className="space-y-3 pt-1">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-5">
                    <label
                      htmlFor="vlan-name-input"
                      className="block text-[11px] app-text-muted mb-1"
                    >
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
                    <label
                      htmlFor="vlan-cidr-input"
                      className="block text-[11px] app-text-muted mb-1"
                    >
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
                    <label
                      htmlFor="vlan-id-input"
                      className="block text-[11px] app-text-muted mb-1"
                    >
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
                  <p role="alert" className="text-xs text-rose-500 font-medium">
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
            </div>

            {/* Orbi Satellites (Stateless SSH) */}
            <div className="px-5 sm:px-6 py-5 space-y-3">
              <h3 className="text-sm font-medium">Orbi Satellites (Stateless SSH)</h3>
              <SatelliteManager
                configs={satelliteConfigs}
                satellites={satellites}
                unit={unit}
                onSaveSatellite={onSaveSatellite}
                onDeleteSatellite={onDeleteSatellite}
                onTestSatellite={onTestSatellite}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
