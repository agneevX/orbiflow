import type { DeviceAlias, DeviceNameSource } from '../types/telemetry';

const ZERO_MAC = '00:00:00:00:00:00';

/**
 * Curated offline OUI prefixes for common home/homelab devices.
 * Only checked when the MAC is NOT locally administered (randomized).
 */
const OUI_VENDORS: Record<string, string> = {
  'f0:18:98': 'Apple',
  'b4:fb:e4': 'Apple',
  '3c:22:fb': 'Apple',
  'a4:83:e7': 'Apple',
  'dc:a9:04': 'Apple',
  '28:cf:e9': 'Apple',
  '7c:d9:5c': 'Google',
  'f4:f5:d8': 'Google',
  '3c:5a:b4': 'Google',
  '00:11:32': 'Synology',
  '90:09:d0': 'Synology',
  'e4:5f:01': 'Raspberry Pi / Linux',
  'dc:a6:32': 'Raspberry Pi',
  'b8:27:eb': 'Raspberry Pi',
  '18:b4:30': 'Ecobee / Nest IoT',
  '44:61:32': 'Ecobee',
  'd8:bb:c1': 'Realtek / PC',
  '00:e0:4c': 'Realtek',
  '70:85:c2': 'ASRock / PC',
  '04:d9:f5': 'ASUS',
  '1c:1b:0d': 'Gigabyte',
  '3c:7c:3f': 'ASUS',
  'a8:a1:59': 'Intel',
  '00:1b:21': 'Intel',
  '48:51:b7': 'Intel',
  'b4:2e:99': 'Intel / NUC',
  'f8:e4:3b': 'ASIX / USB LAN',
  '74:ac:b9': 'Ubiquiti',
  'fc:ec:da': 'Ubiquiti',
  '24:a4:3c': 'Ubiquiti',
  'c0:56:27': 'Netgear',
  'a0:40:a0': 'Netgear',
  'b0:be:76': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  '00:0e:58': 'Sonos',
  '78:28:ca': 'Sonos',
  'b8:e9:37': 'Sonos',
  'cc:50:e3': 'Espressif IoT',
  '24:6f:28': 'Espressif IoT',
  '84:cc:a8': 'Espressif IoT',
  '40:f5:20': 'Espressif IoT',
  '70:ee:50': 'Netatmo',
  'ec:fa:bc': 'Tuya / Smart Home',
  'ac:63:be': 'Amazon',
  '44:65:0d': 'Amazon',
  'fc:65:de': 'Amazon',
  '00:04:20': 'Logitech',
  '7c:2e:bd': 'Google / Nest',
  '98:b6:e9': 'Nintendo',
  '00:d9:d1': 'Sony PlayStation',
  '28:0d:fc': 'Sony',
  '50:1a:c5': 'Microsoft Xbox',
  '7c:1e:52': 'Microsoft',
  'bc:30:5b': 'Dell',
  'c8:5b:76': 'Lenovo',
  'd0:50:99': 'Samsung',
  '84:25:db': 'Samsung',
  'f4:7b:5e': 'Samsung',
  'dc:3a:5e': 'Roku',
  'b8:3e:59': 'Roku',
  'ac:3a:7a': 'Roku',
  'a8:23:fe': 'LG Electronics',
  '58:fd:b1': 'LG Electronics',
};

export function normalizeMac(mac?: string | null): string {
  if (!mac) return ZERO_MAC;
  const cleaned = mac.trim().toLowerCase().replace(/-/g, ':');
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned)) {
    return ZERO_MAC;
  }
  return cleaned;
}

/**
 * IEEE 802.3 Locally Administered Address (LAA) detection.
 * Modern iOS, Android, macOS, and Windows privacy modes generate randomized MACs
 * with bit 1 (0x02) of the first octet set to 1 and multicast bit 0 (0x01) set to 0.
 * That corresponds to the second hex digit of the MAC being 2, 6, a, or e.
 */
