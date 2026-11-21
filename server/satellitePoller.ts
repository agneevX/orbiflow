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
  'echo "===ROUTE==="',
  'ip route show default 2>/dev/null || true',
  'cat /proc/net/route 2>/dev/null || true',
  'cat /proc/net/arp 2>/dev/null || true',
  'echo "===BRIF==="',
  'for b in br0 br-lan; do',
  '  if [ -d "/sys/class/net/$b/brif" ]; then',
  '    for p in /sys/class/net/$b/brif/*; do',
  '      [ -d "$p" ] || continue',
  '      pn=$(cat "$p/port_no" 2>/dev/null || echo 0)',
  '      echo "$(basename "$p")|$pn"',
  '    done',
  '    break',
  '  fi',
  'done',
  'echo "===IFACES==="',
  'for d in /sys/class/net/*; do',
  '  n=$(basename "$d")',
  '  [ "$n" = "lo" ] && continue',
  '  st=$(cat "$d/operstate" 2>/dev/null || echo unknown)',
  '  sp=$(cat "$d/speed" 2>/dev/null || echo 0)',
  '  dp=$(cat "$d/duplex" 2>/dev/null || echo unknown)',
  '  rx=$(cat "$d/statistics/rx_bytes" 2>/dev/null || echo 0)',
  '  tx=$(cat "$d/statistics/tx_bytes" 2>/dev/null || echo 0)',
  '  mac=$(cat "$d/address" 2>/dev/null || echo "")',
  '  wl=0; [ -d "$d/wireless" ] && wl=1',
  '  if [ "$wl" = "0" ] && { [ -z "$sp" ] || [ "$sp" -le 0 ] 2>/dev/null; } && command -v ethtool >/dev/null 2>&1; then',
  '    case "$n" in eth*|en*|lan*|wan*)',
  '      et=$(ethtool "$n" 2>/dev/null || true)',
  '      esp=$(echo "$et" | sed -n "s/.*Speed: *\\([0-9]*\\)Mb.*/\\1/p" | head -n 1)',
  '      [ -n "$esp" ] && sp="$esp"',
  '      edp=$(echo "$et" | sed -n "s/.*Duplex: *\\([A-Za-z]*\\).*/\\1/p" | head -n 1)',
  '      [ -n "$edp" ] && dp="$edp"',
  '    ;; esac',
  '  fi',
  '  echo "$n|$st|$sp|$dp|$rx|$tx|$wl|$mac"',
  'done',
  'echo "===SWCONFIG==="',
  'if command -v swconfig >/dev/null 2>&1; then',
  '  swconfig dev switch0 show 2>/dev/null | grep -E "^Port [0-9]+:|link:|RxGoodByte|RxByte|TxByte|TxGoodByte" || true',
  'fi',
  'echo "===SWITCH_FDB==="',
  'if command -v swconfig >/dev/null 2>&1; then',
  '  swconfig dev switch0 get dump_arl 2>/dev/null || true',
  'fi',
  'if command -v ssdk_sh >/dev/null 2>&1; then',
  '  ssdk_sh fdb entry show 2>/dev/null || true',
  'fi',
  'echo "===BRCTL==="',
  'if command -v brctl >/dev/null 2>&1; then',
  '  brctl showmacs br0 2>/dev/null || brctl showmacs br-lan 2>/dev/null || true',
  'fi',
  'echo "===WIFI_INFO==="',
  'if command -v iwconfig >/dev/null 2>&1; then',
  '  iwconfig 2>/dev/null || true',
  'elif command -v iw >/dev/null 2>&1; then',
  '  iw dev 2>/dev/null || true',
  'fi',
  'echo "===WIFI==="',
  'if command -v wlanconfig >/dev/null 2>&1; then',
  '  for w in $(ls /sys/class/net 2>/dev/null | grep -E "^ath[0-9]+"); do',
  '    echo "WIFI_IF=$w"',
  '    wlanconfig "$w" list sta 2>/dev/null || true',
  '  done',
  'elif command -v iw >/dev/null 2>&1; then',
  '  for w in $(ls /sys/class/net 2>/dev/null | grep -E "^(wlan|wl|ath)[0-9]+"); do',
  '    echo "WIFI_IF=$w"',
  '    iw dev "$w" station dump 2>/dev/null | grep -E "^Station |rx bytes:|tx bytes:|signal:|tx bitrate:|rx bitrate:" || true',
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

