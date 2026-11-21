import type {
  BandwidthUnit,
  ConntrackState,
  DestinationCategory,
  TransportProtocol,
} from '../types/telemetry';

/**
 * Minimum combined throughput (bytes/sec) considered tangible live traffic.
 * 128 B/s ≈ 1 Kbps — anything below this displays as 0 Kbps (idle socket).
 */
export const MIN_TANGIBLE_BPS = 128;

export const ALL_DESTINATION_CATEGORIES: DestinationCategory[] = [
  'Streaming',
  'Social & Messaging',
  'Gaming',
  'Cloud & Hosting',
  'CDN & Web',
  'Communication',
  'Apple & Devices',
  'DNS & Infrastructure',
  'File & Downloads',
  'Local Network',
  'Other',
];

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

/**
 * Returns true when a conntrack session is actively established:
 * - TCP must be ESTABLISHED (filters out TIME_WAIT, FIN_WAIT, CLOSE_WAIT, SYN_SENT, CLOSE).
 * - UDP/ICMP/OTHER are stateless in nf_conntrack and considered active when not closing and assured.
 */
export function isActiveConnectionState(
  state: ConntrackState,
  proto: TransportProtocol,
  assured = true
): boolean {
  if (proto === 'TCP') {
    return state === 'ESTABLISHED';
  }
  return (state === 'ESTABLISHED' || state === 'STATELESS') && assured;
}

/**
 * Returns true when combined throughput meets or exceeds tangible live traffic threshold.
 */
