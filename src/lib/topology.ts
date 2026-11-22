import type {
  DashboardSnapshot,
  EthernetPortMetrics,
  HostSummary,
  PublicSatelliteConfig,
  SatelliteClientLink,
  SatelliteConfig,
  SatelliteInfoEntry,
  SatelliteTelemetry,
  WanDetails,
} from '../types/telemetry';
import { compareIpv4, extractWifiBand, hasTangibleTraffic } from './formatters';
import { normalizeMac } from './deviceIdentity';

export type UtilizationHealth = 'optimal' | 'moderate' | 'high' | 'saturated';

export interface IspUtilizationSummary {
  downMbps: number;
  upMbps: number;
  maxDownMbps: number;
  maxUpMbps: number;
  downPct: number;
  upPct: number;
  peakPct: number;
  dominantDirection: 'down' | 'up';
  health: UtilizationHealth;
  healthLabel: string;
}

export function computeIspUtilization(
  rxBps: number,
  txBps: number,
  maxDownMbps: number,
  maxUpMbps: number
): IspUtilizationSummary {
  const safeMaxDown = Math.max(1, Number.isFinite(maxDownMbps) ? maxDownMbps : 1000);
  const safeMaxUp = Math.max(1, Number.isFinite(maxUpMbps) ? maxUpMbps : 200);
  const downMbps = Math.max(0, (rxBps * 8) / 1_000_000);
  const upMbps = Math.max(0, (txBps * 8) / 1_000_000);

  const rawDownPct = (downMbps / safeMaxDown) * 100;
  const rawUpPct = (upMbps / safeMaxUp) * 100;
  const downPct = Number(rawDownPct.toFixed(1));
  const upPct = Number(rawUpPct.toFixed(1));
  const peakPct = Math.max(downPct, upPct);
  const dominantDirection: 'down' | 'up' = upPct > downPct ? 'up' : 'down';

  let health: UtilizationHealth = 'optimal';
  let healthLabel = 'Optimal';
  if (peakPct >= 85) {
    health = 'saturated';
    healthLabel = 'Near Capacity';
  } else if (peakPct >= 65) {
    health = 'high';
    healthLabel = 'High Load';
  } else if (peakPct >= 35) {
    health = 'moderate';
    healthLabel = 'Moderate';
  }

  return {
    downMbps,
    upMbps,
    maxDownMbps: safeMaxDown,
    maxUpMbps: safeMaxUp,
    downPct,
    upPct,
    peakPct,
    dominantDirection,
    health,
    healthLabel,
  };
}

export function formatLinkSpeed(
  speedMbps: number,
  connectionType: 'ethernet' | 'wifi' = 'ethernet',
  linkUp = true
): string {
  if (!linkUp || !Number.isFinite(speedMbps) || speedMbps <= 0) {
    return linkUp ? 'Link Up' : 'Down';
  }
  if (connectionType === 'wifi') {
    return speedMbps >= 1000
      ? `${Number((speedMbps / 1000).toFixed(1))} Gbps Wi-Fi`
      : `${Math.round(speedMbps)} Mbps Wi-Fi`;
  }
  if (speedMbps >= 10_000) return `${Math.round(speedMbps / 1000)} GbE`;
  if (speedMbps >= 2500) return `${Number((speedMbps / 1000).toFixed(1))} GbE`;
  if (speedMbps >= 1000) return '1 GbE';
  return `${Math.round(speedMbps)} MbE`;
}

export function formatWifiRatesLabel(
  rxMbps?: number,
  txMbps?: number,
  fallbackMbps?: number
): string {
  const rx = Number.isFinite(rxMbps) && (rxMbps ?? 0) > 0 ? Math.round(rxMbps!) : 0;
  const tx = Number.isFinite(txMbps) && (txMbps ?? 0) > 0 ? Math.round(txMbps!) : 0;
  if (rx > 0 && tx > 0) return `RX ${rx} / TX ${tx} Mbps`;
  if (rx > 0) return `RX ${rx} Mbps`;
  if (tx > 0) return `TX ${tx} Mbps`;
  const fb = Number.isFinite(fallbackMbps) && (fallbackMbps ?? 0) > 0 ? Math.round(fallbackMbps!) : 0;
  if (fb > 0) return `${fb} Mbps Wi-Fi`;
  return 'Wi-Fi';
}

export function toPublicSatelliteConfig(cfg: SatelliteConfig): PublicSatelliteConfig {
  return {
    id: cfg.id,
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    authMethod: cfg.authMethod,
    hasPassword: Boolean(cfg.password && cfg.password.length > 0),
    hasPrivateKey: Boolean(cfg.privateKey && cfg.privateKey.length > 0),
    backhaulInterface: cfg.backhaulInterface || '',
    pollIntervalSec: cfg.pollIntervalSec,
    enabled: cfg.enabled,
  };
}

export interface ParsedSatelliteProbe {
  hostname: string;
  uptimeSec: number;
  gatewayIp?: string;
  arpEntries: Array<{
    ip: string;
    mac: string;
  }>;
  bridgeIfaces: Array<{
    portNum: number;
    iface: string;
  }>;
  interfaces: Array<{
    name: string;
    operstate: string;
    speedMbps: number;
    duplex: 'full' | 'half' | 'unknown';
    rxBytes: number;
    txBytes: number;
    isWireless: boolean;
    mac?: string;
  }>;
  switchPorts: Array<{
    portNum: number;
    linkUp: boolean;
    speedMbps: number;
    duplex: 'full' | 'half' | 'unknown';
    rxBytes: number;
    txBytes: number;
    isCpuPort?: boolean;
  }>;
  cpuPortNums?: number[];
  switchFdb: Array<{
    portNum: number;
    mac: string;
  }>;
  bridgeMacs: Array<{
    portNum: number;
    mac: string;
    isLocal: boolean;
  }>;
  wifiIfaces: Array<{
    iface: string;
    mode: 'master' | 'managed' | 'unknown';
    essid?: string;
    isBackhaul?: boolean;
    bssid?: string;
    associated: boolean;
    bitRateMbps: number;
    freqGhz?: number;
  }>;
  wifiStations: Array<{
    iface: string;
    mac: string;
    channel?: number;
    txRateMbps: number;
    rxRateMbps?: number;
    signalDbm?: number;
    rxBytes: number;
    txBytes: number;
  }>;
  satelliteInfo: SatelliteInfoEntry[];
}