const CLIENT_PRESENCE_GRACE_MS = 60_000;

interface CachedSatelliteClient {
  link: SatelliteClientLink;
  lastSeen: number;
}

export interface PreviousCounterState {
  timestamp: number;
  backhaulRx: number;
  backhaulTx: number;
  backhaulIface: string;
  portBytes: Map<string, { rx: number; tx: number }>;
  clientBytes: Map<string, { rx: number; tx: number }>;
  recentClients: Map<string, CachedSatelliteClient>;
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

function computeCounterDeltaBps(curr: number, prev: number | undefined, dtSec: number): number {
  if (dtSec <= 0 || prev === undefined) return 0;
  if (curr >= prev) {
    return Math.round((curr - prev) / dtSec);
  }
  // Handle 32-bit counter wraparound cleanly when previous value was near 4 GiB
  if (prev > 0xc0000000 && prev <= 0xffffffff && curr < 0x40000000) {
    return Math.round((0x100000000 - prev + curr) / dtSec);
  }
  return 0;
}

export function convertProbeToTelemetry(
  cfg: SatelliteConfig,
  rawOutput: string,
  prev: PreviousCounterState | null,
  now: number
): { telemetry: SatelliteTelemetry; nextPrev: PreviousCounterState } {
  const parsed = parseSatelliteSshOutput(rawOutput);
  const dtSec = prev && now > prev.timestamp ? Math.max(0.5, (now - prev.timestamp) / 1000) : 0;

  const ifaceByName = new Map(parsed.interfaces.map((i) => [i.name, i]));
  const wifiInfoByIface = new Map(parsed.wifiIfaces.map((w) => [w.iface, w]));
  const bridgeIfaceByPortNum = new Map(parsed.bridgeIfaces.map((b) => [b.portNum, b.iface]));
  const bridgePortNumByIface = new Map(parsed.bridgeIfaces.map((b) => [b.iface, b.portNum]));
  const ipByMac = new Map<string, string>();
  const macByIp = new Map<string, string>();
  for (const arp of parsed.arpEntries) {
    ipByMac.set(arp.mac, arp.ip);
    macByIp.set(arp.ip, arp.mac);
  }

  const localSatelliteMacs = new Set<string>();
  for (const iface of parsed.interfaces) {
    if (iface.mac) localSatelliteMacs.add(iface.mac);
  }

  // 1. Identify the main router's (gateway) MAC address and which bridge/switch port leads to it
  const gatewayMac = parsed.gatewayIp ? macByIp.get(parsed.gatewayIp) : undefined;
  const gatewayBridgeEntry = gatewayMac
    ? parsed.bridgeMacs.find((bm) => bm.mac === gatewayMac)
    : undefined;
  const gatewayBridgePortNum = gatewayBridgeEntry?.portNum;
  const gatewayBridgeIface =
    gatewayBridgePortNum !== undefined ? bridgeIfaceByPortNum.get(gatewayBridgePortNum) : undefined;

  // Also check if switch FDB (ARL) identifies which physical switch port holds the gateway MAC
  const physicalSwitchPorts = parsed.switchPorts.filter(
    (sp) => !(sp.portNum === 0 && parsed.switchPorts.length > 1)
  );
  const gatewaySwitchPortNum = gatewayMac
    ? parsed.switchFdb.find((e) => e.mac === gatewayMac && e.portNum !== 0)?.portNum
    : undefined;

  // Identify wireless STA (Managed mode) backhaul interfaces & their upstream BSSIDs
  const staWifiIfaces = parsed.wifiIfaces.filter((w) => w.mode === 'managed');
  const associatedStaWifi =
    staWifiIfaces.find((w) => w.associated) ||
    staWifiIfaces.find((w) => {
      const info = ifaceByName.get(w.iface);
      return info && (info.operstate === 'up' || info.rxBytes + info.txBytes > 0);
    });
  const backhaulPeerBssids = new Set<string>();
  for (const w of staWifiIfaces) {
    if (w.bssid) backhaulPeerBssids.add(w.bssid);
  }

  // 2. Determine TRUE backhaul type (Ethernet vs Wi-Fi) & backhaul interface
  //    Priority:
  //    (a) Explicit user backhaulInterface override
  //    (b) Bridge port leading to the gateway/router MAC (ground truth on L2 bridged Orbi/OpenWrt)
  //    (c) Associated Managed/STA wireless backhaul interface when no Ethernet uplink is found
  //    (d) Fallback to active Ethernet switch port / interface
  let backhaulType: 'ethernet' | 'wifi' = 'ethernet';
  let backhaulIface = '';
  let backhaulSpeedMbps = 0;
  let backhaulRxBytes = 0;
  let backhaulTxBytes = 0;
  let uplinkSwitchPortNum: number | undefined;
  let backhaulBridgePortNum: number | undefined = gatewayBridgePortNum;

  const explicitName = cfg.backhaulInterface?.trim() || '';
  const explicitIface = explicitName ? ifaceByName.get(explicitName) : undefined;
  const explicitSwitchPort = explicitName
    ? physicalSwitchPorts.find((sp) => `port${sp.portNum}` === explicitName)
    : undefined;

  const resolveWifiBackhaulSpeed = (ifaceName: string): number => {
    const wi = wifiInfoByIface.get(ifaceName);
    if (wi && wi.bitRateMbps > 0) return wi.bitRateMbps;
    const staOnIface = parsed.wifiStations.find((s) => s.iface === ifaceName && s.txRateMbps > 0);
    if (staOnIface) return staOnIface.txRateMbps;
    const ifaceObj = ifaceByName.get(ifaceName);
    if (ifaceObj && ifaceObj.speedMbps > 0) return ifaceObj.speedMbps;
    return 0;
  };

  if (explicitSwitchPort) {
    backhaulType = 'ethernet';
    backhaulIface = `port${explicitSwitchPort.portNum}`;
    uplinkSwitchPortNum = explicitSwitchPort.portNum;
    backhaulSpeedMbps = explicitSwitchPort.speedMbps;
    backhaulRxBytes = explicitSwitchPort.rxBytes;
    backhaulTxBytes = explicitSwitchPort.txBytes;
  } else if (explicitIface) {
    backhaulType = explicitIface.isWireless ? 'wifi' : 'ethernet';
    backhaulIface = explicitIface.name;
    backhaulBridgePortNum = bridgePortNumByIface.get(explicitIface.name) ?? backhaulBridgePortNum;
    backhaulSpeedMbps =
      backhaulType === 'wifi'
        ? resolveWifiBackhaulSpeed(explicitIface.name)
        : explicitIface.speedMbps;
    backhaulRxBytes = explicitIface.rxBytes;
    backhaulTxBytes = explicitIface.txBytes;
  } else if (gatewayBridgeIface) {
    const gwIfaceObj = ifaceByName.get(gatewayBridgeIface);
    const gwWifiInfo = wifiInfoByIface.get(gatewayBridgeIface);
    const isWifiBackhaul = Boolean(
      gwIfaceObj?.isWireless ||
        gwWifiInfo ||
        /^(ath|wlan|wl|ra|wifi)/i.test(gatewayBridgeIface)
    );
    if (isWifiBackhaul) {
      backhaulType = 'wifi';
      backhaulIface = gatewayBridgeIface;
      backhaulSpeedMbps = resolveWifiBackhaulSpeed(gatewayBridgeIface);
      backhaulRxBytes = gwIfaceObj?.rxBytes || 0;
      backhaulTxBytes = gwIfaceObj?.txBytes || 0;
    } else {
      backhaulType = 'ethernet';
      uplinkSwitchPortNum = gatewaySwitchPortNum;
      const uplinkSp =
        uplinkSwitchPortNum !== undefined
          ? physicalSwitchPorts.find((sp) => sp.portNum === uplinkSwitchPortNum)
          : undefined;
      if (uplinkSp) {
        backhaulIface = `port${uplinkSp.portNum}`;
        backhaulSpeedMbps = uplinkSp.speedMbps || gwIfaceObj?.speedMbps || 0;
        backhaulRxBytes = uplinkSp.rxBytes > 0 ? uplinkSp.rxBytes : gwIfaceObj?.rxBytes || 0;
        backhaulTxBytes = uplinkSp.txBytes > 0 ? uplinkSp.txBytes : gwIfaceObj?.txBytes || 0;
      } else {
        backhaulIface = gatewayBridgeIface;
        const activeSp = physicalSwitchPorts.find((sp) => sp.linkUp && sp.speedMbps > 0);
        backhaulSpeedMbps = gwIfaceObj?.speedMbps || activeSp?.speedMbps || 0;
        backhaulRxBytes = gwIfaceObj?.rxBytes || activeSp?.rxBytes || 0;
        backhaulTxBytes = gwIfaceObj?.txBytes || activeSp?.txBytes || 0;
      }
    }
  } else if (gatewaySwitchPortNum !== undefined) {
    const uplinkSp = physicalSwitchPorts.find((sp) => sp.portNum === gatewaySwitchPortNum);
    backhaulType = 'ethernet';
    uplinkSwitchPortNum = gatewaySwitchPortNum;
    backhaulIface = `port${gatewaySwitchPortNum}`;
    backhaulSpeedMbps = uplinkSp?.speedMbps || 0;
    backhaulRxBytes = uplinkSp?.rxBytes || 0;
    backhaulTxBytes = uplinkSp?.txBytes || 0;
  } else if (associatedStaWifi) {
    const staIfaceObj = ifaceByName.get(associatedStaWifi.iface);
    backhaulType = 'wifi';
    backhaulIface = associatedStaWifi.iface;
    backhaulBridgePortNum = bridgePortNumByIface.get(associatedStaWifi.iface) ?? backhaulBridgePortNum;
    backhaulSpeedMbps = resolveWifiBackhaulSpeed(associatedStaWifi.iface);
    backhaulRxBytes = staIfaceObj?.rxBytes || 0;
    backhaulTxBytes = staIfaceObj?.txBytes || 0;
  } else {
    // Fallback when neither gateway MAC nor iwconfig STA is available: check switch/eth first, then Wi-Fi
    const activeSp = physicalSwitchPorts.find((sp) => sp.linkUp && sp.speedMbps > 0);
    const activeEthIface = parsed.interfaces.find(
      (i) => !i.isWireless && /^(eth|en|lan|wan)/i.test(i.name) && (i.operstate === 'up' || i.speedMbps > 0)
    );
    if (activeSp) {
      backhaulType = 'ethernet';
      uplinkSwitchPortNum = activeSp.portNum;
      backhaulIface = `port${activeSp.portNum}`;
      backhaulSpeedMbps = activeSp.speedMbps;
      backhaulRxBytes = activeSp.rxBytes;
      backhaulTxBytes = activeSp.txBytes;
    } else if (activeEthIface) {
      backhaulType = 'ethernet';
      backhaulIface = activeEthIface.name;
      backhaulBridgePortNum = bridgePortNumByIface.get(activeEthIface.name) ?? backhaulBridgePortNum;
      backhaulSpeedMbps = activeEthIface.speedMbps;
      backhaulRxBytes = activeEthIface.rxBytes;
      backhaulTxBytes = activeEthIface.txBytes;
    } else {
      const wifiBackhaul = parsed.interfaces.find(
        (i) => i.isWireless && (i.operstate === 'up' || i.rxBytes + i.txBytes > 0)
      );
      backhaulType = 'wifi';
      backhaulIface = wifiBackhaul?.name || 'ath2';
      backhaulBridgePortNum = bridgePortNumByIface.get(backhaulIface) ?? backhaulBridgePortNum;
      backhaulSpeedMbps = resolveWifiBackhaulSpeed(backhaulIface);
      backhaulRxBytes = wifiBackhaul?.rxBytes || 0;
      backhaulTxBytes = wifiBackhaul?.txBytes || 0;
    }
  }

  // 3. Build accurate physical Ethernet port metrics (avoid duplicating CPU trunk eth0 when switchPorts exist!)
  const nextPortBytes = new Map<string, { rx: number; tx: number }>();
  const ports: EthernetPortMetrics[] = [];

  if (physicalSwitchPorts.length > 0) {
    for (const sp of physicalSwitchPorts) {
      const id = `port${sp.portNum}`;
      const prevCounters = prev?.portBytes.get(id);
      const rxBps = computeCounterDeltaBps(sp.rxBytes, prevCounters?.rx, dtSec);
      const txBps = computeCounterDeltaBps(sp.txBytes, prevCounters?.tx, dtSec);
      nextPortBytes.set(id, { rx: sp.rxBytes, tx: sp.txBytes });

      const isBackhaulPort = backhaulType === 'ethernet' && uplinkSwitchPortNum === sp.portNum;
      ports.push({
        id,
        label: isBackhaulPort ? `Port ${sp.portNum} (Backhaul)` : `LAN ${sp.portNum}`,
        role: isBackhaulPort ? 'backhaul' : 'lan',
        linkUp: sp.linkUp,
        speedMbps: sp.speedMbps,
        duplex: sp.duplex,
        rxBytes: sp.rxBytes,
        txBytes: sp.txBytes,
        rxBps,
        txBps,
      });
    }
  } else {
    // No swconfig switch ports: expose physical eth*/en*/lan*/wan* interfaces (never br0)
    const ethIfaces = parsed.interfaces.filter(
      (iface) => !iface.isWireless && /^(eth|en|lan|wan)/i.test(iface.name)
    );
    for (const iface of ethIfaces) {
      const prevCounters = prev?.portBytes.get(iface.name);
      const rxBps = computeCounterDeltaBps(iface.rxBytes, prevCounters?.rx, dtSec);
      const txBps = computeCounterDeltaBps(iface.txBytes, prevCounters?.tx, dtSec);
      nextPortBytes.set(iface.name, { rx: iface.rxBytes, tx: iface.txBytes });

      const isBackhaulPort = backhaulType === 'ethernet' && backhaulIface === iface.name;
      ports.push({
        id: iface.name,
        label: isBackhaulPort ? `${iface.name} (Backhaul)` : iface.name,
        role: isBackhaulPort ? 'backhaul' : 'lan',
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

  // If backhaul is Wi-Fi, include the Wi-Fi backhaul link row in ports only if we want, OR keep ports strictly Ethernet
  // (TrafficMapView displays backhaul speed & type in its own dedicated card; ports table is "Ethernet Port Negotiation")

  // Compute satellite backhaul throughput (only when comparing same backhaul interface)
  const sameBackhaul = prev && prev.backhaulIface === backhaulIface;
  const satRxBps = sameBackhaul
    ? computeCounterDeltaBps(backhaulRxBytes, prev.backhaulRx, dtSec)
    : 0;
  const satTxBps = sameBackhaul
    ? computeCounterDeltaBps(backhaulTxBytes, prev.backhaulTx, dtSec)
    : 0;

  // 4. Map connected satellite clients accurately — NEVER include main-AP / backhaul-port MACs!
  const nextClientBytes = new Map<string, { rx: number; tx: number }>();
  const clientsByMac = new Map<string, SatelliteClientLink>();

  const isExcludedInfrastructureMac = (mac: string): boolean => {
    if (!mac || mac === '00:00:00:00:00:00') return true;
    if (mac === gatewayMac) return true;
    if (localSatelliteMacs.has(mac)) return true;
    if (backhaulPeerBssids.has(mac)) return true;
    return false;
  };

  // 4a. Wi-Fi clients associated directly to AP-mode (Master) radios on this satellite
  for (const sta of parsed.wifiStations) {
    const mac = normalizeMac(sta.mac);
    if (isExcludedInfrastructureMac(mac)) continue;

    // Skip STA/Managed backhaul radio (its "station" entry is the upstream main router AP!)
    const wifiMeta = wifiInfoByIface.get(sta.iface);
    if (wifiMeta?.mode === 'managed') continue;
    if (backhaulType === 'wifi' && sta.iface === backhaulIface) continue;

    const prevC = prev?.clientBytes.get(mac);
    const rxBps = computeCounterDeltaBps(sta.rxBytes, prevC?.rx, dtSec);
    const txBps = computeCounterDeltaBps(sta.txBytes, prevC?.tx, dtSec);
    if (sta.rxBytes > 0 || sta.txBytes > 0) {
      nextClientBytes.set(mac, { rx: sta.rxBytes, tx: sta.txBytes });
    }

    const bandTag =
      wifiMeta?.freqGhz !== undefined
        ? wifiMeta.freqGhz >= 4.9
          ? `5 GHz (${sta.iface})`
          : `2.4 GHz (${sta.iface})`
        : sta.iface;

    clientsByMac.set(mac, {
      mac,
      ip: ipByMac.get(mac),
      connectionType: 'wifi',
      portOrRadio: bandTag,
      linkSpeedMbps: sta.txRateMbps || 0,
      signalDbm: sta.signalDbm,
      rxBytes: sta.rxBytes,
      txBytes: sta.txBytes,
      rxBps,
      txBps,
    });
  }

  // 4b. Wired LAN clients physically connected to downstream Ethernet ports on this satellite
  if (parsed.switchFdb.length > 0) {
    // Best source: per-physical-port switch FDB (ARL), strictly excluding CPU port 0 and uplink backhaul port
    for (const entry of parsed.switchFdb) {
      if (entry.portNum === 0) continue;
      if (backhaulType === 'ethernet' && entry.portNum === uplinkSwitchPortNum) continue;
      const mac = normalizeMac(entry.mac);
      if (isExcludedInfrastructureMac(mac) || clientsByMac.has(mac)) continue;
      const matchingPort = ports.find((p) => p.id === `port${entry.portNum}`);
      clientsByMac.set(mac, {
        mac,
        ip: ipByMac.get(mac),
        connectionType: 'ethernet',
        portOrRadio: matchingPort?.label || `LAN ${entry.portNum}`,
        linkSpeedMbps: matchingPort?.speedMbps || 0,
        rxBytes: 0,
        txBytes: 0,
        rxBps: 0,
        txBps: 0,
      });
    }
  } else if (parsed.bridgeMacs.length > 0 && parsed.bridgeIfaces.length > 0) {
    // Bridge FDB with exact brif port->iface mapping:
    // STRICTLY exclude the backhaul bridge port AND all wireless bridge ports!
    // - On Wi-Fi backhaul (backhaul on ath2): eth0 contains ONLY devices plugged into the satellite's LAN ports!
    // - On Ethernet backhaul (backhaul on eth0): eth0 is excluded so main-AP devices NEVER leak onto the satellite;
    //   any separate wired LAN bridge ports (eth1, lan2, ...) are accurately included!
    for (const bm of parsed.bridgeMacs) {
      const mac = normalizeMac(bm.mac);
      if (isExcludedInfrastructureMac(mac) || clientsByMac.has(mac)) continue;
      if (backhaulBridgePortNum !== undefined && bm.portNum === backhaulBridgePortNum) {
        continue;
      }
      const brIfaceName = bridgeIfaceByPortNum.get(bm.portNum);
      if (!brIfaceName) continue;
      const brIfaceObj = ifaceByName.get(brIfaceName);
      // Wireless clients come strictly from wifiStations (never misclassify wireless bridge MACs as Ethernet!)
      if (brIfaceObj?.isWireless || /^(ath|wlan|wl|ra|wifi)/i.test(brIfaceName)) {
        continue;
      }
      // If backhaul is Ethernet and this is the backhaul interface, never attribute its MACs to the satellite
      if (backhaulType === 'ethernet' && brIfaceName === backhaulIface) {
        continue;
      }
      const matchingPort =
        ports.find((p) => p.id === brIfaceName) ||
        ports.find((p) => p.role === 'lan' && p.linkUp && p.speedMbps > 0);
      clientsByMac.set(mac, {
        mac,
        ip: ipByMac.get(mac),
        connectionType: 'ethernet',
        portOrRadio: matchingPort?.label || brIfaceName,
        linkSpeedMbps: matchingPort?.speedMbps || brIfaceObj?.speedMbps || 0,
        rxBytes: 0,
        txBytes: 0,
        rxBps: 0,
        txBps: 0,
      });
    }
  }

  // 4c. Apply 60s client presence grace window so connected devices don't flicker on brief poll misses
  const nextRecentClients = new Map<string, CachedSatelliteClient>();
  for (const [mac, link] of clientsByMac.entries()) {
    nextRecentClients.set(mac, { link, lastSeen: now });
  }
  if (prev?.recentClients) {
    for (const [mac, cached] of prev.recentClients.entries()) {
      if (clientsByMac.has(mac)) continue;
      if (isExcludedInfrastructureMac(mac)) continue;
      if (now - cached.lastSeen <= CLIENT_PRESENCE_GRACE_MS) {
        const retained: SatelliteClientLink = {
          ...cached.link,
          rxBps: 0,
          txBps: 0,
        };
        clientsByMac.set(mac, retained);
        nextRecentClients.set(mac, { link: retained, lastSeen: cached.lastSeen });
      }
    }
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
      backhaulIface,
      portBytes: nextPortBytes,
      clientBytes: nextClientBytes,
      recentClients: nextRecentClients,
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
      const backhaulDesc =
        telemetry.backhaulSpeedMbps > 0
          ? `${telemetry.backhaulType === 'wifi' ? 'Wi-Fi' : 'Ethernet'} (${telemetry.backhaulIface}, ${telemetry.backhaulSpeedMbps} Mbps)`
          : `${telemetry.backhaulType === 'wifi' ? 'Wi-Fi' : 'Ethernet'} (${telemetry.backhaulIface})`;
      return {
        ok: true,
        summary: `Connected to ${telemetry.model || effective.host} · ${telemetry.ports.length} port(s) · Backhaul ${backhaulDesc}`,
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
