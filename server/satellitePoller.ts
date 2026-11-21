import { Client as SshClient, type ConnectConfig } from 'ssh2';
import type {
  EthernetPortMetrics,
  SatelliteClientLink,
  SatelliteConfig,
  SatelliteTelemetry,
} from '../src/types/telemetry';
import { parseSatelliteSshOutput } from '../src/lib/topology';
import { normalizeMac } from '../src/lib/deviceIdentity';

/**
 * Strictly static, read-only BusyBox shell probe executed over SSH on ephemeral Orbi satellites.
 * Writes ZERO files to the satellite (safe for RAM-only / read-only filesystems).
 * No user input is ever interpolated into this command.
 */
const STATIC_SATELLITE_PROBE_CMD = [
  'echo "===META==="',
  'echo "HOST=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"',
  'echo "UPTIME=$(cat /proc/uptime 2>/dev/null)"',
  'echo "===IFACES==="',
  'for d in /sys/class/net/*; do',
  '  n=$(basename "$d")',
  '  [ "$n" = "lo" ] && continue',
  '  st=$(cat "$d/operstate" 2>/dev/null || echo unknown)',
  '  sp=$(cat "$d/speed" 2>/dev/null || echo 0)',
  '  dp=$(cat "$d/duplex" 2>/dev/null || echo unknown)',
  '  rx=$(cat "$d/statistics/rx_bytes" 2>/dev/null || echo 0)',
  '  tx=$(cat "$d/statistics/tx_bytes" 2>/dev/null || echo 0)',
  '  wl=0; [ -d "$d/wireless" ] && wl=1',
  '  echo "$n|$st|$sp|$dp|$rx|$tx|$wl"',
  'done',
  'echo "===SWCONFIG==="',
  'if command -v swconfig >/dev/null 2>&1; then',
  '  swconfig dev switch0 show 2>/dev/null | grep -E "^Port [0-9]+:|link:|RxGoodByte|RxByte|TxByte" || true',
  'fi',
  'echo "===BRCTL==="',
  'if command -v brctl >/dev/null 2>&1; then',
  '  brctl showmacs br0 2>/dev/null || brctl showmacs br-lan 2>/dev/null || true',
  'fi',
  'echo "===WIFI==="',
  'if command -v wlanconfig >/dev/null 2>&1; then',
  '  for w in $(ls /sys/class/net 2>/dev/null | grep -E "^ath[0-9]+$"); do',
  '    echo "WIFI_IF=$w"',
  '    wlanconfig "$w" list sta 2>/dev/null || true',
  '  done',
  'elif command -v iw >/dev/null 2>&1; then',
  '  for w in $(ls /sys/class/net 2>/dev/null | grep -E "^(wlan|wl|ath)[0-9]+"); do',
  '    echo "WIFI_IF=$w"',
  '    iw dev "$w" station dump 2>/dev/null | grep -E "^Station |rx bytes:|tx bytes:|signal:|tx bitrate:" || true',
  '  done',
  'fi',
].join('\n');

const HOST_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;
const USER_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const IFACE_REGEX = /^[a-zA-Z0-9._:-]{0,32}$/;

const MAX_SSH_OUTPUT_BYTES = 256 * 1024;
const SSH_TIMEOUT_MS = 6_000;

export function validateSatelliteInput(input: Partial<SatelliteConfig>): {
  ok: boolean;
  error?: string;
} {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const username = typeof input.username === 'string' ? input.username.trim() : 'root';
  const port = Number(input.port ?? 22);
  const backhaul = typeof input.backhaulInterface === 'string' ? input.backhaulInterface.trim() : '';

  if (!name || name.length > 48) {
    return { ok: false, error: 'Satellite name is required (max 48 characters).' };
  }
  if (!host || !HOST_REGEX.test(host) || host.startsWith('-')) {
    return { ok: false, error: 'Enter a valid satellite IP address or hostname.' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'SSH port must be between 1 and 65535.' };
  }
  if (!USER_REGEX.test(username)) {
    return { ok: false, error: 'SSH username contains invalid characters.' };
  }
  if (backhaul && !IFACE_REGEX.test(backhaul)) {
    return { ok: false, error: 'Backhaul interface name contains invalid characters.' };
  }
  return { ok: true };
}

