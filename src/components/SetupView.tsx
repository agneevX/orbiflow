import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Terminal,
  Upload,
} from 'lucide-react';
import {
  generateBusyBoxAshProbe,
  generateCProbeSource,
  generateDockerCompose,
  generateInitScript,
  generatePythonProbe,
} from '../lib/probeTemplates';
import { TechTerm } from './TechTerm';

type ArtifactTab = 'python' | 'ash' | 'c' | 'init' | 'docker';

const ARTIFACT_META: Array<{
  id: ArtifactTab;
  label: string;
  filename: string;
  summary: string;
}> = [
  {
    id: 'python',
    label: 'Python 3 WebSocket',
    filename: 'orbi_probe.py',
    summary:
      'Recommended for Linux routers with Python 3 (including Entware python3-light). Polls WAN traffic every 3s, refreshes router uptime/load every 30s, and supports -d (silent background daemon) plus logging flags.',
  },
  {
    id: 'ash',
    label: 'BusyBox Shell (Zero Deps)',
    filename: 'orbi-probe.sh',
    summary:
      'Runs on minimal BusyBox routers without installing Python. Streams active /proc/net/nf_conntrack flows and interface byte counters via awk & curl.',
  },
  {
    id: 'c',
    label: 'Native C Source',
    filename: 'orbi-wan-probe.c',
    summary:
      'Ultra-lightweight (<1.2 MB RSS) C source you can cross-compile for your router architecture for minimal CPU impact.',
  },
  {
    id: 'init',
    label: 'Router Init Service',
    filename: 'S99orbi-probe',
    summary:
      'Autostart daemon script for /opt/etc/init.d/S99orbi-probe so the agent launches automatically after a router reboot.',
  },
  {
    id: 'docker',
    label: 'Docker Compose',
    filename: 'docker-compose.yml',
    summary:
      'Runs the OrbiFlow server in Docker as non-root (PUID/PGID) with persistent /config volume storage for config.json and optional disk cache.',
  },
];

interface DeployResponse {
  ok: boolean;
  error?: string;
  message?: string;
  steps?: string[];
  remotePath?: string;
  pid?: number;
}

interface SetupViewProps {
  defaultToken?: string;
  defaultDhcpLeasesPath?: string;
}

async function copyTextReliable(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy textarea selection fallback (needed in iframes / non-HTTPS LAN origins)
    }
  }

  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  textarea.remove();
  if (selection && prevRange) {
    selection.removeAllRanges();
    selection.addRange(prevRange);
  }
  return ok;
}

