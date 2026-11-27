import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { isPrivateIp } from '../src/lib/formatters';

export interface DiscoveredServiceIdentity {
  ip: string;
  name: string;
  protocol: string;
  model?: string;
  services: string[];
  score: number;
  updatedAt: number;
}

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  rdata: Buffer;
  stringValue?: string;
  ipValue?: string;
  srvTarget?: string;
  srvPort?: number;
  txtMap?: Record<string, string>;
}

const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_SRV = 33;

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const NBNS_PORT = 137;

const MDNS_SERVICE_PROBES: ReadonlyArray<{
  ptr: string;
  label: string;
  priority: number;
}> = [
  { ptr: '_googlecast._tcp.local', label: 'Google Cast', priority: 95 },
  { ptr: '_airplay._tcp.local', label: 'AirPlay', priority: 92 },
  { ptr: '_raop._tcp.local', label: 'AirPlay Audio', priority: 86 },
  { ptr: '_companion-link._tcp.local', label: 'Apple Companion', priority: 90 },
  { ptr: '_apple-mobdev2._tcp.local', label: 'Apple Mobile', priority: 85 },
  { ptr: '_adb-tls-connect._tcp.local', label: 'ADB', priority: 88 },
  { ptr: '_adb-tls-pairing._tcp.local', label: 'ADB', priority: 84 },
  { ptr: '_adb._tcp.local', label: 'ADB', priority: 88 },
  { ptr: '_spotify-connect._tcp.local', label: 'Spotify Connect', priority: 88 },
  { ptr: '_sonos._tcp.local', label: 'Sonos', priority: 90 },
  { ptr: '_hap._tcp.local', label: 'HomeKit', priority: 86 },
  { ptr: '_matter._tcp.local', label: 'Matter', priority: 84 },
  { ptr: '_ipp._tcp.local', label: 'IPP Printer', priority: 86 },
  { ptr: '_printer._tcp.local', label: 'Printer', priority: 84 },
  { ptr: '_smb._tcp.local', label: 'SMB', priority: 80 },
  { ptr: '_sftp-ssh._tcp.local', label: 'SSH', priority: 76 },
  { ptr: '_ssh._tcp.local', label: 'SSH', priority: 76 },
  { ptr: '_http._tcp.local', label: 'HTTP', priority: 72 },
  { ptr: '_workstation._tcp.local', label: 'Workstation', priority: 75 },
  { ptr: '_esphomelib._tcp.local', label: 'ESPHome', priority: 82 },
  { ptr: '_home-assistant._tcp.local', label: 'Home Assistant', priority: 85 },
  { ptr: '_nvstream._tcp.local', label: 'NVIDIA GameStream', priority: 80 },
];

const SERVICE_META_BY_SUFFIX = new Map(
  MDNS_SERVICE_PROBES.map((s) => [s.ptr.toLowerCase(), s])
);

export function isSafeLanTargetIp(ip: string): boolean {
  if (!ip || net.isIPv4(ip) === false) return false;
  if (!isPrivateIp(ip)) return false;
  if (ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('0.')) return false;
  return true;
}

function decodeDnsName(buf: Buffer, startOffset: number): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let offset = startOffset;
  let jumped = false;
  let nextOffset = startOffset;
  const seenOffsets = new Set<number>();

  while (offset < buf.length) {
    if (seenOffsets.has(offset)) return null;
    seenOffsets.add(offset);

    const len = buf[offset];
    if (len === 0) {
      if (!jumped) nextOffset = offset + 1;
      break;
    }

    // Compression pointer (top 2 bits = 11)
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) {
        nextOffset = offset + 2;
        jumped = true;
      }
      offset = ptr;
      continue;
    }

    // Invalid label bits
    if ((len & 0xc0) !== 0) return null;

    offset += 1;
    if (offset + len > buf.length) return null;
    labels.push(buf.subarray(offset, offset + len).toString('utf8'));
    offset += len;
    if (!jumped) nextOffset = offset;
  }

  return { name: labels.join('.'), nextOffset };
}

