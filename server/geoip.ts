import fs from 'node:fs';
import path from 'node:path';
import maxmind, {
  type AsnResponse,
  type CityResponse,
  type CountryResponse,
  type Reader,
} from 'maxmind';
import type { GeoIpInfo } from '../src/types/telemetry';
import { isPrivateIp } from '../src/lib/formatters';

export const DEFAULT_GEOIP_DIR = '/config/geoip';
const MMDB_METADATA_MARKER = Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1');

export interface MaxMindStats {
  activeDir: string;
  configuredDir: string;
  enabled: boolean;
  cityLoaded: boolean;
  asnLoaded: boolean;
  cityFile: string | null;
  asnFile: string | null;
  lookups: number;
}

function ensureWritableDir(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function isValidMmdbBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 32) return false;
  return buf.lastIndexOf(MMDB_METADATA_MARKER) !== -1;
}

export class MaxMindService {
  private enabled: boolean;
  private configuredDir: string;
  private activeDir: string;
  private readonly fallbackBaseDir: string;

  private cityReader: Reader<CityResponse | CountryResponse> | null = null;
  private asnReader: Reader<AsnResponse> | null = null;
  private cityFile: string | null = null;
  private asnFile: string | null = null;

  private cache = new Map<string, GeoIpInfo | null>();
  private lookups = 0;

  constructor(
    options: {
      enabled?: boolean;
      geoipDir?: string;
      fallbackBaseDir?: string;
    } = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.fallbackBaseDir = options.fallbackBaseDir || path.resolve(process.cwd(), 'config');
    this.configuredDir = (options.geoipDir || DEFAULT_GEOIP_DIR).trim() || DEFAULT_GEOIP_DIR;
    this.activeDir = this.resolveDir(this.configuredDir);
  }

  private resolveDir(requestedDir: string): string {
    const clean = requestedDir.trim() || DEFAULT_GEOIP_DIR;
    const resolved = path.isAbsolute(clean) ? clean : path.resolve(process.cwd(), clean);
    if (ensureWritableDir(resolved)) {
      return resolved;
    }
    const fallback = path.join(this.fallbackBaseDir, 'geoip');
    if (ensureWritableDir(fallback)) {
      return fallback;
    }
    return resolved;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getConfiguredDir(): string {
    return this.configuredDir;
  }

  public getActiveDir(): string {
    return this.activeDir;
  }

  public async updateConfig(next: { enabled?: boolean; geoipDir?: string }): Promise<MaxMindStats> {
    let needsReload = false;
    if (typeof next.enabled === 'boolean') {
      this.enabled = next.enabled;
    }
    if (typeof next.geoipDir === 'string' && next.geoipDir.trim()) {
      const trimmed = next.geoipDir.trim();
      if (trimmed !== this.configuredDir) {
        this.configuredDir = trimmed;
        this.activeDir = this.resolveDir(trimmed);
        needsReload = true;
      }
    }
    if (needsReload || (this.enabled && !this.cityReader && !this.asnReader)) {
      await this.reload();
    }
    return this.getStats();
  }

  private findDatabaseFile(
    preferredNames: string[],
    keywordPattern: RegExp
  ): string | null {
    if (!fs.existsSync(this.activeDir)) {
      return null;
    }

    for (const name of preferredNames) {
      const full = path.join(this.activeDir, name);
      if (fs.existsSync(full)) return full;
    }

    try {
      const files = fs.readdirSync(this.activeDir);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.mmdb') && keywordPattern.test(file)) {
          return path.join(this.activeDir, file);
        }
      }
    } catch {
      // Ignore directory read errors
    }