function parseSatelliteInfoBackhaulType(raw: unknown): 'ethernet' | 'wifi' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/(wired|eth|ethernet|cable|lan)/i.test(s)) return 'ethernet';
  if (/(wifi|wi-fi|wireless|5g|2\.4g|6g|ath|wlan|radio|band)/i.test(s)) return 'wifi';
  return null;
}

function parseSatelliteInfoNumeric(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeSatelliteInfoRecord(rec: Record<string, unknown>): SatelliteInfoEntry | null {
  const rawMac =
    rec.mac ?? rec.MAC ?? rec.mac_addr ?? rec.macAddress ?? rec.al_mac ?? rec.bssid;
  const rawIp =
    rec.ip ?? rec.IP ?? rec.ip_addr ?? rec.ipAddress ?? rec.host;
  const rawName =
    rec.name ?? rec.device_name ?? rec.deviceName ?? rec.hostname ?? rec.satellite_name;
  const rawModel =
    rec.model ?? rec.model_name ?? rec.modelName ?? rec.product;

  const backhaulField =
    rec.backhaul_type ??
    rec.backhaulType ??
    rec.conn_type ??
    rec.connection_type ??
    rec.connectionType ??
    rec.link_type ??
    rec.type ??
    rec.backhaul ??
    rec.interface;

  let backhaulType = parseSatelliteInfoBackhaulType(backhaulField);
  if (!backhaulType) {
    // Check band/radio hints or status fields if type wasn't explicitly wired/wifi
    if (rec.backhaul_5g || rec.backhaul_2g || rec.rssi !== undefined || rec.signal !== undefined) {
      backhaulType = 'wifi';
    } else if (typeof rec.status === 'string' && /wired|eth/i.test(rec.status)) {
      backhaulType = 'ethernet';
    } else {
      return null;
    }
  }

  const macStr =
    typeof rawMac === 'string' && /^[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}$/i.test(rawMac.trim())
      ? normalizeMac(rawMac.trim().replace(/-/g, ':'))
      : undefined;
  const ipStr =
    typeof rawIp === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(rawIp.trim())
      ? rawIp.trim()
      : undefined;

  if (!macStr && !ipStr && !rawName) return null;

  const rawSpeed = parseSatelliteInfoNumeric(
    rec.link_rate ??
      rec.linkRate ??
      rec.phyrate ??
      rec.phy_rate ??
      rec.backhaul_speed ??
      rec.backhaulSpeedMbps ??
      rec.speed ??
      rec.tx_rate ??
      rec.rx_rate
  );
  const rawSignal = parseSatelliteInfoNumeric(
    rec.rssi ?? rec.signal ?? rec.signal_dbm ?? rec.signalDbm ?? rec.backhaul_rssi
  );
  // Orbi sometimes reports positive RSSI (SNR-like) or negative dBm
  const signalDbm =
    rawSignal !== undefined
      ? rawSignal > 0 && rawSignal < 100
        ? Math.round(-95 + rawSignal)
        : Math.round(rawSignal)
      : undefined;

  const rawStatus =
    rec.backhaul_status ?? rec.backhaulStatus ?? rec.link_status ?? rec.status;
  const statusStr =
    typeof rawStatus === 'string' && rawStatus.trim() ? rawStatus.trim() : undefined;

  const bandField =
    typeof backhaulField === 'string' && /(2\.4|5g|6g)/i.test(backhaulField)
      ? backhaulField.trim()
      : typeof rec.band === 'string' && rec.band.trim()
        ? rec.band.trim()
        : undefined;

  return {
    mac: macStr,
    ip: ipStr,
    name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
    model: typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : undefined,
    backhaulType,
    backhaulStatus: statusStr,
    backhaulSpeedMbps: rawSpeed !== undefined && rawSpeed > 0 ? Math.round(rawSpeed) : undefined,
    signalDbm,
    band: bandField,
  };
}

/**
 * Parses Netgear Orbi `/usr/sbin/satelliteinfo wifi` output.
 * Supports JSON arrays/objects emitted by stock/Voxel Orbi firmware as well as
 * key-value text blocks emitted on older firmware revisions.
 */
export function parseSatelliteInfoWifi(raw: string): SatelliteInfoEntry[] {
  const trimmed = (raw || '').trim();
  if (!trimmed) return [];

  // 1. Try JSON parsing (array, single object, or wrapped object like { satellites: [...] })
  const jsonStart = trimmed.search(/[\[{]/);
  if (jsonStart >= 0) {
    const candidate = trimmed.slice(jsonStart);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const items: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Array.isArray((parsed as Record<string, unknown>).satellites)
            ? ((parsed as Record<string, unknown>).satellites as unknown[])
            : Array.isArray((parsed as Record<string, unknown>).data)
              ? ((parsed as Record<string, unknown>).data as unknown[])
              : [parsed]
          : [];
      const entries: SatelliteInfoEntry[] = [];
      for (const item of items) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const norm = normalizeSatelliteInfoRecord(item as Record<string, unknown>);
          if (norm) entries.push(norm);
        }
      }
      if (entries.length > 0) return entries;
    } catch {
      // Fall through to line-by-line parser
    }
  }

  // 2. Fallback: key-value / tabular text output
  const entries: SatelliteInfoEntry[] = [];
  let current: Record<string, unknown> = {};
  const flushCurrent = () => {
    if (Object.keys(current).length > 0) {
      const norm = normalizeSatelliteInfoRecord(current);
      if (norm) entries.push(norm);
      current = {};
    }
  };

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushCurrent();
      continue;
    }
    const kv = line.match(/^([a-zA-Z0-9_ .-]+?)\s*[:=]\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim().toLowerCase().replace(/[\s.-]+/g, '_');
      const val = kv[2].trim().replace(/^["']|["'],?$/g, '');
      if ((key === 'mac' || key === 'ip') && current[key]) {
        flushCurrent();
      }
      current[key] = val;
    }
  }
  flushCurrent();

  return entries;
}

function decodeProcRouteGatewayHex(hex: string): string | undefined {
  const clean = hex.trim().toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(clean) || clean === '00000000') return undefined;
  const b0 = parseInt(clean.slice(0, 2), 16);
  const b1 = parseInt(clean.slice(2, 4), 16);
  const b2 = parseInt(clean.slice(4, 6), 16);
  const b3 = parseInt(clean.slice(6, 8), 16);
  // Most routers (ARM/x86) are little-endian so RFC1918 first octet (192/10/172) is in b3;
  // fall back to big-endian if b0 looks like a private network and b3 does not.
  const leLooksPrivate = b3 === 192 || b3 === 10 || b3 === 172;
  const beLooksPrivate = b0 === 192 || b0 === 10 || b0 === 172;
  if (beLooksPrivate && !leLooksPrivate) {
    return `${b0}.${b1}.${b2}.${b3}`;
  }
  return `${b3}.${b2}.${b1}.${b0}`;
}

