import { useMemo, useState } from 'react';
import { Check, Copy, Download, Terminal } from 'lucide-react';
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
      'Recommended for Voxel + Entware (opkg install python3-light). Uses only Python stdlib with built-in RFC 6455 WebSocket framing and 5s low-CPU polling.',
  },
  {
    id: 'ash',
    label: 'BusyBox Ash (Zero Deps)',
    filename: 'orbi-probe.sh',
    summary:
      'Runs on stock Voxel firmware without installing Entware packages. Streams /proc/net/nf_conntrack + eth0 byte counters via awk & curl every 5s.',
  },
  {
    id: 'c',
    label: 'Native C (armv7l)',
    filename: 'orbi-wan-probe.c',
    summary:
      'Ultra-lightweight (<1.2 MB RSS) native binary for IPQ4019 armv7l. Lowest possible CPU footprint.',
  },
  {
    id: 'init',
    label: 'Entware Init Service',
    filename: 'S99orbi-probe',
    summary:
      'Autostart daemon script for /opt/etc/init.d/S99orbi-probe on Voxel firmware reboot.',
  },
  {
    id: 'docker',
    label: 'Docker Compose',
    filename: 'docker-compose.yml',
    summary:
      'Runs this OrbiFlow server inside a Linux Docker container with persistent /config volume storage for config.json, /config/cache, and /config/geoip MaxMind databases.',
  },
];

export function SetupView() {
  const defaultHost =
    typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? window.location.hostname
      : '192.168.1.10';

  const [serverHost, setServerHost] = useState(defaultHost);
  const [serverPort, setServerPort] = useState('3000');
  const [token, setToken] = useState('orbi-rbk50-voxel-secret');
  const [iface, setIface] = useState('eth0');
  const [intervalSec, setIntervalSec] = useState('5');
  const [activeArtifact, setActiveArtifact] = useState<ArtifactTab>('python');
  const [copied, setCopied] = useState(false);

  const probeCfg = useMemo(
    () => ({
      wsUrl: `ws://${serverHost}:${serverPort}/ws/ingest`,
      httpUrl: `http://${serverHost}:${serverPort}/api/ingest`,
      token,
      iface,
      intervalSec: Math.max(1, Number(intervalSec) || 5),
      probeId: 'orbi-rbk50-eth0',
    }),
    [serverHost, serverPort, token, iface, intervalSec]
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
        return generateInitScript();
      case 'docker':
        return generateDockerCompose(probeCfg);
    }
  }, [activeArtifact, probeCfg]);

  const currentMeta = ARTIFACT_META.find((m) => m.id === activeArtifact)!;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API fallback ignored
    }
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

  return (
    <div className="space-y-6">
      {/* Architecture & Config Form */}
      <section className="app-surface border rounded-2xl p-5 space-y-5">
        <div>
          <h2 className="font-display text-base font-semibold">
            Orbi RBK50 Voxel Agent Configuration
          </h2>
          <p className="text-xs app-text-muted mt-1 max-w-2xl">
            Targeted for <span className="font-mono app-text-secondary">Linux orbi-gateway 3.14.77 armv7l IPQ4019</span>.
            Reads kernel{' '}
            <TechTerm
              label="/proc/net/nf_conntrack"
              tip="Linux kernel connection tracking table listing every active network session passing through your router."
              className="font-mono app-text-secondary"
            />{' '}
            &amp;{' '}
            <span className="font-mono app-text-secondary">/sys/class/net/{iface}/statistics</span> every{' '}
            {probeCfg.intervalSec}s with minimal CPU overhead, preserving hardware{' '}
            <TechTerm
              label="NSS NAT"
              tip="Qualcomm Network Subsystem hardware acceleration on the Orbi RBK50 that keeps gigabit routing fast without loading the main CPU."
            />{' '}
            acceleration.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label htmlFor="cfg-host" className="block text-xs app-text-muted mb-1.5">
              Docker Server LAN IP
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
                label="Internet Interface"
                tip="The Linux network interface connected to your ISP modem (eth0 on Netgear Orbi RBK50)."
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
            <label htmlFor="cfg-token" className="block text-xs app-text-muted mb-1.5">
              Shared Agent Token
            </label>
            <input
              id="cfg-token"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full app-input border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
      </section>

      {/* Quick Voxel SSH Setup Steps */}
      <section className="app-surface border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="h-4 w-4 text-sky-500" aria-hidden="true" />
          <h2 className="font-display text-sm font-semibold">
            Router Quick-Start Commands (Voxel SSH)
          </h2>
        </div>
        <pre className="app-input border rounded-xl p-3.5 text-xs font-mono app-text-secondary overflow-x-auto leading-relaxed">
{`# 1. SSH into your Orbi RBK50 router
ssh root@192.168.1.1

# 2. Enable Netfilter per-flow byte accounting in Linux 3.14
echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct

# 3. Install lightweight Python 3 (or use the BusyBox Ash script with zero packages)
opkg update && opkg install python3-light

# 4. Copy orbi_probe.py to /opt/bin/orbi_probe.py and launch (5s low-CPU polling)
chmod +x /opt/bin/orbi_probe.py && /opt/bin/orbi_probe.py &`}
        </pre>
      </section>

      {/* Artifact Code Viewer */}
      <section className="app-surface border rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b app-border flex flex-wrap items-center justify-between gap-3 app-sidebar">
          <div role="tablist" aria-label="Deployment artifact files" className="flex flex-wrap items-center gap-1">
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
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                  Copied
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