export function hasTangibleTraffic(rxBps: number, txBps: number): boolean {
  return rxBps + txBps >= MIN_TANGIBLE_BPS;
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

interface RemoteMatchRule {
  patterns: string[];
  service: string;
  category: DestinationCategory;
}

const RDNS_CATEGORY_RULES: RemoteMatchRule[] = [
  // Streaming
  { patterns: ['nflxvideo', 'nflxso', 'nflximg', 'netflix'], service: 'Netflix', category: 'Streaming' },
  { patterns: ['googlevideo', 'youtube', 'ytimg'], service: 'YouTube', category: 'Streaming' },
  { patterns: ['spotify', 'scdn.co'], service: 'Spotify', category: 'Streaming' },
  { patterns: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'], service: 'Twitch', category: 'Streaming' },
  { patterns: ['disney', 'dssott', 'bamgrid'], service: 'Disney+', category: 'Streaming' },
  { patterns: ['hulu', 'hulustream'], service: 'Hulu', category: 'Streaming' },
  { patterns: ['plex.tv', 'plex.direct'], service: 'Plex', category: 'Streaming' },
  { patterns: ['vimeo', 'vimeocdn'], service: 'Vimeo', category: 'Streaming' },
  { patterns: ['roku.com'], service: 'Roku', category: 'Streaming' },
  { patterns: ['hbomax', 'max.com', 'warnermediacdn'], service: 'Max / HBO', category: 'Streaming' },
  { patterns: ['peacocktv'], service: 'Peacock', category: 'Streaming' },

  // Social & Messaging
  { patterns: ['discord'], service: 'Discord', category: 'Social & Messaging' },
  { patterns: ['whatsapp'], service: 'WhatsApp', category: 'Social & Messaging' },
  { patterns: ['instagram', 'cdninstagram'], service: 'Instagram', category: 'Social & Messaging' },
  { patterns: ['facebook', 'fbcdn', 'fbsbx', 'meta.com'], service: 'Meta / Facebook', category: 'Social & Messaging' },
  { patterns: ['tiktok', 'byteoversea', 'ibytedtos', 'musical.ly'], service: 'TikTok', category: 'Social & Messaging' },
  { patterns: ['reddit', 'redd.it'], service: 'Reddit', category: 'Social & Messaging' },
  { patterns: ['twitter', 'twimg', 'x.com'], service: 'X / Twitter', category: 'Social & Messaging' },
  { patterns: ['telegram'], service: 'Telegram', category: 'Social & Messaging' },
  { patterns: ['signal.org'], service: 'Signal', category: 'Social & Messaging' },
  { patterns: ['slack.com', 'slack-edge'], service: 'Slack', category: 'Social & Messaging' },
  { patterns: ['linkedin', 'licdn'], service: 'LinkedIn', category: 'Social & Messaging' },
  { patterns: ['snapchat', 'sc-cdn'], service: 'Snapchat', category: 'Social & Messaging' },

  // Gaming
  { patterns: ['steampowered', 'steamcontent', 'steamstatic', 'valve.net'], service: 'Valve / Steam', category: 'Gaming' },
  { patterns: ['xboxlive', 'xbox.com'], service: 'Xbox Live', category: 'Gaming' },
  { patterns: ['playstation', 'sonyentertainmentnetwork'], service: 'PlayStation', category: 'Gaming' },
  { patterns: ['nintendo'], service: 'Nintendo', category: 'Gaming' },
  { patterns: ['epicgames', 'unrealengine'], service: 'Epic Games', category: 'Gaming' },
  { patterns: ['riotgames', 'pvp.net'], service: 'Riot Games', category: 'Gaming' },
  { patterns: ['blizzard', 'battle.net'], service: 'Battle.net', category: 'Gaming' },
  { patterns: ['roblox'], service: 'Roblox', category: 'Gaming' },

  // Communication
  { patterns: ['zoom.us', 'zoomgov'], service: 'Zoom', category: 'Communication' },
  { patterns: ['teams.microsoft', 'skype'], service: 'Microsoft Teams', category: 'Communication' },
  { patterns: ['meet.google'], service: 'Google Meet', category: 'Communication' },

  // DNS & Infrastructure
  { patterns: ['dns.google'], service: 'Google DNS', category: 'DNS & Infrastructure' },
  { patterns: ['one.one.one.one', '1dot1dot1dot1'], service: 'Cloudflare DNS', category: 'DNS & Infrastructure' },
  { patterns: ['quad9.net'], service: 'Quad9 DNS', category: 'DNS & Infrastructure' },
  { patterns: ['opendns.com'], service: 'OpenDNS', category: 'DNS & Infrastructure' },
  { patterns: ['tailscale'], service: 'Tailscale', category: 'DNS & Infrastructure' },
  { patterns: ['mullvad', 'nordvpn', 'protonvpn'], service: 'VPN', category: 'DNS & Infrastructure' },

  // File & Downloads
  { patterns: ['dropbox'], service: 'Dropbox', category: 'File & Downloads' },
  { patterns: ['backblaze', 'backblazeb2'], service: 'Backblaze', category: 'File & Downloads' },
  { patterns: ['onedrive', 'livefilestore', 'sharepoint'], service: 'OneDrive', category: 'File & Downloads' },
  { patterns: ['s3.amazonaws', 's3-'], service: 'AWS S3', category: 'File & Downloads' },

  // Cloud & Hosting
  { patterns: ['github', 'githubusercontent'], service: 'GitHub', category: 'Cloud & Hosting' },
  { patterns: ['gitlab'], service: 'GitLab', category: 'Cloud & Hosting' },
  { patterns: ['docker.com', 'docker.io'], service: 'Docker Hub', category: 'Cloud & Hosting' },
  { patterns: ['googleusercontent'], service: 'Google Cloud', category: 'Cloud & Hosting' },
  { patterns: ['amazonaws'], service: 'AWS Cloud', category: 'Cloud & Hosting' },
  { patterns: ['azure', 'cloudapp.net', 'windows.net'], service: 'Microsoft Azure', category: 'Cloud & Hosting' },
  { patterns: ['digitalocean'], service: 'DigitalOcean', category: 'Cloud & Hosting' },
  { patterns: ['hetzner', 'your-server.de'], service: 'Hetzner', category: 'Cloud & Hosting' },
  { patterns: ['ovh.net', 'ovh.ca', 'ovh.us'], service: 'OVHcloud', category: 'Cloud & Hosting' },
  { patterns: ['linode', 'linodeusercontent'], service: 'Linode', category: 'Cloud & Hosting' },
  { patterns: ['vultr'], service: 'Vultr', category: 'Cloud & Hosting' },
  { patterns: ['oraclecloud'], service: 'Oracle Cloud', category: 'Cloud & Hosting' },
  { patterns: ['vercel'], service: 'Vercel', category: 'Cloud & Hosting' },
  { patterns: ['fly.dev', 'fly.io'], service: 'Fly.io', category: 'Cloud & Hosting' },

  // CDN & Web
  { patterns: ['cloudfront.net'], service: 'AWS CloudFront', category: 'CDN & Web' },
  { patterns: ['cloudflare'], service: 'Cloudflare', category: 'CDN & Web' },
  { patterns: ['fastly'], service: 'Fastly CDN', category: 'CDN & Web' },
  { patterns: ['akamai', 'akamaitechnologies', 'akamaiedge'], service: 'Akamai CDN', category: 'CDN & Web' },
  { patterns: ['edgecast', 'verizondigitalmedia'], service: 'Edgecast CDN', category: 'CDN & Web' },
  { patterns: ['bunnycdn', 'b-cdn.net'], service: 'Bunny CDN', category: 'CDN & Web' },

  // Apple & Devices / Ecosystem Services
  { patterns: ['apple.com', 'icloud.com', 'aaplimg.com', 'mzstatic.com', 'cdn-apple'], service: 'Apple', category: 'Apple & Devices' },
  { patterns: ['1e100.net', 'google.com', 'googleapis', 'gstatic'], service: 'Google', category: 'Apple & Devices' },
  { patterns: ['microsoft', 'msedge', 'office.com', 'office365', 'live.com', 'msn.com'], service: 'Microsoft', category: 'Apple & Devices' },
  { patterns: ['ecobee'], service: 'Ecobee IoT', category: 'Apple & Devices' },
  { patterns: ['ring.com'], service: 'Ring IoT', category: 'Apple & Devices' },
  { patterns: ['sonos'], service: 'Sonos', category: 'Apple & Devices' },
  { patterns: ['samsung'], service: 'Samsung', category: 'Apple & Devices' },
];

const KNOWN_REMOTE_PREFIXES: Array<{
  prefix: string;
  label: string;
  service: string;
  category: DestinationCategory;
}> = [
  { prefix: '1.1.1.', label: 'one.one.one.one', service: 'Cloudflare DNS', category: 'DNS & Infrastructure' },
  { prefix: '1.0.0.', label: '1dot1dot1dot1.cloudflare-dns.com', service: 'Cloudflare DNS', category: 'DNS & Infrastructure' },
  { prefix: '8.8.8.', label: 'dns.google', service: 'Google DNS', category: 'DNS & Infrastructure' },
  { prefix: '8.8.4.', label: 'dns.google', service: 'Google DNS', category: 'DNS & Infrastructure' },
  { prefix: '9.9.9.', label: 'dns9.quad9.net', service: 'Quad9 DNS', category: 'DNS & Infrastructure' },
  { prefix: '208.67.', label: 'resolver.opendns.com', service: 'OpenDNS', category: 'DNS & Infrastructure' },
  { prefix: '142.250.', label: '1e100.net', service: 'YouTube / Google', category: 'Streaming' },
  { prefix: '142.251.', label: '1e100.net', service: 'Google', category: 'Apple & Devices' },
  { prefix: '172.217.', label: '1e100.net', service: 'Google', category: 'Apple & Devices' },
  { prefix: '216.58.', label: '1e100.net', service: 'Google', category: 'Apple & Devices' },
  { prefix: '17.253.', label: 'edge.icloud.com', service: 'Apple', category: 'Apple & Devices' },
  { prefix: '17.57.', label: 'push.apple.com', service: 'Apple', category: 'Apple & Devices' },
  { prefix: '17.', label: 'apple.com', service: 'Apple', category: 'Apple & Devices' },
  { prefix: '52.94.', label: 's3.amazonaws.com', service: 'AWS S3', category: 'File & Downloads' },
  { prefix: '54.239.', label: 'cloudfront.net', service: 'AWS CloudFront', category: 'CDN & Web' },
  { prefix: '104.16.', label: 'cloudflare.com', service: 'Cloudflare', category: 'CDN & Web' },
  { prefix: '104.18.', label: 'cloudflare.com', service: 'Cloudflare', category: 'CDN & Web' },
  { prefix: '172.64.', label: 'cloudflare-edge.net', service: 'Cloudflare', category: 'CDN & Web' },
  { prefix: '172.67.', label: 'cloudflare-edge.net', service: 'Cloudflare', category: 'CDN & Web' },
  { prefix: '140.82.', label: 'github.com', service: 'GitHub', category: 'Cloud & Hosting' },
  { prefix: '185.199.', label: 'objects.githubusercontent.com', service: 'GitHub', category: 'Cloud & Hosting' },
  { prefix: '151.101.', label: 'fastly.net', service: 'Fastly CDN', category: 'CDN & Web' },
  { prefix: '23.246.', label: 'nflxvideo.net', service: 'Netflix', category: 'Streaming' },
  { prefix: '45.57.', label: 'nflxso.net', service: 'Netflix', category: 'Streaming' },
  { prefix: '162.159.', label: 'discord.gg', service: 'Discord', category: 'Social & Messaging' },
  { prefix: '31.13.', label: 'fbcdn.net', service: 'Meta / Facebook', category: 'Social & Messaging' },
  { prefix: '157.240.', label: 'fbcdn.net', service: 'Meta / Facebook', category: 'Social & Messaging' },
  { prefix: '155.133.', label: 'valve.net', service: 'Valve / Steam', category: 'Gaming' },
  { prefix: '162.254.', label: 'valve.net', service: 'Valve / Steam', category: 'Gaming' },
  { prefix: '13.107.', label: 'msedge.net', service: 'Microsoft', category: 'Apple & Devices' },
  { prefix: '20.190.', label: 'login.microsoftonline.com', service: 'Microsoft', category: 'Apple & Devices' },
  { prefix: '170.114.', label: 'zoom.us', service: 'Zoom', category: 'Communication' },
];

const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'co.jp',
  'ne.jp',
  'com.br',
  'co.nz',
  'co.in',
  'com.sg',
  'com.cn',
]);