interface PreviousCounterState {
  timestamp: number;
  backhaulRx: number;
  backhaulTx: number;
  portBytes: Map<string, { rx: number; tx: number }>;
  clientBytes: Map<string, { rx: number; tx: number }>;
}

interface ActiveSession {
  config: SatelliteConfig;
  client: SshClient | null;
  ready: boolean;
  connecting: boolean;
  polling: boolean;
  timer: ReturnType<typeof setInterval> | null;
  prev: PreviousCounterState | null;
  telemetry: SatelliteTelemetry;
}

function buildSshConnectConfig(cfg: SatelliteConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username || 'root',
    readyTimeout: SSH_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 2,
    // Legacy Orbi / Dropbear SSH routers often require ssh-rsa / diffie-hellman-group14
    algorithms: {
      serverHostKey: [
        'ssh-ed25519',
        'ecdsa-sha2-nistp256',
        'rsa-sha2-512',
        'rsa-sha2-256',
        'ssh-rsa',
      ],
      kex: [
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'ecdh-sha2-nistp256',
        'diffie-hellman-group14-sha256',
        'diffie-hellman-group14-sha1',
      ],
    },
  };

  if (cfg.authMethod === 'key' && cfg.privateKey) {
    base.privateKey = cfg.privateKey;
  } else if (cfg.password) {
    base.password = cfg.password;
  }
  return base;
}

function execOnClient(client: SshClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('SSH probe command timed out'));
      }
    }, SSH_TIMEOUT_MS);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }

      stream.on('data', (chunk: Buffer) => {
        if (output.length < MAX_SSH_OUTPUT_BYTES) {
          output += chunk.toString('utf8');
        }
      });

      stream.stderr.on('data', () => {
        // Ignore non-fatal stderr from optional tools like swconfig/wlanconfig
      });

      stream.on('close', () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve(output);
        }
      });

      stream.on('error', (streamErr: Error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(streamErr);
        }
      });
    });
  });
}

