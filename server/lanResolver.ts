import dns from 'node:dns';
import net from 'node:net';
import { isPrivateIp } from '../src/lib/formatters';
import { stripLocalDomain } from '../src/lib/deviceIdentity';

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

export type LanDnsLookupMethod =
  | 'custom-dns'
  | 'container-dns'
  | 'os-nss'
  | 'router-fallback'
  | 'none';

export interface LanDnsTestResult {
  ok: boolean;
  ip: string;
  hostname: string | null;
  strippedHostname: string | null;
  method: LanDnsLookupMethod;
  server: string;
  latencyMs: number;
  error?: string;
}

const RESOLVE_TIMEOUT_MS = 3000;
const OS_LOOKUP_TIMEOUT_MS = 2500;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isUsableReverseName(raw: string | null | undefined, ip: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\.+$/, '');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (
    lower === ip.toLowerCase() ||
    lower === 'localhost' ||
    lower === 'localhost.localdomain' ||
    lower.endsWith('.in-addr.arpa') ||
    lower.endsWith('.ip6.arpa') ||
    net.isIP(cleaned) !== 0
  ) {
    return null;
  }
  return cleaned;
}

/**
 * Dedicated reverse-PTR resolver for local private LAN & VLAN IPs.
 *
 * Resolution strategy:
 * - When a custom DNS server is configured: queries that server directly (2500ms/2 tries),
 *   then falls back to OS lookupService (/etc/hosts + NSS).
 * - When using container DNS default (server blank): queries container /etc/resolv.conf,
 *   then falls back to OS lookupService (/etc/hosts + NSS), then auto-discovered private
 *   router/gateway DNS servers (so Docker bridge containers still resolve LAN devices even
 *   when Docker's embedded DNS forwards RFC1918 PTR queries to public resolvers).
 */
export class LanResolver {
  private cache = new Map<string, LanCacheEntry>();
  private inFlight = new Set<string>();
  private pendingQueue: string[] = [];
  private queuedSet = new Set<string>();
  private config: LanResolverConfig;
  private resolver: dns.promises.Resolver | null;
  private fallbackServers: string[] = [];
  private fallbackResolver: dns.promises.Resolver | null = null;
  private onResolved: ((ip: string, hostname: string) => void) | null = null;
  private hits = 0;
  private misses = 0;
  private readonly maxEntries = 1000;
  private readonly maxConcurrent = 16;

  constructor(
    initial?: Partial<LanResolverConfig>,
    options?: { onResolved?: (ip: string, hostname: string) => void }
  ) {
    this.config = {
      enabled: initial?.enabled ?? true,
      server: (initial?.server ?? '').trim(),
      ttlSec: Math.max(30, Math.min(86400, Number(initial?.ttlSec) || 300)),
      stripDomain: initial?.stripDomain ?? true,
    };
    this.onResolved = options?.onResolved ?? null;
    this.resolver = this.buildResolver(this.config.server);
  }

  public setOnResolved(cb: ((ip: string, hostname: string) => void) | null): void {
    this.onResolved = cb;
  }

  private buildResolverFromList(servers: string[]): dns.promises.Resolver | null {
    if (servers.length === 0) return null;
    try {
      const res = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
      res.setServers(servers);
      return res;
    } catch {
      return null;
    }
  }

  private buildResolver(serverSpec: string): dns.promises.Resolver | null {
    const servers = parseDnsServers(serverSpec);
    return this.buildResolverFromList(servers);
  }

  /**
   * Registers private DNS servers auto-discovered from the router (e.g. private wan.dns or
   * the primary LAN .1 gateway). Only used as a fallback when no custom server is configured.
   */
  public setFallbackServers(servers: string[]): void {
    const cleaned = Array.from(
      new Set(
        servers
          .map((s) => s.trim())
          .filter((s) => {
            if (!s) return false;
            const parsed = parseDnsServers(s);
            if (parsed.length !== 1) return false;
            const hostOnly = s.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
            return isPrivateIp(hostOnly) && !hostOnly.startsWith('127.');
          })
      )
    ).slice(0, 4);

    if (
      cleaned.length === this.fallbackServers.length &&
      cleaned.every((s, i) => s === this.fallbackServers[i])
    ) {
      return;
    }

    this.fallbackServers = cleaned;
    this.fallbackResolver = this.buildResolverFromList(cleaned);

    // If running in default mode, clear negative cache entries so previously unresolved hosts retry
    if (!this.config.server && cleaned.length > 0) {
      for (const [ip, entry] of this.cache.entries()) {
        if (entry.hostname === null) {
          this.cache.delete(ip);
        }
      }
    }
  }