function encodeDnsName(name: string): Buffer {
  const clean = name.trim().replace(/\.+$/, '');
  const parts = clean.split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8');
    if (label.length === 0 || label.length > 63) continue;
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function buildDnsQueryPacket(
  qname: string,
  qtype: number = DNS_TYPE_PTR,
  unicastResponse = false
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID = 0 for mDNS
  header.writeUInt16BE(0, 2); // Standard query
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const nameBuf = encodeDnsName(qname);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2); // IN class (+ QU bit if unicast)
  return Buffer.concat([header, nameBuf, tail]);
}

function parseTxtRdata(rdata: Buffer): Record<string, string> {
  const map: Record<string, string> = {};
  let offset = 0;
  while (offset < rdata.length) {
    const len = rdata[offset];
    offset += 1;
    if (len === 0 || offset + len > rdata.length) break;
    const entry = rdata.subarray(offset, offset + len).toString('utf8');
    offset += len;
    const eq = entry.indexOf('=');
    if (eq > 0) {
      const k = entry.slice(0, eq).trim().toLowerCase();
      const v = entry.slice(eq + 1).trim();
      if (k && v && !(k in map)) {
        map[k] = v;
      }
    }
  }
  return map;
}

export function parseDnsPacket(buf: Buffer): DnsRecord[] {
  if (!buf || buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let offset = 12;
  for (let i = 0; i < qdCount; i += 1) {
    const q = decodeDnsName(buf, offset);
    if (!q || q.nextOffset + 4 > buf.length) return [];
    offset = q.nextOffset + 4;
  }

  const totalRr = Math.min(256, anCount + nsCount + arCount);
  const records: DnsRecord[] = [];

  for (let i = 0; i < totalRr; i += 1) {
    if (offset >= buf.length) break;
    const decoded = decodeDnsName(buf, offset);
    if (!decoded || decoded.nextOffset + 10 > buf.length) break;
    offset = decoded.nextOffset;

    const type = buf.readUInt16BE(offset);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdLen = buf.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdLen > buf.length) break;

    const rdataStart = offset;
    const rdata = buf.subarray(rdataStart, rdataStart + rdLen);
    offset += rdLen;

    const rec: DnsRecord = {
      name: decoded.name,
      type,
      ttl,
      rdata,
    };

    if (type === DNS_TYPE_A && rdLen === 4) {
      rec.ipValue = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
    } else if (type === DNS_TYPE_PTR) {
      const ptrTarget = decodeDnsName(buf, rdataStart);
      if (ptrTarget?.name) rec.stringValue = ptrTarget.name;
    } else if (type === DNS_TYPE_SRV && rdLen >= 6) {
      rec.srvPort = buf.readUInt16BE(rdataStart + 4);
      const srvTarget = decodeDnsName(buf, rdataStart + 6);
      if (srvTarget?.name) rec.srvTarget = srvTarget.name;
    } else if (type === DNS_TYPE_TXT) {
      rec.txtMap = parseTxtRdata(rdata);
    }

    records.push(rec);
  }

  return records;
}