export function SetupView({
  defaultToken = '',
  defaultDhcpLeasesPath = '',
}: SetupViewProps) {
  const defaultHost =
    typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? window.location.hostname
      : '192.168.1.10';

  const [serverHost, setServerHost] = useState(defaultHost);
  const [serverPort, setServerPort] = useState('3000');
  const [token, setToken] = useState(defaultToken);
  const [iface, setIface] = useState('eth0');
  const [intervalSec, setIntervalSec] = useState('3');
  const [dhcpLeasesPath, setDhcpLeasesPath] = useState(defaultDhcpLeasesPath);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactTab>('python');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // SSH remote update & restart form state (credentials kept in memory only, never saved)
  const [sshHost, setSshHost] = useState('192.168.1.1');
  const [sshPort, setSshPort] = useState('22');
  const [sshUsername, setSshUsername] = useState('root');
  const [sshAuthMethod, setSshAuthMethod] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [remotePath, setRemotePath] = useState('/opt/bin/orbi_probe.py');
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  useEffect(() => {
    setToken(defaultToken);
  }, [defaultToken]);

  useEffect(() => {
    setDhcpLeasesPath(defaultDhcpLeasesPath);
  }, [defaultDhcpLeasesPath]);

  const probeCfg = useMemo(
    () => ({
      wsUrl: `ws://${serverHost}:${serverPort}/ws/ingest`,
      httpUrl: `http://${serverHost}:${serverPort}/api/ingest`,
      token,
      iface,
      intervalSec: Math.max(1, Number(intervalSec) || 3),
      probeId: `router-${iface || 'wan'}`,
      dhcpLeasesPath: dhcpLeasesPath.trim(),
    }),
    [serverHost, serverPort, token, iface, intervalSec, dhcpLeasesPath]
  );

  const currentContent = useMemo(() => {
    switch (activeArtifact) {
      case 'python':
        return generatePythonProbe(probeCfg);
      case 'ash':
        return generateBusyBoxAshProbe(probeCfg);
      case 'c':
        return generateCProbeSource(probeCfg);
      case 'init':
        return generateInitScript(probeCfg);
      case 'docker':
        return generateDockerCompose(probeCfg);
    }
  }, [activeArtifact, probeCfg]);

  const currentMeta = ARTIFACT_META.find((m) => m.id === activeArtifact)!;

  const handleCopy = async () => {
    const ok = await copyTextReliable(currentContent);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2400);
  };

  const handleDownload = () => {
    const blob = new Blob([currentContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentMeta.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDeployToRouter = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeploying(true);
    setDeployResult(null);

    try {
      const res = await fetch('/api/probe/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: sshHost.trim(),
          port: Number(sshPort) || 22,
          username: sshUsername.trim() || 'root',
          authMethod: sshAuthMethod,
          password: sshAuthMethod === 'password' ? sshPassword : undefined,
          privateKey: sshAuthMethod === 'key' ? sshPrivateKey : undefined,
          remotePath: remotePath.trim() || '/opt/bin/orbi_probe.py',
          restartAgent: restartAfterUpdate,
          wsUrl: probeCfg.wsUrl,
          httpUrl: probeCfg.httpUrl,
          token: probeCfg.token,
          iface: probeCfg.iface,
          intervalSec: probeCfg.intervalSec,
          probeId: probeCfg.probeId,
          dhcpLeasesPath: probeCfg.dhcpLeasesPath,
        }),
      });
      const data = (await res.json().catch(() => ({
        ok: false,
        error: 'Unable to parse server response',
      }))) as DeployResponse;
      setDeployResult(data);
    } catch {
      setDeployResult({
        ok: false,
        error: 'Network error communicating with OrbiFlow server.',
      });
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Architecture & Config Form */}
      <section className="app-surface border rounded-2xl p-5 space-y-5">
        <div>
          <h2 className="font-display text-base font-semibold">Router Agent Configuration</h2>
          <p className="text-xs app-text-muted mt-1 max-w-2xl">
            Works on any Linux-based router with shell access. Reads kernel{' '}
            <TechTerm
              label="/proc/net/nf_conntrack"
              tip="Linux kernel connection tracking table listing every active network session passing through your router."
              className="font-mono app-text-secondary"
            />{' '}
            &amp;{' '}
            <span className="font-mono app-text-secondary">/sys/class/net/{iface}/statistics</span>{' '}
            every {probeCfg.intervalSec}s with minimal CPU overhead.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label htmlFor="cfg-host" className="block text-xs app-text-muted mb-1.5">
              Server LAN IP
            </label>
            <input
              id="cfg-host"
              type="text"
              value={serverHost}
              onChange={(e) => setServerHost(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label htmlFor="cfg-port" className="block text-xs app-text-muted mb-1.5">
              Collector Port
            </label>
            <input
              id="cfg-port"
              type="text"
              value={serverPort}
              onChange={(e) => setServerPort(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label htmlFor="cfg-iface" className="block text-xs app-text-muted mb-1.5">
              <TechTerm
                label="WAN Interface"
                tip="The Linux network interface connected to your ISP modem (commonly eth0, wan, or ppp0)."
              />
            </label>
            <input
              id="cfg-iface"
              type="text"
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label htmlFor="cfg-interval" className="block text-xs app-text-muted mb-1.5">
              Poll Interval (sec)
            </label>
            <input
              id="cfg-interval"
              type="number"
              min={1}
              max={60}
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label htmlFor="cfg-dhcp-leases" className="block text-xs app-text-muted mb-1.5">
              DHCP Leases File
            </label>
            <input
              id="cfg-dhcp-leases"
              data-testid="setup-dhcp-leases-input"
              type="text"
              value={dhcpLeasesPath}
              onChange={(e) => setDhcpLeasesPath(e.target.value)}
              placeholder="Auto-detect (/tmp/dhcp.leases)"
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label htmlFor="cfg-token" className="block text-xs app-text-muted mb-1.5">
              Shared Agent Token
            </label>
            <input
              id="cfg-token"
              data-testid="setup-token-input"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
      </section>

      {/* Direct SSH Update & Restart on Router */}
      <section
        data-testid="router-ssh-deploy-section"
        className="app-surface border rounded-2xl p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-sky-500" aria-hidden="true" />
              <h2 className="font-display text-sm font-semibold">
                Update Script &amp; Restart Router Agent via SSH
              </h2>
            </div>
            <p className="text-xs app-text-muted mt-1 max-w-2xl">
              Sign in directly to your Orbi router over SSH to upload the generated{' '}
              <span className="font-mono app-text-secondary">orbi_probe.py</span> with your
              settings above and restart the background daemon. Credentials are used only for this
              action and are never stored.
            </p>
          </div>
        </div>

        <form onSubmit={handleDeployToRouter} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label htmlFor="ssh-host" className="block text-xs app-text-muted mb-1.5">
                Router IP / Hostname
              </label>
              <input
                id="ssh-host"
                data-testid="ssh-deploy-host"
                type="text"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                placeholder="192.168.1.1"
                required
                className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="ssh-port" className="block text-xs app-text-muted mb-1.5">
                SSH Port
              </label>
              <input
                id="ssh-port"
                data-testid="ssh-deploy-port"
                type="number"
                min={1}
                max={65535}
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="ssh-username" className="block text-xs app-text-muted mb-1.5">
                SSH Username
              </label>
              <input
                id="ssh-username"
                data-testid="ssh-deploy-username"
                type="text"
                value={sshUsername}
                onChange={(e) => setSshUsername(e.target.value)}
                placeholder="root"
                required
                className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="ssh-remote-path" className="block text-xs app-text-muted mb-1.5">
                Remote Script Path
              </label>
              <input
                id="ssh-remote-path"
                data-testid="ssh-deploy-path"
                type="text"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="/opt/bin/orbi_probe.py"
                required
                className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
            <div>
              <span className="block text-xs app-text-muted mb-1.5">Authentication Method</span>
              <div
                role="group"
                aria-label="SSH authentication method"
                className="grid grid-cols-2 h-9 app-input border rounded-xl p-1"
              >
                <button
                  type="button"
                  data-testid="ssh-auth-password"
                  onClick={() => setSshAuthMethod('password')}
                  className={`inline-flex items-center justify-center gap-1.5 h-full text-xs font-medium rounded-lg transition-colors ${
                    sshAuthMethod === 'password' ? 'app-surface font-semibold' : 'app-text-muted'
                  }`}
                >
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  Password
                </button>
                <button
                  type="button"
                  data-testid="ssh-auth-key"
                  onClick={() => setSshAuthMethod('key')}
                  className={`inline-flex items-center justify-center gap-1.5 h-full text-xs font-medium rounded-lg transition-colors ${
                    sshAuthMethod === 'key' ? 'app-surface font-semibold' : 'app-text-muted'
                  }`}
                >
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  Private Key
                </button>
              </div>
            </div>

            <div className="lg:col-span-2">
              {sshAuthMethod === 'password' ? (
                <div>
                  <label htmlFor="ssh-password" className="block text-xs app-text-muted mb-1.5">
                    SSH Password
                  </label>
                  <input
                    id="ssh-password"
                    data-testid="ssh-deploy-password"
                    type="password"
                    autoComplete="off"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder="Enter router SSH password"
                    className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              ) : (
                <div>
                  <label htmlFor="ssh-private-key" className="block text-xs app-text-muted mb-1.5">
                    SSH Private Key (PEM / OpenSSH)
                  </label>
                  <textarea
                    id="ssh-private-key"
                    data-testid="ssh-deploy-key"
                    rows={3}
                    value={sshPrivateKey}
                    onChange={(e) => setSshPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2 text-xs app-text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="ssh-deploy-restart-checkbox"
                checked={restartAfterUpdate}
                onChange={(e) => setRestartAfterUpdate(e.target.checked)}
                className="rounded border-slate-500 text-sky-500 focus:ring-sky-500"
              />
              <span>Restart background router agent immediately after updating script</span>
            </label>

            <button
              type="submit"
              data-testid="deploy-agent-btn"
              disabled={deploying}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl app-btn-primary text-xs font-semibold transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {deploying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Connecting to {sshHost || 'router'}...
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  {restartAfterUpdate ? 'Update Script & Restart Agent' : 'Upload Script Only'}
                </>
              )}
            </button>
          </div>
        </form>

        {deployResult && (
          <div
            data-testid="ssh-deploy-result"
            className={`rounded-xl border p-3.5 text-xs space-y-2 ${
              deployResult.ok
                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-400'
                : 'border-rose-500/35 bg-rose-500/10 text-rose-400'
            }`}
          >
            <div className="flex items-start gap-2 font-medium">
              {deployResult.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              )}
              <span>{deployResult.ok ? deployResult.message : deployResult.error}</span>
            </div>
            {deployResult.steps && deployResult.steps.length > 0 && (
              <ul className="pl-6 list-disc space-y-0.5 text-[11px] opacity-90">
                {deployResult.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Quick SSH Setup Steps */}
      <section className="app-surface border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="h-4 w-4 text-sky-500" aria-hidden="true" />
          <h2 className="font-display text-sm font-semibold">Router Quick-Start Commands</h2>
        </div>
        <pre className="app-input border rounded-xl p-3.5 text-xs font-mono app-text-secondary overflow-x-auto leading-relaxed">
{`# 1. SSH into your router
ssh root@192.168.1.1

# 2. Enable Netfilter per-flow byte accounting
echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct

# 3. Install lightweight Python 3 (or use the BusyBox Shell script with zero packages)
opkg update && opkg install python3-light

# 4. Copy orbi_probe.py to /opt/bin/orbi_probe.py and run silently in the background
chmod +x /opt/bin/orbi_probe.py
/opt/bin/orbi_probe.py -d --pid-file /var/run/orbi-probe.pid

# Optional: foreground debug logging or background file logging
# /opt/bin/orbi_probe.py --log-level debug
# /opt/bin/orbi_probe.py -d --log-file /tmp/orbi-probe.log --sys-interval 30`}
        </pre>
      </section>

      {/* Artifact Code Viewer */}
      <section className="app-surface border rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b app-border flex flex-wrap items-center justify-between gap-3 app-sidebar">
          <div
            role="tablist"
            aria-label="Deployment artifact files"
            className="flex flex-wrap items-center gap-1"
          >
            {ARTIFACT_META.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeArtifact === tab.id}
                onClick={() => setActiveArtifact(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap border ${
                  activeArtifact === tab.id
                    ? 'app-surface app-border font-semibold'
                    : 'app-text-muted border-transparent'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="copy-script-btn"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap"
            >
              {copyState === 'copied' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                  Copied
                </>
              ) : copyState === 'failed' ? (
                <>
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                  Copy blocked
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                  Copy Script
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl app-btn-primary text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download {currentMeta.filename}
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b app-border text-xs app-text-muted">
          {currentMeta.summary}
        </div>

        <pre className="p-5 app-input text-xs font-mono app-text-secondary overflow-x-auto max-h-[460px] leading-relaxed">
          <code>{currentContent}</code>
        </pre>
      </section>
    </div>
  );
}