function extractRootDomain(hostname: string): string {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function inferCategoryFromPort(
  proto: TransportProtocol,
  dport: number
): DestinationCategory {
  if (dport === 53 || dport === 853 || dport === 123 || dport === 51820 || dport === 1194) {
    return 'DNS & Infrastructure';
  }
  if (dport === 32400) return 'Streaming';
  if (dport === 3478 || dport === 19302 || (proto === 'UDP' && dport >= 50000 && dport <= 50099)) {
    return 'Communication';
  }
  if (dport === 27015) return 'Gaming';
  if (dport === 51413 || (dport >= 6881 && dport <= 6889)) return 'File & Downloads';
  if (dport === 5223 || dport === 5228 || dport === 1883 || dport === 8883) {
    return 'Apple & Devices';
  }
  if (dport === 22) return 'Cloud & Hosting';
  return 'Other';
}

export function describeRemoteIp(
  ip: string,
  cachedRdns?: string | null,
  proto?: TransportProtocol,
  dport?: number
): { label: string; service: string; category: DestinationCategory } {
  if (cachedRdns) {
    const cleanHost = cachedRdns.trim().replace(/\.+$/, '');
    const lower = cleanHost.toLowerCase();

    for (const rule of RDNS_CATEGORY_RULES) {
      if (rule.patterns.some((p) => lower.includes(p))) {
        return { label: cleanHost, service: rule.service, category: rule.category };
      }
    }

    const rootDomain = extractRootDomain(cleanHost);
    let category: DestinationCategory = 'CDN & Web';
    if (/(?:ec2|vps|cloud|compute|host|server|colo|dedi|static|node)/i.test(lower)) {
      category = 'Cloud & Hosting';
    } else if (/(?:dns|ns\d|resolver|ntp|vpn|wg|relay)/i.test(lower)) {
      category = 'DNS & Infrastructure';
    } else if (/(?:stream|video|media|audio|live)/i.test(lower)) {
      category = 'Streaming';
    } else if (/(?:game|lobby|match|arena)/i.test(lower)) {
      category = 'Gaming';
    } else if (proto && typeof dport === 'number') {
      const portCat = inferCategoryFromPort(proto, dport);
      if (portCat !== 'Other') category = portCat;
    }

    return { label: cleanHost, service: rootDomain || cleanHost, category };
  }

  for (const entry of KNOWN_REMOTE_PREFIXES) {
    if (ip.startsWith(entry.prefix)) {
      return { label: entry.label, service: entry.service, category: entry.category };
    }
  }

  const fallbackCategory =
    proto && typeof dport === 'number' ? inferCategoryFromPort(proto, dport) : 'Other';
  return { label: ip, service: 'External IP', category: fallbackCategory };
}

const SERVICE_SHORT_LABELS: Record<string, string> = {
  'Valve / Steam': 'Steam',
  'Meta / Facebook': 'Meta',
  'AWS CloudFront': 'CloudFront',
  'Microsoft Azure': 'Azure',
  'Microsoft Teams': 'Teams',
  'YouTube / Google': 'YouTube',
  'Cloudflare DNS': 'CF DNS',
  'Google Cloud': 'GCP',
  'AWS Cloud': 'AWS',
  'X / Twitter': 'X',
  'Max / HBO': 'Max',
  'Fastly CDN': 'Fastly',
  'Akamai CDN': 'Akamai',
  'Edgecast CDN': 'Edgecast',
  'Bunny CDN': 'Bunny',
  'Ecobee IoT': 'Ecobee',
  'Ring IoT': 'Ring',
  'Docker Hub': 'Docker',
  'Oracle Cloud': 'Oracle',
  'DigitalOcean': 'DO',
};

const APP_SHORT_LABELS: Record<string, string> = {
  'HTTPS / TLS': 'HTTPS',
  'QUIC / HTTP3': 'QUIC',
  'DNS over TCP': 'DNS',
  'DNS over TLS': 'DoT',
  'WireGuard VPN': 'WireGuard',
  'Google Meet / WebRTC': 'WebRTC',
  'STUN / WebRTC': 'WebRTC',
  'Google Push': 'Google Push',
  'Apple APNs': 'APNs',
  'Steam / Source': 'Steam',
  'Steam Client': 'Steam',
  'BitTorrent uTP': 'BitTorrent',
  'ICMP Ping': 'ICMP',
  'SMTP Submission': 'SMTP',
  'Plex Media': 'Plex',
  'Web Proxy / Alt': 'Web',
  'VoIP / RTP': 'VoIP',
};

/**
 * Produces a concise service/protocol label suitable for compact wrapped lists in the Devices table.
 */
export function condenseServiceLabel(service: string, app: string): string {
  const trimmedService = (service || '').trim();
  if (
    trimmedService &&
    trimmedService !== 'External IP' &&
    trimmedService !== 'Local Network'
  ) {
    if (SERVICE_SHORT_LABELS[trimmedService]) {
      return SERVICE_SHORT_LABELS[trimmedService];
    }
    return trimmedService.length > 18 ? `${trimmedService.slice(0, 17)}…` : trimmedService;
  }

  const trimmedApp = (app || '').trim();
  if (APP_SHORT_LABELS[trimmedApp]) {
    return APP_SHORT_LABELS[trimmedApp];
  }
  return trimmedApp || 'Other';
}

/**
 * Compares two IPv4 addresses numerically for stable sorting and tie-breaking.
 */
export function compareIpv4(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length === 4 && pb.length === 4 && !pa.some(Number.isNaN) && !pb.some(Number.isNaN)) {
    for (let i = 0; i < 4; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }
  return a.localeCompare(b);
}