export function isRandomizedMac(mac?: string | null): boolean {
  const norm = normalizeMac(mac);
  if (norm === ZERO_MAC) return false;
  const firstByte = parseInt(norm.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return false;
  const isLocallyAdministered = (firstByte & 0x02) !== 0;
  const isUnicast = (firstByte & 0x01) === 0;
  return isLocallyAdministered && isUnicast;
}

export function lookupMacVendor(
  mac?: string | null,
  providedVendor?: string
): { vendor: string; isRandomized: boolean } {
  const norm = normalizeMac(mac);
  const randomized = isRandomizedMac(norm);

  if (randomized) {
    return {
      vendor: 'Private / Randomized MAC',
      isRandomized: true,
    };
  }

  if (providedVendor && providedVendor.trim() && providedVendor !== 'LAN Device') {
    return {
      vendor: providedVendor.trim(),
      isRandomized: false,
    };
  }

  if (norm !== ZERO_MAC) {
    const oui = norm.slice(0, 8);
    if (OUI_VENDORS[oui]) {
      return {
        vendor: OUI_VENDORS[oui],
        isRandomized: false,
      };
    }
  }

  return {
    vendor: 'LAN Device',
    isRandomized: false,
  };
}

export function isMeaningfulHostname(hostname: string | undefined | null, ip: string): boolean {
  if (!hostname) return false;
  const trimmed = hostname.trim();
  if (!trimmed || trimmed === '*' || trimmed === '?' || trimmed === '(unknown)') return false;
  if (trimmed === ip) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return false;
  return true;
}

export function stripLocalDomain(hostname: string, shouldStrip = true): string {
  const cleaned = hostname.trim().replace(/\.+$/, '');
  if (!shouldStrip) return cleaned;
  const dotIdx = cleaned.indexOf('.');
  if (dotIdx <= 0) return cleaned;
  const firstLabel = cleaned.slice(0, dotIdx);
  return firstLabel || cleaned;
}

export interface FlowFingerprintInput {
  dstService: string;
  dstHost?: string;
  app: string;
  dport: number;
}

/**
 * Passive behavioral device hint for nameless / randomized-MAC devices.
 * Infers likely OS or device family from observed destination services & ports.
 */
export function fingerprintDeviceHint(flows: FlowFingerprintInput[]): string | null {
  if (flows.length === 0) return null;

  let appleScore = 0;
  let googleScore = 0;
  let gamingScore = 0;
  let windowsScore = 0;
  let streamingScore = 0;
  let iotScore = 0;
  let linuxScore = 0;

  for (const f of flows) {
    const srv = `${f.dstService} ${f.dstHost || ''}`.toLowerCase();
    const app = f.app.toLowerCase();

    if (app.includes('apple apns') || f.dport === 5223) appleScore += 5;
    if (srv.includes('apple') || srv.includes('icloud')) appleScore += 3;

    if (srv.includes('google') || srv.includes('android') || srv.includes('gstatic')) {
      googleScore += 2;
    }

    if (
      srv.includes('steam') ||
      srv.includes('valve') ||
      srv.includes('xbox') ||
      srv.includes('playstation') ||
      srv.includes('nintendo') ||
      app.includes('steam')
    ) {
      gamingScore += 4;
    }
    if (srv.includes('discord')) gamingScore += 2;

    if (srv.includes('microsoft') || srv.includes('windows') || srv.includes('msedge')) {
      windowsScore += 3;
    }

    if (
      srv.includes('netflix') ||
      srv.includes('roku') ||
      srv.includes('hulu') ||
      srv.includes('disney') ||
      srv.includes('youtube')
    ) {
      streamingScore += 2;
    }

    if (app.includes('mqtt') || f.dport === 8883 || f.dport === 1883 || srv.includes('ecobee')) {
      iotScore += 5;
    }

    if (app === 'ssh' || app.includes('wireguard') || srv.includes('github') || srv.includes('docker')) {
      linuxScore += 3;
    }
  }

  const candidates: Array<{ label: string; score: number }> = [
    { label: 'Apple Device', score: appleScore },
    { label: 'Smart Home / IoT', score: iotScore },
    { label: 'Gaming Device', score: gamingScore },
    { label: 'Windows Device', score: windowsScore },
    { label: 'Linux / Homelab', score: linuxScore },
    { label: 'Streaming Device', score: streamingScore },
    { label: 'Android / Google Device', score: googleScore },
  ].sort((a, b) => b.score - a.score);

  return candidates[0] && candidates[0].score >= 3 ? candidates[0].label : null;
}

export function isGenericDhcpHostname(hostname: string | undefined | null): boolean {
  if (!hostname) return true;
  const low = hostname.trim().toLowerCase();
  if (!low || low.length <= 1) return true;
  return (
    /^android[-_][0-9a-f]{4,}$/i.test(low) ||
    /^dhcppc\d+$/i.test(low) ||
    /^(host|client|device|user|pc|phone|mobile|unknown)[-_]?\d*$/i.test(low) ||
    /^esp[-_]?[0-9a-f]{4,}$/i.test(low) ||
    /^espressif[-_]?[0-9a-f]*$/i.test(low) ||
    /^tuya[-_]?[0-9a-f]*$/i.test(low) ||
    /^amazon[-_][0-9a-f]{6,}$/i.test(low) ||
    /^chromecast$/i.test(low) ||
    /^google[-_]?home$/i.test(low) ||
    /^localhost(\.localdomain)?$/i.test(low) ||
    /^wlan\d+$/i.test(low)
  );
}

export interface ResolveHostIdentityInput {
  ip: string;
  mac?: string;
  dhcpHostname?: string;
  ptrHostname?: string | null;
  serviceName?: string | null;
  serviceProtocol?: string | null;
  serviceModel?: string | null;
  advertisedServices?: string[];
  providedVendor?: string;
  deviceHint?: string | null;
  aliases: Record<string, DeviceAlias>;
  stripDomain: boolean;
  inferDeviceNames?: boolean;
}

export interface ResolvedHostIdentity {
  hostname: string;
  vendor: string;
  nameSource: DeviceNameSource;
  isRandomizedMac: boolean;
  ptrHostname?: string;
  serviceName?: string;
  serviceProtocol?: string;
  advertisedServices?: string[];
  deviceHint?: string;
  aliasKey?: string;
  aliasMatchBy?: 'mac' | 'ip';
}

export function resolveHostIdentity(input: ResolveHostIdentityInput): ResolvedHostIdentity {
  const normMac = normalizeMac(input.mac);
  const { vendor: baseVendor, isRandomized } = lookupMacVendor(normMac, input.providedVendor);
  const allowInferred = input.inferDeviceNames !== false;
  const deviceHint = input.deviceHint || undefined;

  const macAliasKey = normMac !== ZERO_MAC ? `mac:${normMac}` : null;
  const ipAliasKey = `ip:${input.ip}`;
  const matchedAlias =
    (macAliasKey ? input.aliases[macAliasKey] : undefined) || input.aliases[ipAliasKey];

  const cleanPtr =
    input.ptrHostname && isMeaningfulHostname(input.ptrHostname, input.ip)
      ? input.ptrHostname.trim().replace(/\.+$/, '')
      : undefined;

  const cleanDhcp =
    input.dhcpHostname && isMeaningfulHostname(input.dhcpHostname, input.ip)
      ? stripLocalDomain(input.dhcpHostname, input.stripDomain)
      : undefined;

  const cleanServiceName =
    input.serviceName && isMeaningfulHostname(input.serviceName, input.ip)
      ? input.serviceName.trim().replace(/\.local\.?$/i, '')
      : undefined;
  const cleanServiceProtocol = input.serviceProtocol?.trim() || undefined;
  const cleanServiceModel = input.serviceModel?.trim() || undefined;
  const advertisedServices =
    Array.isArray(input.advertisedServices) && input.advertisedServices.length > 0
      ? Array.from(new Set(input.advertisedServices.map((s) => s.trim()).filter(Boolean))).slice(0, 8)
      : undefined;

  const vendor =
    cleanServiceModel && (baseVendor === 'LAN Device' || isRandomized)
      ? isRandomized
        ? `${cleanServiceModel} · Private MAC`
        : cleanServiceModel
      : allowInferred && isRandomized && deviceHint
        ? `${deviceHint} · Private MAC`
        : baseVendor;

  const sharedServiceMeta = {
    ...(cleanServiceName ? { serviceName: cleanServiceName } : {}),
    ...(cleanServiceProtocol ? { serviceProtocol: cleanServiceProtocol } : {}),
    ...(advertisedServices ? { advertisedServices } : {}),
  };

  if (matchedAlias && matchedAlias.name.trim()) {
    return {
      hostname: matchedAlias.name.trim(),
      vendor,
      nameSource: 'alias',
      isRandomizedMac: isRandomized,
      ptrHostname: cleanPtr,
      ...sharedServiceMeta,
      deviceHint,
      aliasKey: matchedAlias.key,
      aliasMatchBy: matchedAlias.matchBy,
    };
  }

  if (cleanPtr) {
    return {
      hostname: stripLocalDomain(cleanPtr, input.stripDomain),
      vendor,
      nameSource: 'lan-dns',
      isRandomizedMac: isRandomized,
      ptrHostname: cleanPtr,
      ...sharedServiceMeta,
      deviceHint,
    };
  }

  // Prefer advertised service names (Google Cast, ADB, AirPlay, UPnP, mDNS, NetBIOS)
  // over missing or generic auto-generated DHCP hostnames like "android-8f3c2a1b".
  const dhcpIsGeneric = isGenericDhcpHostname(cleanDhcp);

  if (cleanDhcp && !dhcpIsGeneric) {
    return {
      hostname: cleanDhcp,
      vendor,
      nameSource: 'dhcp',
      isRandomizedMac: isRandomized,
      ...sharedServiceMeta,
      deviceHint,
    };
  }

  if (cleanServiceName) {
    return {
      hostname: cleanServiceName,
      vendor,
      nameSource: 'service',
      isRandomizedMac: isRandomized,
      ...sharedServiceMeta,
      deviceHint,
    };
  }

  if (cleanDhcp) {
    return {
      hostname: cleanDhcp,
      vendor,
      nameSource: 'dhcp',
      isRandomizedMac: isRandomized,
      ...sharedServiceMeta,
      deviceHint,
    };
  }

  if (allowInferred && deviceHint) {
    const lastOctet = input.ip.split('.').pop() || input.ip;
    return {
      hostname: `${deviceHint} (.${lastOctet})`,
      vendor,
      nameSource: 'fingerprint',
      isRandomizedMac: isRandomized,
      ...sharedServiceMeta,
      deviceHint,
    };
  }

  return {
    hostname: input.ip,
    vendor,
    nameSource: 'ip',
    isRandomizedMac: isRandomized,
    ...sharedServiceMeta,
    deviceHint,
  };
}
