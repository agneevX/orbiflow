import type { VlanConfig } from '../types/telemetry';
import { isPrivateIp } from './formatters';

export function parseIpv4ToUint32(ip: string): number | null {
  if (typeof ip !== 'string') return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

export function uint32ToIpv4(value: number): string {
  const n = value >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function prefixToMask(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff >>> 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export interface ParsedCidr {
  network: number;
  mask: number;
  prefix: number;
  normalized: string;
}

export function parseIpv4Cidr(raw: string): ParsedCidr | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx <= 0 || slashIdx !== trimmed.lastIndexOf('/')) return null;
  const ipStr = trimmed.slice(0, slashIdx).trim();
  const prefixStr = trimmed.slice(slashIdx + 1).trim();
  if (!/^\d{1,2}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) return null;
  const ipInt = parseIpv4ToUint32(ipStr);
  if (ipInt === null) return null;
  const mask = prefixToMask(prefix);
  const network = (ipInt & mask) >>> 0;
  return {
    network,
    mask,
    prefix,
    normalized: `${uint32ToIpv4(network)}/${prefix}`,
  };
}

export function validateVlanCidr(raw: unknown): {
  ok: boolean;
  value: string;
  error?: string;
} {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, value: '', error: 'Enter a subnet CIDR (e.g. 10.0.1.0/24)' };
  }
  const parsed = parseIpv4Cidr(raw);
  if (!parsed) {
    return {
      ok: false,
      value: '',
      error: 'Enter a valid IPv4 CIDR between /8 and /32 (e.g. 10.0.1.0/24)',
    };
  }
  return { ok: true, value: parsed.normalized };
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const ipInt = parseIpv4ToUint32(ip);
  const parsed = parseIpv4Cidr(cidr);
  if (ipInt === null || !parsed) return false;
  return ((ipInt & parsed.mask) >>> 0) === parsed.network;
}

export function getIpv4Slash24(ip: string): string | null {
  const ipInt = parseIpv4ToUint32(ip);
  if (ipInt === null || !isPrivateIp(ip)) return null;
  const net = (ipInt & 0xffffff00) >>> 0;
  return `${uint32ToIpv4(net)}/24`;
}

/**
 * Matches an IP against configured VLANs using longest-prefix-match so a more specific
 * subnet (e.g. 10.0.1.0/24) always wins over a broader parent (e.g. 10.0.0.0/16).
 */
export function findMatchingVlan(ip: string, vlans: VlanConfig[]): VlanConfig | null {
  const ipInt = parseIpv4ToUint32(ip);
  if (ipInt === null || !Array.isArray(vlans) || vlans.length === 0) return null;

  let best: VlanConfig | null = null;
  let bestPrefix = -1;

  for (const vlan of vlans) {
    const parsed = parseIpv4Cidr(vlan.cidr);
    if (!parsed) continue;
    if (((ipInt & parsed.mask) >>> 0) === parsed.network && parsed.prefix > bestPrefix) {
      best = vlan;
      bestPrefix = parsed.prefix;
    }
  }
  return best;
}

export function sanitizeVlanConfigs(input: unknown): VlanConfig[] {
  if (!Array.isArray(input)) return [];
  const seenCidrs = new Set<string>();
  const out: VlanConfig[] = [];

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 40) : '';
    const cidrCheck = validateVlanCidr(rec.cidr);
    if (!name || !cidrCheck.ok) continue;
    if (seenCidrs.has(cidrCheck.value)) continue;
    seenCidrs.add(cidrCheck.value);

    const rawVlanId = rec.vlanId !== undefined && rec.vlanId !== '' ? Number(rec.vlanId) : undefined;
    const vlanId =
      rawVlanId !== undefined && Number.isInteger(rawVlanId) && rawVlanId >= 1 && rawVlanId <= 4094
        ? rawVlanId
        : undefined;
    const description =
      typeof rec.description === 'string' && rec.description.trim()
        ? rec.description.trim().slice(0, 120)
        : undefined;
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim().slice(0, 48)
        : `vlan-${cidrCheck.value.replace(/[^a-zA-Z0-9]/g, '-')}`;

    out.push({
      id,
      name,
      cidr: cidrCheck.value,
      ...(vlanId !== undefined ? { vlanId } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}