function convertProbeToTelemetry(
  cfg: SatelliteConfig,
  rawOutput: string,
  prev: PreviousCounterState | null,
  now: number
): { telemetry: SatelliteTelemetry; nextPrev: PreviousCounterState } {
  const parsed = parseSatelliteSshOutput(rawOutput);
  const dtSec = prev && now > prev.timestamp ? Math.max(0.5, (now - prev.timestamp) / 1000) : 0;

  const nextPortBytes = new Map<string, { rx: number; tx: number }>();
  const ports: EthernetPortMetrics[] = [];

  // Prefer switch ports when swconfig reports physical Ethernet ports, plus non-bridge eth* interfaces
  if (parsed.switchPorts.length > 0) {
    for (const sp of parsed.switchPorts) {
      // Port 0 on QCA8337 is usually CPU port; skip CPU port unless it's the only one
      if (sp.portNum === 0 && parsed.switchPorts.length > 1) continue;
      const id = `port${sp.portNum}`;
      const prevCounters = prev?.portBytes.get(id);
      const rxBps =
        dtSec > 0 && prevCounters && sp.rxBytes >= prevCounters.rx
          ? Math.round((sp.rxBytes - prevCounters.rx) / dtSec)
          : 0;
      const txBps =
        dtSec > 0 && prevCounters && sp.txBytes >= prevCounters.tx
          ? Math.round((sp.txBytes - prevCounters.tx) / dtSec)
          : 0;

      nextPortBytes.set(id, { rx: sp.rxBytes, tx: sp.txBytes });
      ports.push({
        id,
        label: `LAN ${sp.portNum}`,
        role: sp.portNum === 1 ? 'backhaul' : 'lan',
        linkUp: sp.linkUp,
        speedMbps: sp.speedMbps,
        duplex: sp.duplex,
        rxBytes: sp.rxBytes,
        txBytes: sp.txBytes,
        rxBps,
        txBps,
      });
    }
  }

  // Always include physical eth* / lan* / wan* interfaces from sysfs if switchPorts didn't cover them
  const ethIfaces = parsed.interfaces.filter(
    (iface) => !iface.isWireless && /^(eth|en|lan|wan|br0)/i.test(iface.name)
  );
  for (const iface of ethIfaces) {
    if (iface.name === 'br0' && ports.length > 0) continue;
    const prevCounters = prev?.portBytes.get(iface.name);
    const rxBps =
      dtSec > 0 && prevCounters && iface.rxBytes >= prevCounters.rx
        ? Math.round((iface.rxBytes - prevCounters.rx) / dtSec)
        : 0;
    const txBps =
      dtSec > 0 && prevCounters && iface.txBytes >= prevCounters.tx
        ? Math.round((iface.txBytes - prevCounters.tx) / dtSec)
        : 0;
    nextPortBytes.set(iface.name, { rx: iface.rxBytes, tx: iface.txBytes });

    // Avoid duplicating eth0 if we already listed switch ports, unless explicit backhaul
    if (ports.length === 0 || iface.name === cfg.backhaulInterface || /^eth\d+$/i.test(iface.name)) {
      ports.push({
        id: iface.name,
        label: iface.name,
        role: iface.name === cfg.backhaulInterface ? 'backhaul' : 'lan',
        linkUp: iface.operstate === 'up' || iface.speedMbps > 0,
        speedMbps: iface.speedMbps,
        duplex: iface.duplex,
        rxBytes: iface.rxBytes,
        txBytes: iface.txBytes,
        rxBps,
        txBps,
      });
    }
  }

  // Determine backhaul link (explicit interface override > wired eth/switch port > wireless backhaul)
  let backhaulType: 'ethernet' | 'wifi' = 'ethernet';
  let backhaulIface = cfg.backhaulInterface?.trim() || '';
  let backhaulSpeedMbps = 0;
  let backhaulRxBytes = 0;
  let backhaulTxBytes = 0;

  const explicitIface = backhaulIface
    ? parsed.interfaces.find((i) => i.name === backhaulIface)
    : undefined;

  if (explicitIface) {
    backhaulType = explicitIface.isWireless ? 'wifi' : 'ethernet';
    backhaulSpeedMbps = explicitIface.speedMbps || (backhaulType === 'wifi' ? 866 : 1000);
    backhaulRxBytes = explicitIface.rxBytes;
    backhaulTxBytes = explicitIface.txBytes;
  } else {
    const activeEth =
      ports.find((p) => p.role === 'backhaul' && p.linkUp && p.speedMbps > 0) ||
      ports.find((p) => p.linkUp && p.speedMbps > 0);
    if (activeEth) {
      backhaulType = 'ethernet';
      backhaulIface = activeEth.id;
      backhaulSpeedMbps = activeEth.speedMbps;
      backhaulRxBytes = activeEth.rxBytes;
      backhaulTxBytes = activeEth.txBytes;
    } else {
      const wifiBackhaul = parsed.interfaces.find(
        (i) => i.isWireless && (i.operstate === 'up' || i.rxBytes + i.txBytes > 0)
      );
      backhaulType = 'wifi';
      backhaulIface = wifiBackhaul?.name || 'ath2';
      backhaulSpeedMbps = wifiBackhaul?.speedMbps || 866;
      backhaulRxBytes = wifiBackhaul?.rxBytes || 0;
      backhaulTxBytes = wifiBackhaul?.txBytes || 0;
    }
  }

  // On a satellite, bytes received on backhaul (rxBytes) are Router -> Satellite (download for clients),
  // and bytes transmitted on backhaul (txBytes) are Satellite -> Router (upload from clients).
  const satRxBps =
    dtSec > 0 && prev && backhaulRxBytes >= prev.backhaulRx
      ? Math.round((backhaulRxBytes - prev.backhaulRx) / dtSec)
      : 0;
  const satTxBps =
    dtSec > 0 && prev && backhaulTxBytes >= prev.backhaulTx
      ? Math.round((backhaulTxBytes - prev.backhaulTx) / dtSec)
      : 0;

  // Map connected satellite clients (Wi-Fi stations first, then wired bridge MACs)
  const nextClientBytes = new Map<string, { rx: number; tx: number }>();
  const clientsByMac = new Map<string, SatelliteClientLink>();

  for (const sta of parsed.wifiStations) {
    const mac = normalizeMac(sta.mac);
    if (!mac || mac === '00:00:00:00:00:00') continue;
    const prevC = prev?.clientBytes.get(mac);
    const rxBps =
      dtSec > 0 && prevC && sta.rxBytes >= prevC.rx
        ? Math.round((sta.rxBytes - prevC.rx) / dtSec)
        : 0;
    const txBps =
      dtSec > 0 && prevC && sta.txBytes >= prevC.tx
        ? Math.round((sta.txBytes - prevC.tx) / dtSec)
        : 0;
    nextClientBytes.set(mac, { rx: sta.rxBytes, tx: sta.txBytes });
    clientsByMac.set(mac, {
      mac,
      connectionType: 'wifi',
      portOrRadio: sta.iface,
      linkSpeedMbps: sta.txRateMbps || 433,
      signalDbm: sta.signalDbm,
      rxBytes: sta.rxBytes,
      txBytes: sta.txBytes,
      rxBps,
      txBps,
    });
  }

  for (const bm of parsed.bridgeMacs) {
    const mac = normalizeMac(bm.mac);
    if (!mac || clientsByMac.has(mac)) continue;
    const matchingPort = ports.find((p) => p.id === `port${bm.portNum}` || p.id === `eth${bm.portNum}`);
    clientsByMac.set(mac, {
      mac,
      connectionType: 'ethernet',
      portOrRadio: matchingPort?.label || `Port ${bm.portNum}`,
      linkSpeedMbps: matchingPort?.speedMbps || 1000,
      rxBytes: 0,
      txBytes: 0,
      rxBps: 0,
      txBps: 0,
    });
  }

  return {
    telemetry: {
      id: cfg.id,
      name: cfg.name,
      host: cfg.host,
      model: parsed.hostname || undefined,
      connected: true,
      source: 'ssh',
      lastSeen: now,
      uptimeSec: parsed.uptimeSec,
      backhaulType,
      backhaulIface,
      backhaulSpeedMbps,
      rxBps: satRxBps,
      txBps: satTxBps,
      rxBytes: backhaulRxBytes,
      txBytes: backhaulTxBytes,
      ports,
      clients: Array.from(clientsByMac.values()),
    },
    nextPrev: {
      timestamp: now,
      backhaulRx: backhaulRxBytes,
      backhaulTx: backhaulTxBytes,
      portBytes: nextPortBytes,
      clientBytes: nextClientBytes,
    },
  };
}

