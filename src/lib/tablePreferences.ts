import type {
  ConnectionsTablePrefs,
  DevicesTablePrefs,
  FeatureVisibility,
  TablePreferences,
} from '../types/telemetry';

export const DEFAULT_CONNECTIONS_TABLE_PREFS: ConnectionsTablePrefs = {
  showAppProtocol: true,
  showProtocol: true,
  showLocalDevice: true,
  showLocalIp: false,
  showLocalPort: false,
  showDestination: true,
  showDestinationRdns: true,
  showDestinationIpPort: false,
  showCategory: false,
  showDownload: true,
  showUpload: true,
  showTotal: true,
  showDuration: true,
};

export const DEFAULT_DEVICES_TABLE_PREFS: DevicesTablePrefs = {
  showIp: true,
  showMac: false,
  showVendorSource: true,
  showConnection: true,
  showTopServices: true,
  showConnections: false,
  showDownload: true,
  showUpload: true,
  showTotal: true,
};

export const DEFAULT_TABLE_PREFERENCES: TablePreferences = {
  connections: { ...DEFAULT_CONNECTIONS_TABLE_PREFS },
  devices: { ...DEFAULT_DEVICES_TABLE_PREFS },
};

export const DEFAULT_FEATURE_VISIBILITY: FeatureVisibility = {
  flows: true,
  topDevices: true,
  topDestinations: true,
  trafficMap: true,
  connections: true,
  devices: true,
  alerts: true,
  agent: true,
};

function pickBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof obj[key] === 'boolean' ? (obj[key] as boolean) : fallback;
}

export function sanitizeConnectionsTablePrefs(
  input: unknown,
  base: ConnectionsTablePrefs = DEFAULT_CONNECTIONS_TABLE_PREFS
): ConnectionsTablePrefs {
  const src =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const next: ConnectionsTablePrefs = {
    showAppProtocol: pickBool(src, 'showAppProtocol', base.showAppProtocol),
    showProtocol: pickBool(src, 'showProtocol', base.showProtocol),
    showLocalDevice: pickBool(src, 'showLocalDevice', base.showLocalDevice),
    showLocalIp: pickBool(src, 'showLocalIp', base.showLocalIp),
    showLocalPort: pickBool(src, 'showLocalPort', base.showLocalPort),
    showDestination: pickBool(src, 'showDestination', base.showDestination),
    showDestinationRdns: pickBool(src, 'showDestinationRdns', base.showDestinationRdns),
    showDestinationIpPort: pickBool(src, 'showDestinationIpPort', base.showDestinationIpPort),
    showCategory: pickBool(src, 'showCategory', base.showCategory),
    showDownload: pickBool(src, 'showDownload', base.showDownload),
    showUpload: pickBool(src, 'showUpload', base.showUpload),
    showTotal: pickBool(src, 'showTotal', base.showTotal),
    showDuration: pickBool(src, 'showDuration', base.showDuration),
  };

  // Guarantee at least one primary column stays visible
  const anyVisible =
    next.showAppProtocol ||
    next.showLocalDevice ||
    next.showDestination ||
    next.showDestinationIpPort ||
    next.showCategory ||
    next.showDownload ||
    next.showUpload ||
    next.showTotal ||
    next.showDuration;

  if (!anyVisible) {
    next.showDestination = true;
  }

  return next;
}

export function sanitizeDevicesTablePrefs(
  input: unknown,
  base: DevicesTablePrefs = DEFAULT_DEVICES_TABLE_PREFS
): DevicesTablePrefs {
  const src =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    showIp: pickBool(src, 'showIp', base.showIp),
    showMac: pickBool(src, 'showMac', base.showMac),
    showVendorSource: pickBool(src, 'showVendorSource', base.showVendorSource),
    showConnection: pickBool(src, 'showConnection', base.showConnection),
    showTopServices: pickBool(src, 'showTopServices', base.showTopServices),
    showConnections: pickBool(src, 'showConnections', base.showConnections),
    showDownload: pickBool(src, 'showDownload', base.showDownload),
    showUpload: pickBool(src, 'showUpload', base.showUpload),
    showTotal: pickBool(src, 'showTotal', base.showTotal),
  };
}

