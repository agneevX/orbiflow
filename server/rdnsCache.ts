import dns from 'node:dns';
import { isPrivateIp } from '../src/lib/formatters';

interface RdnsCacheEntry {
  hostname: string | null;
  expiresAt: number;
}

export interface RdnsConfig {
  enabled: boolean;
  ttlSec: number;
  skipPrivate: boolean;
}

export class RdnsCache {
  private cache = new Map<string, RdnsCacheEntry>();
  private inFlight = new Set<string>();
  private config: RdnsConfig;
  private hits = 0;
  private misses = 0;
  private readonly maxEntries = 4000;
  private readonly maxConcurrent = 12;

  constructor(initial?: Partial<RdnsConfig>) {
    this.config = {
      enabled: initial?.enabled ?? true,
      ttlSec: initial?.ttlSec ?? 3600,
      skipPrivate: initial?.skipPrivate ?? true,
    };
  }

  public getConfig(): RdnsConfig {
    return { ...this.config };
  }

  public updateConfig(next: Partial<RdnsConfig>): RdnsConfig {
    this.config = {
      enabled: next.enabled ?? this.config.enabled,
      ttlSec: Math.max(60, Math.min(86400, Number(next.ttlSec) || this.config.ttlSec)),
      skipPrivate: next.skipPrivate ?? this.config.skipPrivate,
    };
    return this.getConfig();
  }

  public getStats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Synchronous lookup against the in-memory cache; schedules background PTR lookup
   * when rDNS is enabled and the IP is not already cached or in flight.
   */
  public lookup(ip: string, now = Date.now()): string | null {
    if (!ip) return null;
    if (this.config.skipPrivate && isPrivateIp(ip)) return null;

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
    const timeout = new Promise<string[]>((_, reject) =>
      setTimeout(() => reject(new Error('rDNS timeout')), 1500)
    );

    Promise.race([dns.promises.reverse(ip), timeout])
      .then((names) => {
        const hostname = Array.isArray(names) && names.length > 0 ? names[0] : null;
        this.setEntry(ip, hostname);
      })
      .catch(() => {
        // Short negative cache so failed/NXDOMAIN lookups don't hammer DNS
        this.setEntry(ip, null);
      })
      .finally(() => {
        this.inFlight.delete(ip);
      });
  }

  public setEntry(ip: string, hostname: string | null, now = Date.now()): void {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    const effectiveTtlSec = hostname ? this.config.ttlSec : Math.min(300, this.config.ttlSec);
    this.cache.set(ip, {
      hostname,
      expiresAt: now + effectiveTtlSec * 1000,
    });
  }
}