export class SatelliteSshPoller {
  private sessions = new Map<string, ActiveSession>();
  private configs = new Map<string, SatelliteConfig>();
  private onUpdate?: (satellites: SatelliteTelemetry[]) => void;

  constructor(onUpdate?: (satellites: SatelliteTelemetry[]) => void) {
    this.onUpdate = onUpdate;
  }

  public getConfigs(): SatelliteConfig[] {
    return Array.from(this.configs.values());
  }

  public getTelemetry(): SatelliteTelemetry[] {
    return Array.from(this.sessions.values()).map((s) => s.telemetry);
  }

  public setConfigs(configs: SatelliteConfig[]): void {
    const nextIds = new Set(configs.map((c) => c.id));
    for (const id of Array.from(this.sessions.keys())) {
      if (!nextIds.has(id)) {
        this.stopSession(id);
        this.configs.delete(id);
      }
    }
    for (const cfg of configs) {
      this.upsertSatellite(cfg);
    }
    this.emitUpdate();
  }

  public upsertSatellite(cfg: SatelliteConfig): void {
    const existing = this.configs.get(cfg.id);
    const merged: SatelliteConfig = {
      ...cfg,
      password: cfg.password || existing?.password || '',
      privateKey: cfg.privateKey || existing?.privateKey || '',
      pollIntervalSec: Math.max(3, Math.min(60, Number(cfg.pollIntervalSec) || 5)),
      port: Math.max(1, Math.min(65535, Number(cfg.port) || 22)),
    };

    this.stopSession(cfg.id);
    this.configs.set(cfg.id, merged);

    const session: ActiveSession = {
      config: merged,
      client: null,
      ready: false,
      connecting: false,
      polling: false,
      timer: null,
      prev: null,
      telemetry: {
        id: merged.id,
        name: merged.name,
        host: merged.host,
        connected: false,
        source: 'ssh',
        lastSeen: 0,
        lastError: merged.enabled ? 'Connecting over SSH...' : 'Polling paused',
        uptimeSec: 0,
        backhaulType: 'ethernet',
        backhaulIface: merged.backhaulInterface || 'eth0',
        backhaulSpeedMbps: 0,
        rxBps: 0,
        txBps: 0,
        rxBytes: 0,
        txBytes: 0,
        ports: [],
        clients: [],
      },
    };
    this.sessions.set(cfg.id, session);

    if (merged.enabled) {
      this.startPollingSession(session);
    }
    this.emitUpdate();
  }