export function sanitizeTablePreferences(
  input: unknown,
  base: TablePreferences = DEFAULT_TABLE_PREFERENCES
): TablePreferences {
  const src =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    connections: sanitizeConnectionsTablePrefs(src.connections, base.connections),
    devices: sanitizeDevicesTablePrefs(src.devices, base.devices),
  };
}

export function sanitizeFeatureVisibility(
  input: unknown,
  base: FeatureVisibility = DEFAULT_FEATURE_VISIBILITY
): FeatureVisibility {
  const src =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    flows: pickBool(src, 'flows', base.flows),
    topDevices: pickBool(src, 'topDevices', base.topDevices),
    topDestinations: pickBool(src, 'topDestinations', base.topDestinations),
    trafficMap: pickBool(src, 'trafficMap', base.trafficMap),
    connections: pickBool(src, 'connections', base.connections),
    devices: pickBool(src, 'devices', base.devices),
    alerts: pickBool(src, 'alerts', base.alerts),
    agent: pickBool(src, 'agent', base.agent),
  };
}

const SAFE_POSIX_FILE_PATH_RE = /^\/[a-zA-Z0-9._/@+-]{1,255}$/;

export function validateDhcpLeasesPath(raw: unknown): {
  ok: boolean;
  value: string;
  error?: string;
} {
  if (raw === undefined || raw === null) {
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, value: '', error: 'DHCP leases path must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: '' };
  }
  if (trimmed.includes('..') || trimmed.includes('//') || trimmed.endsWith('/')) {
    return {
      ok: false,
      value: '',
      error: 'Enter an absolute file path without relative segments (e.g. /tmp/dhcp.leases)',
    };
  }
  if (!SAFE_POSIX_FILE_PATH_RE.test(trimmed)) {
    return {
      ok: false,
      value: '',
      error:
        'Path must start with / and contain only letters, numbers, dots, hyphens, underscores, or slashes',
    };
  }
  return { ok: true, value: trimmed };
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isValidIpv6(ip: string): boolean {
  if (!ip.includes(':') || ip.length > 45) return false;
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return false;
  const doubleColons = ip.split('::');
  if (doubleColons.length > 2) return false;
  const groups = ip.split(':').filter((g) => g.length > 0);
  if (groups.some((g) => g.length > 4)) return false;
  if (doubleColons.length === 1 && groups.length !== 8) return false;
  if (doubleColons.length === 2 && groups.length >= 8) return false;
  return true;
}

export function validateDnsServer(raw: unknown): {
  ok: boolean;
  value: string;
  error?: string;
} {
  if (raw === undefined || raw === null) {
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, value: '', error: 'DNS server must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: '' };
  }

  // Bracketed IPv6 with optional port: [2606:4700:4700::1111]:53
  const bracketedMatch = trimmed.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketedMatch) {
    const host = bracketedMatch[1];
    const portStr = bracketedMatch[2];
    if (!isValidIpv6(host)) {
      return { ok: false, value: '', error: 'Enter a valid IPv4 or IPv6 DNS server address' };
    }
    if (portStr !== undefined) {
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, value: '', error: 'DNS server port must be between 1 and 65535' };
      }
      return { ok: true, value: `[${host}]:${port}` };
    }
    return { ok: true, value: host };
  }

  // Plain IPv6 without port
  if (trimmed.includes(':') && trimmed.indexOf(':') !== trimmed.lastIndexOf(':')) {
    if (!isValidIpv6(trimmed)) {
      return { ok: false, value: '', error: 'Enter a valid IPv4 or IPv6 DNS server address' };
    }
    return { ok: true, value: trimmed };
  }

  // IPv4 with optional :port
  const [host, portStr, extra] = trimmed.split(':');
  if (extra !== undefined || !isValidIpv4(host)) {
    return {
      ok: false,
      value: '',
      error: 'Enter a valid IPv4 or IPv6 address (e.g. 1.1.1.1, 8.8.8.8, or 9.9.9.9)',
    };
  }
  if (portStr !== undefined) {
    if (!/^\d{1,5}$/.test(portStr)) {
      return { ok: false, value: '', error: 'DNS server port must be between 1 and 65535' };
    }
    const port = Number(portStr);
    if (port < 1 || port > 65535) {
      return { ok: false, value: '', error: 'DNS server port must be between 1 and 65535' };
    }
    return { ok: true, value: `${host}:${port}` };
  }
  return { ok: true, value: host };
}

