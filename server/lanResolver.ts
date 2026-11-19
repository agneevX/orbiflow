import dns from 'node:dns';
import { isPrivateIp } from '../src/lib/formatters';

interface LanCacheEntry {
  hostname: string | null;
  expiresAt: number;
}

export interface LanResolverConfig {
  enabled: boolean;
  server: string;
  ttlSec: number;
  stripDomain: boolean;
}

/**
 * Dedicated reverse-PTR resolver for local private LAN IPs.
 * Decoupled from external WAN rDNS so homelab users can keep public rDNS disabled
 * while resolving local devices against their separate LAN DNS server or custom router dnsmasq.
 */
export class LanResolver {
  private cache = new Map<string, LanCacheEntry>();
  private inFlight = new Set<string>();
  private config: LanResolverConfig;
  private resolver: dns.promises.Resolver;
  private hits = 0;
  private misses = 0;
  private readonly maxEntries = 1000;
  private readonly maxConcurrent = 6;

  constructor(initial?: Partial<LanResolverConfig>) {
    this.config = {
      enabled: initial?.enabled ?? true,
      server: (initial?.server ?? '').trim(),
      ttlSec: Math.max(30, Math.min(86400, Number(initial?.ttlSec) || 300)),
      stripDomain: initial?.stripDomain ?? true,
    };
    this.resolver = this.buildResolver(this.config.server);
  }

  private buildResolver(serverSpec: string): dns.promises.Resolver {
    const res = new dns.promises.Resolver();
    const servers = parseDnsServers(serverSpec);
    if (servers.length > 0) {
      try {
        res.setServers(servers);
      } catch {
        // Invalid server syntax falls back to system default resolver
      }
    }
    return res;
  }

  public getConfig(): LanResolverConfig {
    return { ...this.config };
  }

  public updateConfig(next: Partial<LanResolverConfig>): LanResolverConfig {
    const nextServer =
      typeof next.server === 'string' ? next.server.trim() : this.config.server;
    const serverChanged = nextServer !== this.config.server;

    this.config = {
      enabled: next.enabled ?? this.config.enabled,
      server: nextServer,
      ttlSec: Math.max(30, Math.min(86400, Number(next.ttlSec) || this.config.ttlSec)),
      stripDomain: next.stripDomain ?? this.config.stripDomain,
    };

    if (serverChanged) {
      this.resolver = this.buildResolver(this.config.server);
      this.clear();
    }

    return this.getConfig();
  }

  public getStats() {
    let resolved = 0;
    for (const entry of this.cache.values()) {
      if (entry.hostname) resolved += 1;
    }
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      resolved,
    };
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Synchronous lookup from cache; triggers a non-blocking PTR lookup against the
   * configured local DNS server (or system DNS) for private IPs only.
   */
  public lookup(ip: string, now = Date.now()): string | null {
    if (!ip || !isPrivateIp(ip)) return null;

    const entry = this.cache.get(ip);
    if (entry && entry.expiresAt > now) {
      this.hits += 1;
      return entry.hostname;
    }

    if (entry && entry.expiresAt <= now) {
      this.cache.delete(ip);
    }

    if (this.config.enabled && !this.inFlight.has(ip) && this.inFlight.size < this.maxConcurrent) {
      this.misses += 1;
      this.scheduleResolve(ip);
    }

    return null;
  }

  private scheduleResolve(ip: string): void {
    this.inFlight.add(ip);
    const activeResolver = this.resolver;
    const timeout = new Promise<string[]>((_, reject) =>
      setTimeout(() => reject(new Error('LAN PTR timeout')), 1500)
    );

    Promise.race([activeResolver.reverse(ip), timeout])
      .then((names) => {
        const raw = Array.isArray(names) && names.length > 0 ? names[0].trim() : null;
        const hostname = raw ? raw.replace(/\.+$/, '') : null;
        this.setEntry(ip, hostname);
      })
      .catch(() => {
        // Negative-cache for a shorter period (60s) so newly leased DHCP hosts resolve quickly
        this.setEntry(ip, null, Date.now(), Math.min(60, this.config.ttlSec));
      })
      .finally(() => {
        this.inFlight.delete(ip);
      });
  }

  public setEntry(
    ip: string,
    hostname: string | null,
    now = Date.now(),
    overrideTtlSec?: number
  ): void {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    const ttl = overrideTtlSec ?? this.config.ttlSec;
    this.cache.set(ip, {
      hostname,
      expiresAt: now + ttl * 1000,
    });
  }
}

export function parseDnsServers(serverSpec: string): string[] {
  if (!serverSpec || !serverSpec.trim()) return [];
  return serverSpec
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(s) || /^\[?[0-9a-fA-F:]+\]?(:\d{1,5})?$/.test(s));
}