  public removeSatellite(id: string): void {
    this.stopSession(id);
    this.configs.delete(id);
    this.emitUpdate();
  }

  public stopAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.stopSession(id);
    }
  }

  private stopSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    if (session.client) {
      try {
        session.client.end();
      } catch {
        // ignore close error
      }
      session.client = null;
    }
    session.ready = false;
    session.connecting = false;
    this.sessions.delete(id);
  }

  private startPollingSession(session: ActiveSession): void {
    void this.pollOnce(session);
    session.timer = setInterval(() => {
      void this.pollOnce(session);
    }, session.config.pollIntervalSec * 1000);
  }

  private ensureConnected(session: ActiveSession): Promise<SshClient> {
    if (session.client && session.ready) {
      return Promise.resolve(session.client);
    }
    return new Promise((resolve, reject) => {
      if (session.connecting) {
        reject(new Error('SSH connection already in progress'));
        return;
      }
      session.connecting = true;
      const client = new SshClient();

      const cleanup = () => {
        session.connecting = false;
        session.ready = false;
        if (session.client === client) {
          session.client = null;
        }
      };

      client
        .on('ready', () => {
          session.connecting = false;
          session.ready = true;
          session.client = client;
          resolve(client);
        })
        .on('error', (err) => {
          cleanup();
          reject(err);
        })
        .on('close', () => {
          cleanup();
        })
        .connect(buildSshConnectConfig(session.config));
    });
  }

  private async pollOnce(session: ActiveSession): Promise<void> {
    if (session.polling || !session.config.enabled) return;
    session.polling = true;
    try {
      const client = await this.ensureConnected(session);
      const output = await execOnClient(client, STATIC_SATELLITE_PROBE_CMD);
      const { telemetry, nextPrev } = convertProbeToTelemetry(
        session.config,
        output,
        session.prev,
        Date.now()
      );
      session.prev = nextPrev;
      session.telemetry = telemetry;
      this.emitUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SSH poll failed';
      session.telemetry = {
        ...session.telemetry,
        connected: false,
        lastError: msg,
        rxBps: 0,
        txBps: 0,
      };
      if (session.client) {
        try {
          session.client.end();
        } catch {
          // ignore
        }
        session.client = null;
        session.ready = false;
      }
      this.emitUpdate();
    } finally {
      session.polling = false;
    }
  }

  public async testConnection(
    cfg: SatelliteConfig
  ): Promise<{ ok: boolean; error?: string; summary?: string; telemetry?: SatelliteTelemetry }> {
    const validation = validateSatelliteInput(cfg);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    const existing = this.configs.get(cfg.id);
    const effective: SatelliteConfig = {
      ...cfg,
      password: cfg.password || existing?.password || '',
      privateKey: cfg.privateKey || existing?.privateKey || '',
    };

    const client = new SshClient();
    try {
      await new Promise<void>((resolve, reject) => {
        client
          .on('ready', () => resolve())
          .on('error', (err) => reject(err))
          .connect(buildSshConnectConfig(effective));
      });
      const output = await execOnClient(client, STATIC_SATELLITE_PROBE_CMD);
      const { telemetry } = convertProbeToTelemetry(effective, output, null, Date.now());
      client.end();
      return {
        ok: true,
        summary: `Connected to ${telemetry.model || effective.host} · ${telemetry.ports.length} port(s) · Backhaul ${telemetry.backhaulSpeedMbps} Mbps`,
        telemetry,
      };
    } catch (err) {
      try {
        client.end();
      } catch {
        // ignore
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to connect over SSH',
      };
    }
  }

  private emitUpdate(): void {
    if (this.onUpdate) {
      this.onUpdate(this.getTelemetry());
    }
  }
}