function cleanFriendlyDeviceName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let name = raw
    .replace(/\\032/g, ' ')
    .replace(/\\([ .,'"-])/g, '$1')
    .replace(/\.local\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip AirPlay RAOP 12-hex MAC prefix (e.g. "A483E7112233@Living Room HomePod")
  const raopMatch = name.match(/^[0-9a-f]{12}@(.+)$/i);
  if (raopMatch) {
    name = raopMatch[1].trim();
  }

  // Strip workstation MAC suffix (e.g. "ubuntu-nas [e4:5f:01:8a:22:14]")
  name = name.replace(/\s*\[([0-9a-f]{2}:){5}[0-9a-f]{2}\]$/i, '').trim();

  // Strip ADB opaque prefix like "adb-3A141FDH20041C-k9pR2a" -> keep only if meaningful
  if (/^adb-[0-9a-z]+-[0-9a-z]+$/i.test(name)) {
    return null;
  }

  // Reject bare MACs, bare hex hashes, UUIDs, or bare IPs
  if (!name || name.length < 2 || name.length > 64) return null;
  if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(name)) return null;
  if (/^[0-9a-f]{12,}$/i.test(name)) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return null;
  if (net.isIP(name) !== 0) return null;
  if (/^(localhost|unknown|default|device)$/i.test(name)) return null;

  return name;
}

function splitServiceInstance(fullInstanceName: string): {
  instance: string;
  serviceType: string;
  label: string;
  priority: number;
} | null {
  const lower = fullInstanceName.toLowerCase().replace(/\.+$/, '');
  for (const [suffix, meta] of SERVICE_META_BY_SUFFIX.entries()) {
    const dotSuffix = `.${suffix}`;
    if (lower.endsWith(dotSuffix)) {
      const instance = fullInstanceName.slice(0, fullInstanceName.length - dotSuffix.length);
      return {
        instance,
        serviceType: suffix,
        label: meta.label,
        priority: meta.priority,
      };
    }
  }
  // Generic DNS-SD pattern: <instance>._<service>._tcp.local or _udp.local
  const generic = fullInstanceName.match(/^(.+?)\.(_[a-z0-9-]+\._(?:tcp|udp)\.local)\.?$/i);
  if (generic) {
    const svcRaw = generic[2].split('.')[0].replace(/^_/, '');
    return {
      instance: generic[1],
      serviceType: generic[2].toLowerCase(),
      label: svcRaw.toUpperCase(),
      priority: 70,
    };
  }
  return null;
}

export interface DiscoveryCandidate {
  ip: string;
  name?: string;
  protocol: string;
  model?: string;
  serviceLabel?: string;
  score: number;
}

/**
 * Extracts per-IP friendly device names, hardware models, and advertised service tags
 * from a parsed mDNS / DNS-SD packet.
 */
export function extractMdnsDiscoveries(
  records: DnsRecord[],
  senderIp?: string
): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];
  if (records.length === 0) return candidates;

  // 1. Map .local hostnames -> IPv4 from A records
  const hostToIp = new Map<string, string>();
  for (const r of records) {
    if (r.type === DNS_TYPE_A && r.ipValue && isSafeLanTargetIp(r.ipValue)) {
      const hostKey = r.name.toLowerCase().replace(/\.+$/, '');
      hostToIp.set(hostKey, r.ipValue);
      const cleanHost = cleanFriendlyDeviceName(r.name);
      if (cleanHost) {
        candidates.push({
          ip: r.ipValue,
          name: cleanHost,
          protocol: 'mDNS',
          score: 65,
        });
      }
    }
  }

  // 2. Reverse PTR records (<d>.<c>.<b>.<a>.in-addr.arpa -> hostname.local)
  for (const r of records) {
    if (r.type === DNS_TYPE_PTR && r.stringValue) {
      const arpaMatch = r.name
        .toLowerCase()
        .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa\.?$/);
      if (arpaMatch) {
        const ip = `${arpaMatch[4]}.${arpaMatch[3]}.${arpaMatch[2]}.${arpaMatch[1]}`;
        const cleanHost = cleanFriendlyDeviceName(r.stringValue);
        if (isSafeLanTargetIp(ip) && cleanHost) {
          candidates.push({
            ip,
            name: cleanHost,
            protocol: 'mDNS',
            score: 68,
          });
        }
      }
    }
  }

  // 3. Collect SRV and TXT metadata per full service instance
  const srvByInstance = new Map<string, { target: string; port: number }>();
  const txtByInstance = new Map<string, Record<string, string>>();
  const knownInstances = new Set<string>();

  for (const r of records) {
    if (r.type === DNS_TYPE_PTR && r.stringValue) {
      if (splitServiceInstance(r.stringValue)) {
        knownInstances.add(r.stringValue);
      }
    } else if (r.type === DNS_TYPE_SRV && r.srvTarget) {
      knownInstances.add(r.name);
      srvByInstance.set(r.name.toLowerCase(), {
        target: r.srvTarget.replace(/\.+$/, ''),
        port: r.srvPort || 0,
      });
    } else if (r.type === DNS_TYPE_TXT && r.txtMap) {
      knownInstances.add(r.name);
      txtByInstance.set(r.name.toLowerCase(), r.txtMap);
    }
  }

  for (const fullInstance of knownInstances) {
    const parsed = splitServiceInstance(fullInstance);
    if (!parsed) continue;

    const instKey = fullInstance.toLowerCase();
    const srv = srvByInstance.get(instKey);
    const txt = txtByInstance.get(instKey) || {};

    const targetHostKey = srv?.target.toLowerCase();
    const ip =
      (targetHostKey ? hostToIp.get(targetHostKey) : undefined) ||
      (senderIp && isSafeLanTargetIp(senderIp) ? senderIp : undefined);

    if (!ip) continue;

    // Extract best friendly name & hardware model per service type
    let friendlyName: string | null = null;
    let model: string | undefined;
    let score = parsed.priority;

    if (parsed.serviceType === '_googlecast._tcp.local') {
      // Google Cast TXT: fn = Friendly Name ("Living Room TV"), md = Model ("Chromecast Ultra")
      friendlyName = cleanFriendlyDeviceName(txt.fn) || cleanFriendlyDeviceName(parsed.instance);
      model = txt.md || undefined;
      if (txt.fn) score = 98;
    } else if (
      parsed.serviceType === '_adb-tls-connect._tcp.local' ||
      parsed.serviceType === '_adb-tls-pairing._tcp.local' ||
      parsed.serviceType === '_adb._tcp.local'
    ) {
      // ADB Wireless Debugging: TXT name / model / SRV target (.local hostname)
      friendlyName =
        cleanFriendlyDeviceName(txt.name) ||
        cleanFriendlyDeviceName(txt.model) ||
        cleanFriendlyDeviceName(parsed.instance) ||
        cleanFriendlyDeviceName(srv?.target);
      model = txt.model || txt.device || 'Android Device (ADB)';
      if (friendlyName) score = 90;
    } else if (
      parsed.serviceType === '_airplay._tcp.local' ||
      parsed.serviceType === '_raop._tcp.local' ||
      parsed.serviceType === '_companion-link._tcp.local'
    ) {
      friendlyName =
        cleanFriendlyDeviceName(parsed.instance) || cleanFriendlyDeviceName(srv?.target);
      model = txt.model || txt.rpmd || undefined;
    } else if (parsed.serviceType === '_ipp._tcp.local' || parsed.serviceType === '_printer._tcp.local') {
      friendlyName =
        cleanFriendlyDeviceName(parsed.instance) ||
        cleanFriendlyDeviceName(txt.ty) ||
        cleanFriendlyDeviceName(srv?.target);
      model = txt.ty || txt.product?.replace(/^\(|\)$/g, '') || undefined;
    } else if (parsed.serviceType === '_hap._tcp.local' || parsed.serviceType === '_matter._tcp.local') {
      friendlyName =
        cleanFriendlyDeviceName(parsed.instance) ||
        cleanFriendlyDeviceName(txt.md) ||
        cleanFriendlyDeviceName(srv?.target);
      model = txt.md || undefined;
    } else {
      friendlyName =
        cleanFriendlyDeviceName(txt.fn) ||
        cleanFriendlyDeviceName(txt.name) ||
        cleanFriendlyDeviceName(parsed.instance) ||
        cleanFriendlyDeviceName(srv?.target);
      model = txt.md || txt.model || undefined;
    }

    candidates.push({
      ip,
      name: friendlyName || undefined,
      protocol: parsed.label,
      model,
      serviceLabel: parsed.label,
      score,
    });
  }

  return candidates;
}