/**
 * Parses the structured output emitted by the fixed read-only SSH satellite probe snippet.
 * Supports Linux sysfs (/sys/class/net/*), Qualcomm QCA8337 swconfig, brctl showmacs,
 * and wireless stations (wlanconfig on Orbi QCA / iw station dump on OpenWrt).
 */
export function parseSatelliteSshOutput(rawOutput: string): ParsedSatelliteProbe {
  const result: ParsedSatelliteProbe = {
    hostname: '',
    uptimeSec: 0,
    arpEntries: [],
    bridgeIfaces: [],
    interfaces: [],
    switchPorts: [],
    cpuPortNums: [],
    switchFdb: [],
    bridgeMacs: [],
    wifiIfaces: [],
    wifiStations: [],
    satelliteInfo: [],
  };

  let section = '';
  const satelliteInfoLines: string[] = [];
  const taggedCpuPorts = new Set<number>();
  let currentSwitchPort: {
    portNum: number;
    linkUp: boolean;
    speedMbps: number;
    duplex: 'full' | 'half' | 'unknown';
    rxBytes: number;
    txBytes: number;
    isCpuPort?: boolean;
  } | null = null;
  let currentWifiInfo: {
    iface: string;
    mode: 'master' | 'managed' | 'unknown';
    essid?: string;
    isBackhaul?: boolean;
    bssid?: string;
    associated: boolean;
    bitRateMbps: number;
    freqGhz?: number;
  } | null = null;
  let currentWifiIface = 'ath0';
  let currentIwStation: {
    iface: string;
    mac: string;
    txRateMbps: number;
    rxRateMbps?: number;
    signalDbm?: number;
    rxBytes: number;
    txBytes: number;
  } | null = null;

  const flushSwitchPort = () => {
    if (currentSwitchPort) {
      result.switchPorts.push(currentSwitchPort);
      currentSwitchPort = null;
    }
  };

  const flushWifiInfo = () => {
    if (currentWifiInfo) {
      result.wifiIfaces.push(currentWifiInfo);
      currentWifiInfo = null;
    }
  };

  const flushIwStation = () => {
    if (currentIwStation) {
      result.wifiStations.push(currentIwStation);
      currentIwStation = null;
    }
  };

  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('===') && line.endsWith('===')) {
      flushSwitchPort();
      flushWifiInfo();
      flushIwStation();
      section = line.slice(3, -3).trim();
      continue;
    }

    if (section === 'SATELLITEINFO') {
      satelliteInfoLines.push(rawLine);
      continue;
    }

    if (section === 'META') {
      if (line.startsWith('HOST=')) {
        result.hostname = line.slice(5).trim();
      } else if (line.startsWith('UPTIME=')) {
        const up = parseFloat(line.slice(7).trim().split(/\s+/)[0] || '0');
        result.uptimeSec = Number.isFinite(up) ? Math.max(0, Math.floor(up)) : 0;
      }
      continue;
    }

    if (section === 'ROUTE') {
      // ip route show default -> "default via 192.168.1.1 dev br0"
      const viaMatch = line.match(/^default\s+via\s+(\d+\.\d+\.\d+\.\d+)/i);
      if (viaMatch) {
        result.gatewayIp = viaMatch[1];
        continue;
      }
      // /proc/net/route -> "br0 00000000 0101A8C0 0003 ..."
      const procRoute = line.match(/^\S+\s+00000000\s+([0-9A-Fa-f]{8})\s+/);
      if (procRoute && !result.gatewayIp) {
        result.gatewayIp = decodeProcRouteGatewayHex(procRoute[1]);
        continue;
      }
      // /proc/net/arp -> "192.168.1.1 0x1 0x2 aa:bb:cc:dd:ee:ff * br0"
      const arpMatch = line.match(
        /^(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i
      );
      if (arpMatch && arpMatch[2] !== '0x0') {
        const mac = normalizeMac(arpMatch[3]);
        if (mac && mac !== '00:00:00:00:00:00') {
          result.arpEntries.push({ ip: arpMatch[1], mac });
        }
      }
      continue;
    }

    if (section === 'BRIF') {
      // Format: iface|port_no (e.g. "eth0|0x1" or "ath2|4")
      const parts = line.split('|');
      if (parts.length >= 2) {
        const iface = parts[0].trim();
        const rawPort = parts[1].trim().toLowerCase();
        const portNum = rawPort.startsWith('0x')
          ? parseInt(rawPort.slice(2), 16)
          : parseInt(rawPort, 10);
        if (iface && Number.isFinite(portNum) && portNum > 0) {
          result.bridgeIfaces.push({ portNum, iface });
        }
      }
      continue;
    }

    if (section === 'IFACES') {
      // Format: name|operstate|speed|duplex|rx_bytes|tx_bytes|is_wireless[|mac]
      const parts = line.split('|');
      if (parts.length < 6) continue;
      const name = parts[0].trim();
      if (!name || name === 'lo') continue;
      const operstate = (parts[1] || 'unknown').trim().toLowerCase();
      const rawSpeed = parseInt(parts[2] || '0', 10);
      const speedMbps = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : 0;
      const rawDuplex = (parts[3] || '').trim().toLowerCase();
      const duplex: 'full' | 'half' | 'unknown' =
        rawDuplex === 'full' ? 'full' : rawDuplex === 'half' ? 'half' : 'unknown';
      const rxBytes = Math.max(0, parseInt(parts[4] || '0', 10) || 0);
      const txBytes = Math.max(0, parseInt(parts[5] || '0', 10) || 0);
      const isWireless =
        parts[6]?.trim() === '1' || /^(ath|wlan|wl|ra|wifi)\d*/i.test(name);
      const rawMac = parts[7]?.trim();
      const mac =
        rawMac && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(rawMac)
          ? normalizeMac(rawMac)
          : undefined;

      result.interfaces.push({
        name,
        operstate,
        speedMbps,
        duplex,
        rxBytes,
        txBytes,
        isWireless,
        mac,
      });
      continue;
    }

    if (section === 'SWCONFIG') {
      // Detect VLAN tagged CPU ports (e.g. "ports: 0t 1 2 3 4" or "ports: 0t 5 6t")
      if (/^VLAN\s+\d+:/i.test(line)) {
        flushSwitchPort();
        continue;
      }
      const vlanPortsMatch = line.match(/^ports:\s*(.+)$/i);
      if (vlanPortsMatch) {
        flushSwitchPort();
        for (const tok of vlanPortsMatch[1].trim().split(/\s+/)) {
          const tagged = tok.match(/^(\d+)t$/i);
          if (tagged) {
            taggedCpuPorts.add(parseInt(tagged[1], 10));
          }
        }
        continue;
      }

      // Example: "Port 1:" followed by "link: port:1 link:up speed:1000baseT full-duplex" and MIB counters
      const portHeader = line.match(/^Port\s+(\d+):/i);
      if (portHeader) {
        flushSwitchPort();
        currentSwitchPort = {
          portNum: parseInt(portHeader[1], 10),
          linkUp: false,
          speedMbps: 0,
          duplex: 'unknown',
          rxBytes: 0,
          txBytes: 0,
        };
        continue;
      }

      const inlineLink = line.match(
        /link:\s*port:(\d+)\s+link:(up|down)(?:\s+speed:(\d+)base\w*)?(?:\s+(full|half)-duplex)?/i
      );
      if (inlineLink) {
        const pNum = parseInt(inlineLink[1], 10);
        if (!currentSwitchPort || currentSwitchPort.portNum !== pNum) {
          flushSwitchPort();
          currentSwitchPort = {
            portNum: pNum,
            linkUp: false,
            speedMbps: 0,
            duplex: 'unknown',
            rxBytes: 0,
            txBytes: 0,
          };
        }
        currentSwitchPort.linkUp = inlineLink[2].toLowerCase() === 'up';
        currentSwitchPort.speedMbps = inlineLink[3] ? parseInt(inlineLink[3], 10) : 0;
        const dup = inlineLink[4]?.toLowerCase();
        currentSwitchPort.duplex = dup === 'full' ? 'full' : dup === 'half' ? 'half' : 'unknown';
        continue;
      }

      if (currentSwitchPort) {
        const rxMatch = line.match(/^(?:RxGoodByte|RxByte|rx_bytes)\s*:\s*(\d+)/i);
        if (rxMatch) {
          currentSwitchPort.rxBytes = parseInt(rxMatch[1], 10) || 0;
          continue;
        }
        const txMatch = line.match(/^(?:TxByte|TxGoodByte|tx_bytes)\s*:\s*(\d+)/i);
        if (txMatch) {
          currentSwitchPort.txBytes = parseInt(txMatch[1], 10) || 0;
          continue;
        }
      }
      continue;
    }

    if (section === 'SWITCH_FDB') {
      // Format A (swconfig dump_arl): "Port 2: MAC aa:bb:cc:dd:ee:ff" or "PORT:2 MAC:aa:bb:cc:dd:ee:ff"
      const arl1 = line.match(/port\s*[:=]?\s*(\d+).*?([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i);
      if (arl1) {
        const portNum = parseInt(arl1[1], 10);
        const mac = normalizeMac(arl1[2].replace(/-/g, ':'));
        if (Number.isFinite(portNum) && mac) {
          result.switchFdb.push({ portNum, mac });
        }
        continue;
      }
      // Format B (ssdk_sh fdb entry show): "[addr]:aa-bb-cc-dd-ee-ff ... [dest_info]:port2"
      const arl2 = line.match(/([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}).*?port\s*[:=]?\s*(\d+)/i);
      if (arl2) {
        const mac = normalizeMac(arl2[1].replace(/-/g, ':'));
        const portNum = parseInt(arl2[2], 10);
        if (Number.isFinite(portNum) && mac) {
          result.switchFdb.push({ portNum, mac });
        }
        continue;
      }
      // Format C (QCA ARL bitmask): "MAC: aa:bb:cc:dd:ee:ff PORTMAP: 0x04"
      const arlMask = line.match(/([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}).*?portmap\s*[:=]?\s*0x([0-9a-f]+)/i);
      if (arlMask) {
        const mac = normalizeMac(arlMask[1].replace(/-/g, ':'));
        const mask = parseInt(arlMask[2], 16);
        if (mac && mask > 0 && (mask & (mask - 1)) === 0) {
          const portNum = Math.round(Math.log2(mask));
          result.switchFdb.push({ portNum, mac });
        }
      }
      continue;
    }

    if (section === 'BRCTL') {
      // brctl showmacs br0: "  1   b4:fb:e4:12:77:09   no   1.23"
      const m = line.match(/^(\d+)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(yes|no)\b/i);
      if (m) {
        const isLocal = m[3].toLowerCase() === 'yes';
        if (!isLocal) {
          result.bridgeMacs.push({
            portNum: parseInt(m[1], 10),
            mac: normalizeMac(m[2]),
            isLocal,
          });
        }
      }
      continue;
    }

    if (section === 'WIFI_INFO') {
      // iwconfig header line: "ath2      IEEE 802.11ac  ESSID:..." (no leading whitespace in rawLine)
      const iwcfgHeader = rawLine.match(/^([a-zA-Z0-9._-]+)\s+IEEE\s+802\.11/i);
      if (iwcfgHeader) {
        flushWifiInfo();
        currentWifiInfo = {
          iface: iwcfgHeader[1].trim(),
          mode: 'unknown',
          associated: false,
          bitRateMbps: 0,
        };
      }
      // iw dev header: "Interface wlan0"
      const iwDevHeader = line.match(/^Interface\s+([a-zA-Z0-9._-]+)/i);
      if (iwDevHeader) {
        flushWifiInfo();
        currentWifiInfo = {
          iface: iwDevHeader[1].trim(),
          mode: 'unknown',
          associated: false,
          bitRateMbps: 0,
        };
        continue;
      }

      if (currentWifiInfo) {
        const essidMatch = line.match(/ESSID:"([^"]*)"/i);
        if (essidMatch) {
          currentWifiInfo.essid = essidMatch[1];
          if (/orbi_hidden|backhaul|bh_/i.test(essidMatch[1])) {
            currentWifiInfo.isBackhaul = true;
          }
        } else if (/ESSID:off\/any/i.test(line)) {
          currentWifiInfo.isBackhaul = true;
        }
        const modeMatch = line.match(/\bMode:(Master|Managed|AP|STA)\b/i) || line.match(/^type\s+(AP|managed)\b/i);
        if (modeMatch) {
          const m = modeMatch[1].toLowerCase();
          currentWifiInfo.mode = m === 'master' || m === 'ap' ? 'master' : 'managed';
        }
        const apMatch = line.match(/Access Point:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
        if (apMatch) {
          const bssid = normalizeMac(apMatch[1]);
          if (bssid && bssid !== '00:00:00:00:00:00') {
            currentWifiInfo.bssid = bssid;
            currentWifiInfo.associated = true;
          }
        } else if (/Access Point:\s*Not-Associated/i.test(line)) {
          currentWifiInfo.associated = false;
        }
        const rateMatch = line.match(/Bit Rate[:=]\s*([\d.]+)\s*(Gb|Mb)\/s/i);
        if (rateMatch) {
          const num = parseFloat(rateMatch[1]) || 0;
          currentWifiInfo.bitRateMbps =
            rateMatch[2].toLowerCase() === 'gb' ? Math.round(num * 1000) : Math.round(num);
        }
        const freqMatch = line.match(/Frequency[:=]\s*([\d.]+)\s*GHz/i);
        if (freqMatch) {
          currentWifiInfo.freqGhz = parseFloat(freqMatch[1]) || undefined;
        }
      }
      continue;
    }

    if (section === 'WIFI') {
      if (line.startsWith('WIFI_IF=')) {
        flushIwStation();
        currentWifiIface = line.slice(8).trim() || 'ath0';
        continue;
      }

      // iw dev <iface> station dump format
      const iwHeader = line.match(/^Station\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+/i);
      if (iwHeader) {
        flushIwStation();
        currentIwStation = {
          iface: currentWifiIface,
          mac: normalizeMac(iwHeader[1]),
          txRateMbps: 0,
          rxBytes: 0,
          txBytes: 0,
        };
        continue;
      }

      if (currentIwStation) {
        const rxB = line.match(/^rx bytes:\s*(\d+)/i);
        if (rxB) {
          currentIwStation.rxBytes = parseInt(rxB[1], 10) || 0;
          continue;
        }
        const txB = line.match(/^tx bytes:\s*(\d+)/i);
        if (txB) {
          currentIwStation.txBytes = parseInt(txB[1], 10) || 0;
          continue;
        }
        const sig = line.match(/^signal:\s*(-?\d+)/i);
        if (sig) {
          currentIwStation.signalDbm = parseInt(sig[1], 10);
          continue;
        }
        const txRate = line.match(/^tx bitrate:\s*([\d.]+)\s*MBit/i);
        if (txRate) {
          currentIwStation.txRateMbps = Math.round(parseFloat(txRate[1]) || 0);
          continue;
        }
        const rxRate = line.match(/^rx bitrate:\s*([\d.]+)\s*MBit/i);
        if (rxRate) {
          currentIwStation.rxRateMbps = Math.round(parseFloat(rxRate[1]) || 0);
          continue;
        }
        continue;
      }

      // Orbi QCA wlanconfig athX list sta format:
      // ADDR AID CHAN TXRATE RXRATE RSSI ...
      const qca = line.match(
        /^([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\d+\s+(\d+)\s+(\d+)M\s+(\d+)M\s+(-?\d+)/i
      );
      if (qca) {
        const chan = parseInt(qca[2], 10) || undefined;
        const txRate = parseInt(qca[3], 10) || 0;
        const rxRate = parseInt(qca[4], 10) || 0;
        const rssi = parseInt(qca[5], 10) || 0;
        result.wifiStations.push({
          iface: currentWifiIface,
          mac: normalizeMac(qca[1]),
          channel: chan,
          txRateMbps: txRate,
          rxRateMbps: rxRate,
          signalDbm: rssi > 0 ? -95 + rssi : rssi,
          rxBytes: 0,
          txBytes: 0,
        });
      }
    }
  }

  flushSwitchPort();
  flushWifiInfo();
  flushIwStation();
  if (taggedCpuPorts.size > 0) {
    result.cpuPortNums = Array.from(taggedCpuPorts);
    for (const sp of result.switchPorts) {
      if (taggedCpuPorts.has(sp.portNum)) {
        sp.isCpuPort = true;
      }
    }
  }
  if (satelliteInfoLines.length > 0) {
    result.satelliteInfo = parseSatelliteInfoWifi(satelliteInfoLines.join('\n'));
  }
  return result;
}

export type TopologyNodeKind = 'internet' | 'router' | 'satellite' | 'client';
export type TopologyDeviceIcon =
  | 'internet'
  | 'router'
  | 'satellite'
  | 'tv'
  | 'phone'
  | 'laptop'
  | 'nas'
  | 'server'
  | 'gaming'
  | 'iot'
  | 'device';

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  icon: TopologyDeviceIcon;
  label: string;
  sublabel?: string;
  ip?: string;
  mac?: string;
  vendor?: string;
  parentId: string | null;
  column: number; // 0=internet, 1=router, 2=satellites/router-clients, 3=satellite-clients
  x: number;
  y: number;
  rxBps: number;
  txBps: number;
  active: boolean;
  connected: boolean;
  connectionType?: 'ethernet' | 'wifi';
  linkSpeedMbps?: number;
  linkSpeedLabel?: string;
  wifiRxMbps?: number;
  wifiTxMbps?: number;
  wifiSignalDbm?: number;
  portLabel?: string;
  childCount: number;
  collapsed: boolean;
  ports?: EthernetPortMetrics[];
  satellite?: SatelliteTelemetry;
  host?: HostSummary;
  wan?: WanDetails;
}

export interface TopologyEdge {
  id: string;
  sourceId: string;
  targetId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  rxBps: number;
  txBps: number;
  active: boolean;
  connectionType?: 'ethernet' | 'wifi';
  linkSpeedMbps: number;
  linkSpeedLabel: string;
  portLabel?: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  width: number;
  height: number;
  junctions: Array<{
    parentId: string;
    x: number;
    y: number;
    collapsed: boolean;
    hiddenCount: number;
  }>;
}

export function inferTopologyDeviceIcon(host: HostSummary): TopologyDeviceIcon {
  const hay = `${host.hostname} ${host.vendor} ${host.deviceHint || ''}`.toLowerCase();
  if (/(apple\s*tv|atv|roku|chromecast|shield|fire\s*tv|smart\s*tv|tv)/.test(hay)) return 'tv';
  if (/(iphone|pixel|phone|galaxy|android|mobile|ipad)/.test(hay)) return 'phone';
  if (/(macbook|laptop|thinkpad|surface|notebook)/.test(hay)) return 'laptop';
  if (/(synology|qnap|truenas|nas|storage)/.test(hay)) return 'nas';
  if (/(docker|homelab|server|nuc|proxmox|linux|raspberry|pi\b)/.test(hay)) return 'server';
  if (/(gaming|xbox|playstation|ps5|steam|switch|rig)/.test(hay)) return 'gaming';
  if (/(ecobee|nest|thermostat|camera|ring|iot|sonos|homepod|hue|bulb)/.test(hay)) return 'iot';
  return 'device';
}

export interface BuildTopologyOptions {
  collapsedIds?: Set<string>;
  showIdleClients?: boolean;
  searchQuery?: string;
}

const ROW_Y = [76, 232, 408, 584];
const LEAF_SPACING_X = 166;
const LEFT_PAD = 110;
const RIGHT_PAD = 110;

export function buildTopologyGraph(
  snapshot: DashboardSnapshot,
  options: BuildTopologyOptions = {}
): TopologyGraph {
  const collapsedIds = options.collapsedIds ?? new Set<string>();
  const showIdleClients = options.showIdleClients !== false;
  const search = (options.searchQuery || '').trim().toLowerCase();

  const topology = snapshot.topology || {
    routerPorts: [],
    routerWanSpeedMbps: 1000,
    routerClients: [],
    satellites: [],
    satelliteConfigs: [],
  };

  const hostByMac = new Map<string, HostSummary>();
  const hostByIp = new Map<string, HostSummary>();
  for (const h of snapshot.hosts) {
    const m = normalizeMac(h.mac);
    if (m && m !== '00:00:00:00:00:00') hostByMac.set(m, h);
    hostByIp.set(h.ip, h);
  }

  // Router direct link metadata by MAC / IP
  const routerClientByMac = new Map<string, SatelliteClientLink>();
  const routerClientByIp = new Map<string, SatelliteClientLink>();
  const routerWifiMacs = new Set<string>();
  const routerWiredMacs = new Set<string>();
  for (const rc of topology.routerClients || []) {
    const m = normalizeMac(rc.mac);
    if (m) {
      routerClientByMac.set(m, rc);
      if (rc.connectionType === 'wifi') routerWifiMacs.add(m);
      else if (rc.connectionType === 'ethernet') routerWiredMacs.add(m);
    }
    if (rc.ip) routerClientByIp.set(rc.ip, rc);
  }

  // Track which host IPs are assigned to a satellite
  const assignedHostIps = new Set<string>();
  const satHostsMap = new Map<
    string,
    Array<{ host: HostSummary; link?: SatelliteClientLink }>
  >();

  const satellites = topology.satellites || [];
  const satIpSet = new Set(satellites.map((s) => s.host));

  for (const sat of satellites) {
    const entries: Array<{ host: HostSummary; link?: SatelliteClientLink }> = [];
    for (const cLink of sat.clients || []) {
      const m = normalizeMac(cLink.mac);
      // Never attribute a client that is directly attached to the main router's wired switch port or Wi-Fi radio to a satellite's L2 bridge
      if (m && routerWifiMacs.has(m) && cLink.connectionType !== 'wifi') {
        continue;
      }
      if (m && routerWiredMacs.has(m) && cLink.connectionType !== 'ethernet') {
        continue;
      }
      const matched =
        (m ? hostByMac.get(m) : undefined) || (cLink.ip ? hostByIp.get(cLink.ip) : undefined);
      if (matched && !assignedHostIps.has(matched.ip) && !satIpSet.has(matched.ip)) {
        assignedHostIps.add(matched.ip);
        entries.push({ host: matched, link: cLink });
      }
    }
    entries.sort(
      (a, b) =>
        b.host.rxBps + b.host.txBps - (a.host.rxBps + a.host.txBps) ||
        compareIpv4(a.host.ip, b.host.ip)
    );
    satHostsMap.set(sat.id, entries);
  }

  // Direct router clients = remaining LAN hosts not under a satellite and not a satellite IP itself
  const routerDirectClients: Array<{ host: HostSummary; link?: SatelliteClientLink }> = [];
  for (const h of snapshot.hosts) {
    if (assignedHostIps.has(h.ip) || satIpSet.has(h.ip)) continue;
    const m = normalizeMac(h.mac);
    const link = (m ? routerClientByMac.get(m) : undefined) || routerClientByIp.get(h.ip);
    routerDirectClients.push({ host: h, link });
  }
  routerDirectClients.sort(
    (a, b) =>
      b.host.rxBps + b.host.txBps - (a.host.rxBps + a.host.txBps) ||
      compareIpv4(a.host.ip, b.host.ip)
  );

  const matchesSearch = (label: string, ip?: string, mac?: string, vendor?: string): boolean => {
    if (!search) return true;
    const hay = `${label} ${ip || ''} ${mac || ''} ${vendor || ''}`.toLowerCase();
    return hay.includes(search);
  };

  const filterHostEntry = (entry: { host: HostSummary; link?: SatelliteClientLink }): boolean => {
    const isActive = hasTangibleTraffic(entry.host.rxBps, entry.host.txBps);
    if (!showIdleClients && !isActive) return false;
    return matchesSearch(
      entry.host.hostname,
      entry.host.ip,
      entry.host.mac,
      entry.host.vendor
    );
  };

  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const junctions: TopologyGraph['junctions'] = [];

  const internetId = 'internet';
  const routerId = 'router';

  // Determine Row 2 items (Satellites + Direct Router Clients)
  type Row2Item =
    | {
        kind: 'satellite';
        sat: SatelliteTelemetry;
        children: Array<{ host: HostSummary; link?: SatelliteClientLink }>;
        totalChildrenCount: number;
      }
    | {
        kind: 'client';
        entry: { host: HostSummary; link?: SatelliteClientLink };
      };

  const row2Items: Row2Item[] = [];
  for (const sat of satellites) {
    const allChildren = satHostsMap.get(sat.id) || [];
    const visibleChildren = allChildren.filter(filterHostEntry);
    if (
      !search ||
      matchesSearch(sat.name, sat.host, undefined, sat.model) ||
      visibleChildren.length > 0
    ) {
      row2Items.push({
        kind: 'satellite',
        sat,
        children: visibleChildren,
        totalChildrenCount: allChildren.length,
      });
    }
  }

  for (const entry of routerDirectClients) {
    if (filterHostEntry(entry)) {
      row2Items.push({ kind: 'client', entry });
    }
  }

  const routerCollapsed = collapsedIds.has(routerId);
  const visibleRow2 = routerCollapsed ? [] : row2Items;

  // Layout X positions left-to-right across leaves so vertical branches never collide
  let cursorX = LEFT_PAD;
  const row2Placed: Array<{
    item: Row2Item;
    x: number;
    childXs: number[];
  }> = [];

  for (const item of visibleRow2) {
    if (item.kind === 'satellite') {
      const satCollapsed = collapsedIds.has(`sat:${item.sat.id}`);
      if (!satCollapsed && item.children.length > 0) {
        const childXs: number[] = [];
        for (let i = 0; i < item.children.length; i++) {
          childXs.push(cursorX);
          cursorX += LEAF_SPACING_X;
        }
        const midX = Math.round((childXs[0] + childXs[childXs.length - 1]) / 2);
        row2Placed.push({ item, x: midX, childXs });
      } else {
        row2Placed.push({ item, x: cursorX, childXs: [] });
        cursorX += LEAF_SPACING_X;
      }
    } else {
      row2Placed.push({ item, x: cursorX, childXs: [] });
      cursorX += LEAF_SPACING_X;
    }
  }

  const rawContentWidth =
    row2Placed.length > 0 ? cursorX - LEAF_SPACING_X + LEFT_PAD + RIGHT_PAD : 820;
  const totalWidth = Math.max(820, rawContentWidth);
  // Center the tree horizontally if narrower than minimum viewport width
  const shiftX =
    row2Placed.length > 0 && rawContentWidth < totalWidth
      ? Math.round((totalWidth - rawContentWidth) / 2)
      : 0;
  for (const placed of row2Placed) {
    placed.x += shiftX;
    for (let i = 0; i < placed.childXs.length; i++) {
      placed.childXs[i] += shiftX;
    }
  }

  const rootX =
    row2Placed.length > 0
      ? Math.round((row2Placed[0].x + row2Placed[row2Placed.length - 1].x) / 2)
      : Math.round(totalWidth / 2);

  const wanDetails = topology.wan;
  const wanSpeed = wanDetails?.linkSpeedMbps || topology.routerWanSpeedMbps || 1000;
  const wanActive = hasTangibleTraffic(snapshot.kpis.rxBps, snapshot.kpis.txBps);
  const ispLabel = snapshot.serverConfig.ispName?.trim() || 'Internet';
  const internetSublabel = wanDetails?.ip
    ? `${wanDetails.ip} · ${formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected)}`
    : `${snapshot.serverConfig.ispMaxDownMbps} / ${snapshot.serverConfig.ispMaxUpMbps} Mbps`;

  nodes.push({
    id: internetId,
    kind: 'internet',
    icon: 'internet',
    label: ispLabel,
    sublabel: internetSublabel,
    ip: wanDetails?.ip,
    mac: wanDetails?.mac,
    parentId: null,
    column: 0,
    x: rootX,
    y: ROW_Y[0],
    rxBps: snapshot.kpis.rxBps,
    txBps: snapshot.kpis.txBps,
    active: wanActive,
    connected: snapshot.probe.connected,
    connectionType: 'ethernet',
    linkSpeedMbps: wanSpeed,
    linkSpeedLabel: formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected),
    portLabel: wanDetails?.iface || snapshot.probe.iface || 'eth0',
    childCount: 1,
    collapsed: false,
    wan: wanDetails,
  });

  nodes.push({
    id: routerId,
    kind: 'router',
    icon: 'router',
    label: snapshot.probe.hostname || 'Orbi Router',
    sublabel: `WAN ${formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected)}`,
    parentId: internetId,
    column: 1,
    x: rootX,
    y: ROW_Y[1],
    rxBps: snapshot.kpis.rxBps,
    txBps: snapshot.kpis.txBps,
    active: wanActive,
    connected: snapshot.probe.connected,
    connectionType: 'ethernet',
    linkSpeedMbps: wanSpeed,
    linkSpeedLabel: formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected),
    portLabel: snapshot.probe.iface || 'eth0',
    childCount: row2Items.length,
    collapsed: routerCollapsed,
    ports: topology.routerPorts,
  });

  edges.push({
    id: `${internetId}->${routerId}`,
    sourceId: internetId,
    targetId: routerId,
    x1: rootX,
    y1: ROW_Y[0] + 54,
    x2: rootX,
    y2: ROW_Y[1] - 28,
    rxBps: snapshot.kpis.rxBps,
    txBps: snapshot.kpis.txBps,
    active: wanActive,
    connectionType: 'ethernet',
    linkSpeedMbps: wanSpeed,
    linkSpeedLabel: formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected),
    portLabel: snapshot.probe.iface || 'eth0',
  });

  const routerJunctionY = ROW_Y[1] + 76;
  if (row2Items.length > 0) {
    junctions.push({
      parentId: routerId,
      x: rootX,
      y: routerJunctionY,
      collapsed: routerCollapsed,
      hiddenCount: row2Items.length,
    });
  }

  let hasRow3 = false;

  const resolveClientDisplay = (host: HostSummary, link?: SatelliteClientLink) => {
    const connType: 'ethernet' | 'wifi' =
      link?.connectionType === 'wifi' || host.connectionType === 'wifi'
        ? 'wifi'
        : 'ethernet';
    const wifiRxMbps = connType === 'wifi' ? (link?.wifiRxMbps ?? host.wifiRxMbps) : undefined;
    const wifiTxMbps = connType === 'wifi' ? (link?.wifiTxMbps ?? host.wifiTxMbps) : undefined;
    const wifiSignalDbm = connType === 'wifi' ? (link?.signalDbm ?? host.wifiSignalDbm) : undefined;
    const wifiBand =
      connType === 'wifi'
        ? (link?.wifiBand || host.wifiBand || extractWifiBand(link?.portOrRadio || host.linkRadioOrPort))
        : undefined;
    const speedMbps =
      connType === 'wifi'
        ? Math.max(wifiRxMbps || 0, wifiTxMbps || 0, link?.linkSpeedMbps || 0)
        : 0;
    const speedLabel =
      connType === 'wifi'
        ? formatWifiRatesLabel(wifiRxMbps, wifiTxMbps, link?.linkSpeedMbps)
        : 'Ethernet';
    const portLabel =
      connType === 'wifi'
        ? wifiBand || 'Wi-Fi'
        : link?.portOrRadio || 'Ethernet';
    return { connType, wifiRxMbps, wifiTxMbps, wifiSignalDbm, wifiBand, speedMbps, speedLabel, portLabel };
  };

  for (const placed of row2Placed) {
    if (placed.item.kind === 'satellite') {
      const sat = placed.item.sat;
      const satNodeId = `sat:${sat.id}`;
      const satCollapsed = collapsedIds.has(satNodeId);

      const childRxSum = placed.item.children.reduce((acc, c) => acc + c.host.rxBps, 0);
      const childTxSum = placed.item.children.reduce((acc, c) => acc + c.host.txBps, 0);
      const satRx = sat.rxBps > 0 ? sat.rxBps : childRxSum;
      const satTx = sat.txBps > 0 ? sat.txBps : childTxSum;
      const satActive = hasTangibleTraffic(satRx, satTx);
      const backhaulLabel = formatLinkSpeed(
        sat.backhaulSpeedMbps,
        sat.backhaulType,
        sat.connected
      );

      nodes.push({
        id: satNodeId,
        kind: 'satellite',
        icon: 'satellite',
        label: sat.name,
        sublabel: `${sat.host} · ${backhaulLabel}`,
        ip: sat.host,
        parentId: routerId,
        column: 2,
        x: placed.x,
        y: ROW_Y[2],
        rxBps: satRx,
        txBps: satTx,
        active: satActive,
        connected: sat.connected,
        connectionType: sat.backhaulType,
        linkSpeedMbps: sat.backhaulSpeedMbps,
        linkSpeedLabel: backhaulLabel,
        portLabel: sat.backhaulIface,
        childCount: placed.item.children.length,
        collapsed: satCollapsed,
        ports: sat.ports,
        satellite: sat,
      });

      edges.push({
        id: `${routerId}->${satNodeId}`,
        sourceId: routerId,
        targetId: satNodeId,
        x1: rootX,
        y1: routerJunctionY,
        x2: placed.x,
        y2: ROW_Y[2] - 32,
        rxBps: satRx,
        txBps: satTx,
        active: satActive,
        connectionType: sat.backhaulType,
        linkSpeedMbps: sat.backhaulSpeedMbps,
        linkSpeedLabel: backhaulLabel,
        portLabel: sat.backhaulIface,
      });

      const satJunctionY = ROW_Y[2] + 84;
      if (placed.item.children.length > 0) {
        junctions.push({
          parentId: satNodeId,
          x: placed.x,
          y: satJunctionY,
          collapsed: satCollapsed,
          hiddenCount: placed.item.children.length,
        });
      }

      if (!satCollapsed) {
        placed.item.children.forEach((child, idx) => {
          hasRow3 = true;
          const cx = placed.childXs[idx];
          const clientNodeId = `client:${child.host.ip}`;
          const info = resolveClientDisplay(child.host, child.link);
          const clientRx =
            child.host.rxBps > 0 ? child.host.rxBps : child.link?.rxBps || 0;
          const clientTx =
            child.host.txBps > 0 ? child.host.txBps : child.link?.txBps || 0;
          const clientActive = hasTangibleTraffic(clientRx, clientTx);

          nodes.push({
            id: clientNodeId,
            kind: 'client',
            icon: inferTopologyDeviceIcon(child.host),
            label: child.host.hostname,
            sublabel: info.connType === 'wifi'
              ? (info.wifiBand ? `${info.wifiBand} · ${info.speedLabel}` : info.speedLabel)
              : 'Ethernet',
            ip: child.host.ip,
            mac: child.host.mac,
            vendor: child.host.vendor,
            parentId: satNodeId,
            column: 3,
            x: cx,
            y: ROW_Y[3],
            rxBps: clientRx,
            txBps: clientTx,
            active: clientActive,
            connected: true,
            connectionType: info.connType,
            linkSpeedMbps: info.speedMbps,
            linkSpeedLabel: info.speedLabel,
            wifiRxMbps: info.wifiRxMbps,
            wifiTxMbps: info.wifiTxMbps,
            wifiSignalDbm: info.wifiSignalDbm,
            portLabel: info.portLabel,
            childCount: 0,
            collapsed: false,
            host: child.host,
          });

          edges.push({
            id: `${satNodeId}->${clientNodeId}`,
            sourceId: satNodeId,
            targetId: clientNodeId,
            x1: placed.x,
            y1: satJunctionY,
            x2: cx,
            y2: ROW_Y[3] - 28,
            rxBps: clientRx,
            txBps: clientTx,
            active: clientActive,
            connectionType: info.connType,
            linkSpeedMbps: info.speedMbps,
            linkSpeedLabel: info.speedLabel,
            portLabel: info.portLabel,
          });
        });
      }
    } else {
      const { host, link } = placed.item.entry;
      const clientNodeId = `client:${host.ip}`;
      const info = resolveClientDisplay(host, link);
      const clientActive = hasTangibleTraffic(host.rxBps, host.txBps);

      nodes.push({
        id: clientNodeId,
        kind: 'client',
        icon: inferTopologyDeviceIcon(host),
        label: host.hostname,
        sublabel: info.connType === 'wifi'
          ? (info.wifiBand ? `${info.wifiBand} · ${info.speedLabel}` : info.speedLabel)
          : 'Ethernet',
        ip: host.ip,
        mac: host.mac,
        vendor: host.vendor,
        parentId: routerId,
        column: 2,
        x: placed.x,
        y: ROW_Y[2],
        rxBps: host.rxBps,
        txBps: host.txBps,
        active: clientActive,
        connected: true,
        connectionType: info.connType,
        linkSpeedMbps: info.speedMbps,
        linkSpeedLabel: info.speedLabel,
        wifiRxMbps: info.wifiRxMbps,
        wifiTxMbps: info.wifiTxMbps,
        wifiSignalDbm: info.wifiSignalDbm,
        portLabel: info.portLabel,
        childCount: 0,
        collapsed: false,
        host,
      });

      edges.push({
        id: `${routerId}->${clientNodeId}`,
        sourceId: routerId,
        targetId: clientNodeId,
        x1: rootX,
        y1: routerJunctionY,
        x2: placed.x,
        y2: ROW_Y[2] - 28,
        rxBps: host.rxBps,
        txBps: host.txBps,
        active: clientActive,
        connectionType: info.connType,
        linkSpeedMbps: info.speedMbps,
        linkSpeedLabel: info.speedLabel,
        portLabel: info.portLabel,
      });
    }
  }

  const totalHeight = hasRow3 ? 710 : 540;

  return {
    nodes,
    edges,
    width: totalWidth,
    height: totalHeight,
    junctions,
  };
}
