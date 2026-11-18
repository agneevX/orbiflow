import type { BandwidthUnit, ConntrackState, TransportProtocol } from '../types/telemetry';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, exp);
  return `${Math.round(val)} ${units[exp]}`;
}

/**
 * Formats bandwidth rate in Mb/s or MB/s with 0 decimal places.
 * Any throughput below 1 Mbit/s (1,000,000 bits/s) is formatted in Kbps with 0 decimal places.
 */
export function formatBandwidth(bytesPerSec: number, unit: BandwidthUnit = 'Mb/s'): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 Kbps';
  const bitsPerSec = bytesPerSec * 8;
  if (bitsPerSec < 1_000_000) {
    return `${Math.round(bitsPerSec / 1_000)} Kbps`;
  }
  if (unit === 'MB/s') {
    if (bytesPerSec < 1_000_000) {
      return `${Math.round(bytesPerSec / 1_000)} KB/s`;
    }
    return `${Math.round(bytesPerSec / 1_000_000)} MB/s`;
  }
  return `${Math.round(bitsPerSec / 1_000_000)} Mb/s`;
}

/** Backwards-compatible alias defaulting to Mb/s */
export function formatBitrate(bytesPerSec: number, unit: BandwidthUnit = 'Mb/s'): string {
  return formatBandwidth(bytesPerSec, unit);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatTimestamp(
  ts: number,
  compact = false,
  includeMonthDay = false
): string {
  const d = new Date(ts);
  if (includeMonthDay) {
    const mon = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${mon} ${time}`;
  }
  if (compact) {
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.')) {
    return true;
  }
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function normalizeProtocol(raw: string): TransportProtocol {
  const upper = (raw || '').toUpperCase();
  if (upper === 'TCP' || upper === '6') return 'TCP';
  if (upper === 'UDP' || upper === '17') return 'UDP';
  if (upper === 'ICMP' || upper === '1' || upper === 'ICMPV6') return 'ICMP';
  return 'OTHER';
}

export function normalizeState(raw: string | undefined, proto: TransportProtocol): ConntrackState {
  if (!raw) return proto === 'TCP' ? 'ESTABLISHED' : 'STATELESS';
  const upper = raw.toUpperCase();
  const valid: ConntrackState[] = [
    'ESTABLISHED',
    'SYN_SENT',
    'SYN_RECV',
    'FIN_WAIT',
    'TIME_WAIT',
    'CLOSE_WAIT',
    'CLOSE',
    'STATELESS',
  ];
  return valid.includes(upper as ConntrackState) ? (upper as ConntrackState) : 'STATELESS';
}

const PORT_APP_MAP: Record<string, string> = {
  'TCP:443': 'HTTPS / TLS',
  'UDP:443': 'QUIC / HTTP3',
  'TCP:80': 'HTTP',
  'UDP:53': 'DNS',
  'TCP:53': 'DNS over TCP',
  'TCP:853': 'DNS over TLS',
  'TCP:22': 'SSH',
  'UDP:51820': 'WireGuard VPN',
  'UDP:1194': 'OpenVPN',
  'TCP:1194': 'OpenVPN',
  'UDP:123': 'NTP',
  'TCP:445': 'SMB',
  'TCP:993': 'IMAPS',
  'TCP:587': 'SMTP Submission',
  'TCP:32400': 'Plex Media',
  'TCP:1883': 'MQTT',
  'TCP:8883': 'MQTTS',
  'UDP:3478': 'STUN / WebRTC',
  'UDP:19302': 'Google Meet / WebRTC',
  'TCP:5228': 'Google Push',
  'TCP:5223': 'Apple APNs',
  'UDP:27015': 'Steam / Source',
  'TCP:27015': 'Steam Client',
  'TCP:51413': 'BitTorrent',
  'UDP:51413': 'BitTorrent uTP',
};

export function classifyApplication(proto: TransportProtocol, sport: number, dport: number): string {
  if (proto === 'ICMP') return 'ICMP Ping';
  const dstKey = `${proto}:${dport}`;
  if (PORT_APP_MAP[dstKey]) return PORT_APP_MAP[dstKey];
  const srcKey = `${proto}:${sport}`;
  if (PORT_APP_MAP[srcKey]) return PORT_APP_MAP[srcKey];
  if (dport >= 6881 && dport <= 6889) return 'BitTorrent';
  if (dport >= 50000 && dport <= 50099 && proto === 'UDP') return 'VoIP / RTP';
  if (dport === 8080 || dport === 8443) return 'Web Proxy / Alt';
  return `${proto} / ${dport}`;
}

const KNOWN_REMOTE_PREFIXES: Array<{ prefix: string; label: string; service: string }> = [
  { prefix: '1.1.1.', label: 'one.one.one.one', service: 'Cloudflare' },
  { prefix: '1.0.0.', label: '1.0.0.1', service: 'Cloudflare' },
  { prefix: '8.8.8.', label: 'dns.google', service: 'Google DNS' },
  { prefix: '8.8.4.', label: 'dns.google', service: 'Google DNS' },
  { prefix: '142.250.', label: 'youtube.com / 1e100.net', service: 'YouTube / Google' },
  { prefix: '172.217.', label: 'google.com / 1e100.net', service: 'Google' },
  { prefix: '17.253.', label: 'edge.icloud.com', service: 'Apple' },
  { prefix: '17.57.', label: 'push.apple.com', service: 'Apple' },
  { prefix: '52.94.', label: 's3.amazonaws.com', service: 'AWS Cloud' },
  { prefix: '54.239.', label: 'cloudfront.net', service: 'AWS CloudFront' },
  { prefix: '104.16.', label: 'cloudflare.com', service: 'Cloudflare' },
  { prefix: '172.64.', label: 'cloudflare-edge.net', service: 'Cloudflare' },
  { prefix: '140.82.', label: 'github.com', service: 'GitHub' },
  { prefix: '185.199.', label: 'objects.githubusercontent.com', service: 'GitHub' },
  { prefix: '151.101.', label: 'fastly.net', service: 'Fastly CDN' },
  { prefix: '23.246.', label: 'nflxvideo.net', service: 'Netflix' },
  { prefix: '45.57.', label: 'nflxso.net', service: 'Netflix' },
  { prefix: '162.159.', label: 'discord.gg / cloudflare', service: 'Discord' },
  { prefix: '155.133.', label: 'valve.net (Steam)', service: 'Valve / Steam' },
  { prefix: '13.107.', label: 'msedge.net', service: 'Microsoft' },
  { prefix: '20.190.', label: 'login.microsoftonline.com', service: 'Microsoft' },
];

export function describeRemoteIp(ip: string, cachedRdns?: string | null): { label: string; service: string } {
  if (cachedRdns) {
    const lower = cachedRdns.toLowerCase();
    let service = 'External Host';
    if (lower.includes('netflix') || lower.includes('nflx')) service = 'Netflix';
    else if (lower.includes('apple') || lower.includes('icloud')) service = 'Apple';
    else if (lower.includes('youtube') || lower.includes('googlevideo')) service = 'YouTube / Google';
    else if (lower.includes('google') || lower.includes('1e100')) service = 'Google';
    else if (lower.includes('amazonaws') || lower.includes('cloudfront')) service = 'AWS Cloud';
    else if (lower.includes('cloudflare')) service = 'Cloudflare';
    else if (lower.includes('github')) service = 'GitHub';
    else if (lower.includes('steam') || lower.includes('valve')) service = 'Valve / Steam';
    else if (lower.includes('discord')) service = 'Discord';
    else if (lower.includes('microsoft') || lower.includes('msedge')) service = 'Microsoft';
    else if (lower.includes('fastly')) service = 'Fastly CDN';
    else {
      const parts = lower.split('.').filter(Boolean);
      service = parts.length >= 2 ? parts.slice(-2).join('.') : cachedRdns;
    }
    return { label: cachedRdns, service };
  }

  for (const entry of KNOWN_REMOTE_PREFIXES) {
    if (ip.startsWith(entry.prefix)) {
      return { label: entry.label, service: entry.service };
    }
  }
  return { label: ip, service: 'External IP' };
}