export function parseSsdpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && val && !(key in headers)) {
      headers[key] = val;
    }
  }
  return headers;
}

export function parseUpnpDeviceXml(xml: string): {
  friendlyName?: string;
  modelName?: string;
  manufacturer?: string;
} {
  const extractTag = (tag: string): string | undefined => {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]{1,128})</${tag}>`, 'i');
    const m = xml.match(re);
    if (!m) return undefined;
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
    return decoded || undefined;
  };
  return {
    friendlyName: extractTag('friendlyName'),
    modelName: extractTag('modelName') || extractTag('modelDescription'),
    manufacturer: extractTag('manufacturer'),
  };
}

/**
 * Builds a standard RFC 1002 50-byte NetBIOS Node Status (NBSTAT) wildcard query ("*").
 */
export function buildNetbiosStatQuery(transactionId = 0x4f42): Buffer {
  const buf = Buffer.alloc(50);
  buf.writeUInt16BE(transactionId & 0xffff, 0);
  buf.writeUInt16BE(0x0000, 2); // Standard query
  buf.writeUInt16BE(1, 4); // QDCOUNT = 1
  // Encoded NetBIOS name: length 32, '*' (0x2A -> 'C','K'), padded with 0x00 ('A','A') x 15
  buf[12] = 0x20;
  buf[13] = 0x43; // 'C'
  buf[14] = 0x4b; // 'K'
  for (let i = 15; i < 45; i += 1) {
    buf[i] = 0x41; // 'A'
  }
  buf[45] = 0x00; // Root terminator
  buf.writeUInt16BE(0x0021, 46); // QTYPE = NBSTAT (33)
  buf.writeUInt16BE(0x0001, 48); // QCLASS = IN
  return buf;
}

/**
 * Parses an RFC 1002 NetBIOS Node Status (NBSTAT) UDP 137 response and extracts
 * the unique workstation/file-server hostname.
 */
export function parseNetbiosNodeStatus(buf: Buffer): string | null {
  if (!buf || buf.length < 57) return null;
  const anCount = buf.readUInt16BE(6);
  if (anCount < 1) return null;

  // Skip 12-byte header + encoded question/answer name
  let offset = 12;
  const decoded = decodeDnsName(buf, offset);
  if (!decoded) return null;
  offset = decoded.nextOffset;

  // Answer header: TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2)
  if (offset + 10 >= buf.length) return null;
  const rrType = buf.readUInt16BE(offset);
  const rdLen = buf.readUInt16BE(offset + 8);
  offset += 10;
  if (rrType !== 0x0021 || rdLen < 1 || offset >= buf.length) return null;

  const numNames = buf[offset];
  offset += 1;

  let workstationName: string | null = null;
  let serverName: string | null = null;

  for (let i = 0; i < numNames && offset + 18 <= buf.length; i += 1) {
    const rawName = buf
      .subarray(offset, offset + 15)
      .toString('ascii')
      .replace(/\0/g, '')
      .trim();
    const suffix = buf[offset + 15];
    const flags = buf.readUInt16BE(offset + 16);
    offset += 18;

    const isGroup = (flags & 0x8000) !== 0;
    if (isGroup || !rawName || rawName.startsWith('__') || rawName.toUpperCase() === 'MSBROWSE') {
      continue;
    }
    if (suffix === 0x00 && !workstationName) {
      workstationName = rawName;
    } else if (suffix === 0x20 && !serverName) {
      serverName = rawName;
    }
  }

  return cleanFriendlyDeviceName(workstationName || serverName);
}

/**
 * Server-side multi-protocol LAN service discovery:
 * - Passive + active mDNS / DNS-SD (Google Cast, ADB, AirPlay, HomeKit, Sonos, Spotify, IPP, SMB, SSH)
 * - Active SSDP / UPnP (Smart TVs, Chromecast DIAL, Roku, Sonos, media servers)
 * - Targeted unicast NetBIOS NBSTAT (UDP 137) + unicast mDNS reverse PTR for private LAN IPs
 */
export class LanServiceDiscovery {
  private cache = new Map<string, DiscoveredServiceIdentity>();
  private probedIps = new Map<string, number>();
  private fetchedLocations = new Map<string, number>();
  private mdnsSocket: dgram.Socket | null = null;
  private ssdpSocket: dgram.Socket | null = null;
  private nbnsSocket: dgram.Socket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onDiscovered: ((entry: DiscoveredServiceIdentity) => void) | null = null;
  private started = false;
  private readonly ttlMs = 10 * 60_000;
  private readonly probeCooldownMs = 3 * 60_000;
  private readonly maxEntries = 500;

  constructor(options?: { onDiscovered?: (entry: DiscoveredServiceIdentity) => void }) {
    this.onDiscovered = options?.onDiscovered ?? null;
  }

  public setOnDiscovered(cb: ((entry: DiscoveredServiceIdentity) => void) | null): void {
    this.onDiscovered = cb;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;

    this.initMdnsSocket();
    this.initSsdpSocket();
    this.initNbnsSocket();

    // Run an initial discovery sweep shortly after startup, then periodically every 60s
    setTimeout(() => {
      if (this.started) this.triggerSweep();
    }, 1500);

    this.pollTimer = setInterval(() => {
      if (this.started) this.triggerSweep();
    }, 60_000);
  }

  public stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const sock of [this.mdnsSocket, this.ssdpSocket, this.nbnsSocket]) {
      if (sock) {
        try {
          sock.close();
        } catch {
          // ignore
        }
      }
    }
    this.mdnsSocket = null;
    this.ssdpSocket = null;
    this.nbnsSocket = null;
  }

  public lookup(ip: string, now = Date.now()): DiscoveredServiceIdentity | null {
    if (!ip || !isSafeLanTargetIp(ip)) return null;
    const entry = this.cache.get(ip);
    if (entry && now - entry.updatedAt <= this.ttlMs) {
      return entry;
    }
    if (entry && now - entry.updatedAt > this.ttlMs) {
      this.cache.delete(ip);
    }
    return null;
  }

  /**
   * Triggers lightweight unicast NetBIOS (UDP 137) + unicast mDNS PTR probes for specific LAN IPs
   * (useful in Docker bridge environments where multicast packets do not cross to the container).
   */
  public probeIps(ips: string[]): void {
    if (!this.started) return;
    const now = Date.now();
    let budget = 12;
    for (const ip of ips) {
      if (budget <= 0) break;
      if (!isSafeLanTargetIp(ip)) continue;
      const last = this.probedIps.get(ip) || 0;
      if (now - last < this.probeCooldownMs) continue;
      this.probedIps.set(ip, now);
      budget -= 1;

      this.sendNetbiosProbe(ip);
      this.sendUnicastMdnsPtr(ip);
    }

    if (this.probedIps.size > this.maxEntries * 2) {
      for (const [k, ts] of this.probedIps.entries()) {
        if (now - ts > this.probeCooldownMs * 2) {
          this.probedIps.delete(k);
        }
      }
    }
  }

  public getStats() {
    return {
      discoveredCount: this.cache.size,
    };
  }

  public ingestCandidate(candidate: DiscoveryCandidate, now = Date.now()): void {
    if (!isSafeLanTargetIp(candidate.ip)) return;
    const cleanName = candidate.name ? cleanFriendlyDeviceName(candidate.name) : null;
    const serviceLabel = candidate.serviceLabel?.trim();
    const model = candidate.model?.trim();

    if (!cleanName && !serviceLabel && !model) return;

    const existing = this.cache.get(candidate.ip);
    const services = new Set<string>(existing?.services || []);
    if (serviceLabel) services.add(serviceLabel);

    const existingValid = existing && now - existing.updatedAt <= this.ttlMs;
    const shouldReplaceName =
      Boolean(cleanName) &&
      (!existingValid ||
        !existing?.name ||
        candidate.score >= (existing?.score || 0));

    const nextName = shouldReplaceName ? cleanName! : existing?.name || '';
    const nextProtocol = shouldReplaceName
      ? candidate.protocol
      : existing?.protocol || candidate.protocol;
    const nextScore = shouldReplaceName
      ? candidate.score
      : existing?.score || candidate.score;
    const nextModel = model || existing?.model;

    const nextEntry: DiscoveredServiceIdentity = {
      ip: candidate.ip,
      name: nextName,
      protocol: nextProtocol,
      ...(nextModel ? { model: nextModel } : {}),
      services: Array.from(services).slice(0, 8),
      score: nextScore,
      updatedAt: now,
    };

    if (this.cache.size >= this.maxEntries && !this.cache.has(candidate.ip)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    const changed =
      !existing ||
      existing.name !== nextEntry.name ||
      existing.protocol !== nextEntry.protocol ||
      existing.model !== nextEntry.model ||
      existing.services.length !== nextEntry.services.length;

    this.cache.set(candidate.ip, nextEntry);
    if (changed && nextEntry.name) {
      this.onDiscovered?.(nextEntry);
    }
  }

  private initMdnsSocket(): void {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {
        // Silently ignore multicast socket errors in sandboxed containers
      });
      sock.on('message', (msg, rinfo) => {
        try {
          const records = parseDnsPacket(msg);
          const candidates = extractMdnsDiscoveries(records, rinfo.address);
          for (const c of candidates) {
            this.ingestCandidate(c);
          }
        } catch {
          // Ignore malformed mDNS packets
        }
      });
      sock.bind(MDNS_PORT, () => {
        try {
          sock.addMembership(MDNS_ADDR);
          sock.setMulticastTTL(255);
          sock.setMulticastLoopback(false);
        } catch {
          // Fallback: socket can still receive unicast responses even if multicast join fails
        }
      });
      this.mdnsSocket = sock;
    } catch {
      this.mdnsSocket = null;
    }
  }

  private initSsdpSocket(): void {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => {
        if (!isSafeLanTargetIp(rinfo.address)) return;
        const headers = parseSsdpHeaders(msg.toString('utf8'));
        const location = headers.location;
        if (location) {
          void this.fetchUpnpLocation(rinfo.address, location, headers.st || headers.nt || '');
        }
      });
      sock.bind(0);
      this.ssdpSocket = sock;
    } catch {
      this.ssdpSocket = null;
    }
  }

  private initNbnsSocket(): void {
    try {
      const sock = dgram.createSocket({ type: 'udp4' });
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => {
        if (!isSafeLanTargetIp(rinfo.address)) return;
        const name = parseNetbiosNodeStatus(msg);
        if (name) {
          this.ingestCandidate({
            ip: rinfo.address,
            name,
            protocol: 'NetBIOS',
            serviceLabel: 'NetBIOS',
            score: 74,
          });
        }
      });
      sock.bind(0);
      this.nbnsSocket = sock;
    } catch {
      this.nbnsSocket = null;
    }
  }

  private triggerSweep(): void {
    // 1. Broadcast mDNS DNS-SD queries (staggered slightly to avoid bursts)
    if (this.mdnsSocket) {
      const queries = [
        '_googlecast._tcp.local',
        '_adb-tls-connect._tcp.local',
        '_adb._tcp.local',
        '_airplay._tcp.local',
        '_raop._tcp.local',
        '_companion-link._tcp.local',
        '_spotify-connect._tcp.local',
        '_sonos._tcp.local',
        '_hap._tcp.local',
        '_ipp._tcp.local',
        '_smb._tcp.local',
        '_ssh._tcp.local',
        '_workstation._tcp.local',
        '_esphomelib._tcp.local',
        '_home-assistant._tcp.local',
      ];
      queries.forEach((q, idx) => {
        setTimeout(() => {
          if (!this.started || !this.mdnsSocket) return;
          const pkt = buildDnsQueryPacket(q, DNS_TYPE_PTR, false);
          this.mdnsSocket.send(pkt, MDNS_PORT, MDNS_ADDR, () => {});
        }, idx * 80);
      });
    }

    // 2. Send SSDP M-SEARCH for UPnP root devices & DIAL (Chromecast/Roku/Smart TVs)
    if (this.ssdpSocket) {
      const targets = [
        'upnp:rootdevice',
        'urn:dial-multiscreen-org:service:dial:1',
      ];
      for (const st of targets) {
        const req = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n'),
          'utf8'
        );
        this.ssdpSocket.send(req, SSDP_PORT, SSDP_ADDR, () => {});
      }
    }
  }

  private sendNetbiosProbe(ip: string): void {
    if (!this.nbnsSocket || !isSafeLanTargetIp(ip)) return;
    const pkt = buildNetbiosStatQuery(Math.floor(Math.random() * 0xffff));
    this.nbnsSocket.send(pkt, NBNS_PORT, ip, () => {});
  }

  private sendUnicastMdnsPtr(ip: string): void {
    if (!this.mdnsSocket || !isSafeLanTargetIp(ip)) return;
    const rev = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const pkt = buildDnsQueryPacket(rev, DNS_TYPE_PTR, true);
    this.mdnsSocket.send(pkt, MDNS_PORT, ip, () => {});
  }

  private async fetchUpnpLocation(senderIp: string, locationUrl: string, st: string): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(locationUrl);
    } catch {
      return;
    }

    // Strict SSRF protection: only HTTP to the exact private RFC1918 sender IP on a valid port
    if (parsedUrl.protocol !== 'http:') return;
    if (parsedUrl.hostname !== senderIp || !isSafeLanTargetIp(parsedUrl.hostname)) return;

    const now = Date.now();
    const lastFetched = this.fetchedLocations.get(locationUrl) || 0;
    if (now - lastFetched < this.probeCooldownMs) return;
    this.fetchedLocations.set(locationUrl, now);

    if (this.fetchedLocations.size > this.maxEntries) {
      const first = this.fetchedLocations.keys().next().value;
      if (first) this.fetchedLocations.delete(first);
    }

    const xml = await new Promise<string | null>((resolve) => {
      const req = http.get(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port ? Number(parsedUrl.port) : 80,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          timeout: 2000,
          headers: { 'User-Agent': 'OrbiFlow/1.0 UPnP-Discovery' },
        },
        (res) => {
          // Never follow redirects (SSRF defense)
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            resolve(null);
            return;
          }
          let body = '';
          let bytes = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            bytes += chunk.length;
            if (bytes <= 65536) {
              body += chunk;
            } else {
              res.destroy();
              resolve(body);
            }
          });
          res.on('end', () => resolve(body));
          res.on('error', () => resolve(null));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });

    if (!xml) return;
    const info = parseUpnpDeviceXml(xml);
    const friendly = cleanFriendlyDeviceName(info.friendlyName);
    const isDial = /dial/i.test(st) || /chromecast|google|cast/i.test(`${info.manufacturer || ''} ${info.modelName || ''}`);
    const serviceLabel = isDial ? 'DIAL / Cast' : 'UPnP';
    const model = [info.manufacturer, info.modelName]
      .filter((v, idx, arr) => Boolean(v) && (idx === 0 || !v!.toLowerCase().includes((arr[0] || '').toLowerCase())))
      .join(' ')
      .trim() || undefined;

    if (friendly || model) {
      this.ingestCandidate({
        ip: senderIp,
        name: friendly || undefined,
        protocol: serviceLabel,
        model,
        serviceLabel,
        score: isDial ? 93 : 82,
      });
    }
  }
}