  public getFallbackServers(): string[] {
    return [...this.fallbackServers];
  }

  public getConfig(): LanResolverConfig {
    return { ...this.config };
  }

  public updateConfig(next: Partial<LanResolverConfig>): LanResolverConfig {
    const nextServer =
      typeof next.server === 'string' ? next.server.trim() : this.config.server;
    const nextEnabled = next.enabled ?? this.config.enabled;
    const serverChanged = nextServer !== this.config.server;
    const newlyEnabled = nextEnabled && !this.config.enabled;

    this.config = {
      enabled: nextEnabled,
      server: nextServer,
      ttlSec: Math.max(30, Math.min(86400, Number(next.ttlSec) || this.config.ttlSec)),
      stripDomain: next.stripDomain ?? this.config.stripDomain,
    };

    if (serverChanged || newlyEnabled) {
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
    this.pendingQueue = [];
    this.queuedSet.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Queues non-blocking reverse PTR lookups for a batch of private IPs immediately.
   */
  public prefetchIps(ips: string[]): void {
    if (!this.config.enabled) return;
    for (const ip of ips) {
      if (ip && isPrivateIp(ip)) {
        this.lookup(ip);
      }
    }
  }

  /**
   * Synchronous lookup from cache; schedules a non-blocking PTR lookup against the
   * configured local DNS server (or container DNS + fallbacks) for private IPs only.
   */
  public lookup(ip: string, now = Date.now()): string | null {
    if (!this.config.enabled || !ip || !isPrivateIp(ip)) return null;

    const entry = this.cache.get(ip);
    if (entry && entry.expiresAt > now) {
      this.hits += 1;
      return entry.hostname;
    }

    if (entry && entry.expiresAt <= now) {
      this.cache.delete(ip);
    }

    if (!this.inFlight.has(ip) && !this.queuedSet.has(ip)) {
      this.misses += 1;
      if (this.inFlight.size < this.maxConcurrent) {
        this.scheduleResolve(ip);
      } else if (this.pendingQueue.length < this.maxEntries) {
        this.pendingQueue.push(ip);
        this.queuedSet.add(ip);
      }
    }

    return null;
  }

  private drainQueue(): void {
    while (this.inFlight.size < this.maxConcurrent && this.pendingQueue.length > 0) {
      const nextIp = this.pendingQueue.shift()!;
      this.queuedSet.delete(nextIp);
      const cached = this.cache.get(nextIp);
      if (cached && cached.expiresAt > Date.now()) continue;
      if (this.inFlight.has(nextIp)) continue;
      this.scheduleResolve(nextIp);
    }
  }

  private async tryReverseWith(
    res: dns.promises.Resolver | null,
    ip: string
  ): Promise<{ hostname: string | null; error?: string }> {
    try {
      const names = await withTimeout(
        res ? res.reverse(ip) : dns.promises.reverse(ip),
        RESOLVE_TIMEOUT_MS,
        'DNS PTR timeout'
      );
      if (Array.isArray(names)) {
        for (const candidate of names) {
          const usable = isUsableReverseName(candidate, ip);
          if (usable) return { hostname: usable };
        }
      }
      return { hostname: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { hostname: null, error: msg };
    }
  }

  private async tryOsLookupService(ip: string): Promise<{ hostname: string | null; error?: string }> {
    try {
      const result = await withTimeout(
        dns.promises.lookupService(ip, 0),
        OS_LOOKUP_TIMEOUT_MS,
        'OS lookupService timeout'
      );
      const usable = isUsableReverseName(result?.hostname, ip);
      return { hostname: usable };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { hostname: null, error: msg };
    }
  }

  private async resolveChain(
    ip: string,
    overrideServer?: string
  ): Promise<{
    hostname: string | null;
    method: LanDnsLookupMethod;
    server: string;
    error?: string;
  }> {
    const customSpec =
      overrideServer !== undefined ? overrideServer.trim() : this.config.server.trim();

    if (customSpec) {
      const customRes =
        overrideServer !== undefined ? this.buildResolver(customSpec) : this.resolver;
      if (!customRes) {
        return {
          hostname: null,
          method: 'none',
          server: customSpec,
          error: `Invalid DNS server address: ${customSpec}`,
        };
      }
      const primary = await this.tryReverseWith(customRes, ip);
      if (primary.hostname) {
        return { hostname: primary.hostname, method: 'custom-dns', server: customSpec };
      }
      // Fall back to OS /etc/hosts + NSS even when custom server didn't have a record
      const osRes = await this.tryOsLookupService(ip);
      if (osRes.hostname) {
        return { hostname: osRes.hostname, method: 'os-nss', server: '/etc/hosts · NSS' };
      }
      return {
        hostname: null,
        method: 'none',
        server: customSpec,
        error: primary.error || 'No PTR record found',
      };
    }

    // Default mode: 1) Container DNS (/etc/resolv.conf)
    const containerServers = dns.getServers().join(', ') || 'container DNS';
    const containerRes = await this.tryReverseWith(null, ip);
    if (containerRes.hostname) {
      return { hostname: containerRes.hostname, method: 'container-dns', server: containerServers };
    }

    // 2) OS getnameinfo (/etc/hosts + NSS + mDNS if configured)
    const osRes = await this.tryOsLookupService(ip);
    if (osRes.hostname) {
      return { hostname: osRes.hostname, method: 'os-nss', server: '/etc/hosts · NSS' };
    }

    // 3) Auto-discovered private router/LAN gateway DNS fallback
    if (this.fallbackResolver && this.fallbackServers.length > 0) {
      const fallbackStr = this.fallbackServers.join(', ');
      const fbRes = await this.tryReverseWith(this.fallbackResolver, ip);
      if (fbRes.hostname) {
        return { hostname: fbRes.hostname, method: 'router-fallback', server: fallbackStr };
      }
      return {
        hostname: null,
        method: 'none',
        server: `${containerServers} (fallback: ${fallbackStr})`,
        error: fbRes.error || containerRes.error || 'No PTR record found',
      };
    }

    return {
      hostname: null,
      method: 'none',
      server: containerServers,
      error: containerRes.error || 'No PTR record found',
    };
  }

  private scheduleResolve(ip: string): void {
    this.inFlight.add(ip);
    void this.resolveChain(ip)
      .then((res) => {
        if (res.hostname) {
          this.setEntry(ip, res.hostname);
          this.onResolved?.(ip, res.hostname);
        } else {
          // Shorter negative cache (30s) so newly leased DHCP hosts or freshly configured DNS resolve promptly
          this.setEntry(ip, null, Date.now(), Math.min(30, this.config.ttlSec));
        }
      })
      .catch(() => {
        this.setEntry(ip, null, Date.now(), Math.min(30, this.config.ttlSec));
      })
      .finally(() => {
        this.inFlight.delete(ip);
        this.drainQueue();
      });
  }

  /**
   * Live diagnostic reverse DNS test invoked from Settings to verify PTR resolution.
   */
  public async testLookup(ip: string, overrideServer?: string): Promise<LanDnsTestResult> {
    const cleanIp = (ip || '').trim();
    const start = Date.now();
    if (!cleanIp || net.isIP(cleanIp) === 0) {
      return {
        ok: false,
        ip: cleanIp,
        hostname: null,
        strippedHostname: null,
        method: 'none',
        server: overrideServer?.trim() || this.config.server || 'container DNS',
        latencyMs: 0,
        error: 'Enter a valid IPv4 or IPv6 address (e.g. 192.168.1.1)',
      };
    }

    const res = await this.resolveChain(cleanIp, overrideServer);
    const latencyMs = Math.max(1, Date.now() - start);
    const strippedHostname = res.hostname
      ? stripLocalDomain(res.hostname, this.config.stripDomain)
      : null;

    // Cache successful private IP results when testing against the active server configuration
    const testingActiveServer =
      overrideServer === undefined || overrideServer.trim() === this.config.server.trim();
    if (res.hostname && this.config.enabled && isPrivateIp(cleanIp) && testingActiveServer) {
      this.setEntry(cleanIp, res.hostname);
      this.onResolved?.(cleanIp, res.hostname);
    }

    return {
      ok: Boolean(res.hostname),
      ip: cleanIp,
      hostname: res.hostname,
      strippedHostname,
      method: res.method,
      server: res.server,
      latencyMs,
      ...(res.hostname ? {} : { error: res.error || 'No PTR record found for this IP' }),
    };
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
    .filter(
      (s) =>
        /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(s) ||
        /^\[?[0-9a-fA-F:]+\]?(:\d{1,5})?$/.test(s)
    );
}