    return null;
  }

  public async reload(): Promise<MaxMindStats> {
    this.cityReader = null;
    this.asnReader = null;
    this.cityFile = null;
    this.asnFile = null;
    this.cache.clear();

    const cityPath = this.findDatabaseFile(
      [
        'GeoLite2-City.mmdb',
        'GeoIP2-City.mmdb',
        'GeoLite2-Country.mmdb',
        'GeoIP2-Country.mmdb',
      ],
      /(city|country)/i
    );

    const asnPath = this.findDatabaseFile(
      ['GeoLite2-ASN.mmdb', 'GeoIP2-ASN.mmdb', 'GeoIP2-ISP.mmdb'],
      /(asn|isp)/i
    );

    if (cityPath) {
      try {
        this.cityReader = await maxmind.open<CityResponse | CountryResponse>(cityPath);
        this.cityFile = path.basename(cityPath);
      } catch {
        this.cityReader = null;
        this.cityFile = null;
      }
    }

    if (asnPath) {
      try {
        this.asnReader = await maxmind.open<AsnResponse>(asnPath);
        this.asnFile = path.basename(asnPath);
      } catch {
        this.asnReader = null;
        this.asnFile = null;
      }
    }

    return this.getStats();
  }

  public async saveUploadedDb(rawFilename: string, buffer: Buffer): Promise<{
    ok: boolean;
    error?: string;
    savedFile?: string;
    stats: MaxMindStats;
  }> {
    const safeName = path.basename(rawFilename || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeName || !safeName.toLowerCase().endsWith('.mmdb')) {
      return {
        ok: false,
        error: 'Filename must end with .mmdb (for example GeoLite2-City.mmdb or GeoLite2-ASN.mmdb).',
        stats: this.getStats(),
      };
    }

    if (!isValidMmdbBuffer(buffer)) {
      return {
        ok: false,
        error: 'Uploaded file is not a valid MaxMind MMDB database.',
        stats: this.getStats(),
      };
    }

    try {
      ensureWritableDir(this.activeDir);
      const target = path.join(this.activeDir, safeName);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, target);
      const stats = await this.reload();
      return {
        ok: true,
        savedFile: safeName,
        stats,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to write MMDB file to disk.',
        stats: this.getStats(),
      };
    }
  }

  public lookup(ip: string): GeoIpInfo | null {
    if (!this.enabled) return null;
    if (!this.cityReader && !this.asnReader) return null;
    if (!ip || isPrivateIp(ip) || !maxmind.validate(ip)) return null;

    if (this.cache.has(ip)) {
      return this.cache.get(ip) ?? null;
    }

    let countryCode: string | undefined;
    let countryName: string | undefined;
    let city: string | undefined;
    let asn: number | undefined;
    let org: string | undefined;

    if (this.cityReader) {
      try {
        const res = this.cityReader.get(ip) as CityResponse | CountryResponse | null;
        if (res) {
          countryCode = res.country?.iso_code || res.registered_country?.iso_code;
          countryName = res.country?.names?.en || res.registered_country?.names?.en;
          if ('city' in res && res.city?.names?.en) {
            city = res.city.names.en;
          }
        }
      } catch {
        // Ignore single IP parse errors
      }
    }

    if (this.asnReader) {
      try {
        const res = this.asnReader.get(ip);
        if (res) {
          asn = res.autonomous_system_number;
          org = res.autonomous_system_organization;
        }
      } catch {
        // Ignore single IP parse errors
      }
    }

    const result: GeoIpInfo | null =
      countryCode || countryName || city || asn || org
        ? {
            countryCode,
            countryName,
            city,
            asn,
            org,
            source: 'maxmind',
          }
        : null;

    if (this.cache.size >= 4096) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(ip, result);
    if (result) {
      this.lookups += 1;
    }
    return result;
  }

  public getStats(): MaxMindStats {
    return {
      activeDir: this.activeDir,
      configuredDir: this.configuredDir,
      enabled: this.enabled,
      cityLoaded: this.cityReader !== null,
      asnLoaded: this.asnReader !== null,
      cityFile: this.cityFile,
      asnFile: this.asnFile,
      lookups: this.lookups,
    };
  }
}
