import fs from 'node:fs';
import path from 'node:path';
import type {
  AlertEvent,
  AlertRule,
  DeviceAlias,
  PersistenceMode,
  ServerConfig,
  TrafficPoint,
} from '../src/types/telemetry';

export const DEFAULT_CONFIG_DIR = '/config';
export const DEFAULT_CACHE_DIR = '/config/cache';

export interface PersistedUserConfig {
  persistenceMode: PersistenceMode;
  cacheDir: string;
  rdnsEnabled: boolean;
  rdnsTtlSec: number;
  rdnsSkipPrivate: boolean;
  lanDnsEnabled?: boolean;
  lanDnsServer?: string;
  lanDnsTtlSec?: number;
  stripLanDomain?: boolean;
  geoipEnabled?: boolean;
  geoipDir?: string;
  deviceAliases?: Record<string, DeviceAlias>;
  rules?: AlertRule[];
}

export interface PersistedEngineState {
  history: TrafficPoint[];
  rollupHistory: TrafficPoint[];
  peakRxBps: number;
  peakTxBps: number;
  rules: AlertRule[];
  alerts: AlertEvent[];
  serverConfig: ServerConfig;
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

export class PersistenceStore {
  private mode: PersistenceMode;
  private readonly configuredConfigDir: string;
  private readonly activeConfigDir: string;
  private readonly configFile: string;

  private configuredCacheDir: string;
  private activeCacheDir: string;
  private stateFile: string;
  private logFile: string;

  private persistedCount = 0;
  private lastDiskWriteMs = 0;

  constructor(
    mode: PersistenceMode = 'memory',
    configDir = process.env.ORBIFLOW_CONFIG_DIR || DEFAULT_CONFIG_DIR,
    cacheDir = process.env.ORBIFLOW_CACHE_DIR || DEFAULT_CACHE_DIR
  ) {
    this.mode = mode;
    this.configuredConfigDir = configDir.trim() || DEFAULT_CONFIG_DIR;

    const fallbackConfigDir = path.resolve(process.cwd(), 'config');
    this.activeConfigDir = ensureWritableDir(this.configuredConfigDir)
      ? this.configuredConfigDir
      : ensureWritableDir(fallbackConfigDir)
        ? fallbackConfigDir
        : this.configuredConfigDir;

    this.configFile = path.join(this.activeConfigDir, 'config.json');

    this.configuredCacheDir = cacheDir.trim() || DEFAULT_CACHE_DIR;
    this.activeCacheDir = this.resolveWritableCacheDir(this.configuredCacheDir);
    this.stateFile = path.join(this.activeCacheDir, 'traffic-state.json');
    this.logFile = path.join(this.activeCacheDir, 'traffic-snapshots.jsonl');
  }

  private resolveWritableCacheDir(requestedDir: string): string {
    const clean = requestedDir.trim() || DEFAULT_CACHE_DIR;
    const resolved = path.isAbsolute(clean) ? clean : path.resolve(process.cwd(), clean);
    if (ensureWritableDir(resolved)) {
      return resolved;
    }
    const fallback = path.join(this.activeConfigDir, 'cache');
    if (ensureWritableDir(fallback)) {
      return fallback;
    }
    return resolved;
  }

  public getMode(): PersistenceMode {
    return this.mode;
  }

  public setMode(mode: PersistenceMode): void {
    this.mode = mode;
    if (mode === 'disk') {
      this.activeCacheDir = this.resolveWritableCacheDir(this.configuredCacheDir);
      this.stateFile = path.join(this.activeCacheDir, 'traffic-state.json');
      this.logFile = path.join(this.activeCacheDir, 'traffic-snapshots.jsonl');
    }
  }

  public getConfigPath(): string {
    return this.configFile;
  }

  public getConfiguredCacheDir(): string {
    return this.configuredCacheDir;
  }

  public getActiveCacheDir(): string {
    return this.activeCacheDir;
  }

  public setCacheDir(nextDir: string): { configuredCacheDir: string; activeCacheDir: string } {
    const trimmed = nextDir.trim();
    if (!trimmed) {
      return {
        configuredCacheDir: this.configuredCacheDir,
        activeCacheDir: this.activeCacheDir,
      };
    }
    this.configuredCacheDir = trimmed;
    this.activeCacheDir = this.resolveWritableCacheDir(trimmed);
    this.stateFile = path.join(this.activeCacheDir, 'traffic-state.json');
    this.logFile = path.join(this.activeCacheDir, 'traffic-snapshots.jsonl');
    return {
      configuredCacheDir: this.configuredCacheDir,
      activeCacheDir: this.activeCacheDir,
    };
  }

  public loadUserConfig(): Partial<PersistedUserConfig> | null {
    try {
      if (!fs.existsSync(this.configFile)) return null;
      const raw = fs.readFileSync(this.configFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedUserConfig>;
      return parsed;
    } catch {
      return null;
    }
  }

  public saveUserConfig(cfg: PersistedUserConfig): void {
    try {
      ensureWritableDir(this.activeConfigDir);
      const tmp = `${this.configFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, this.configFile);
    } catch {
      // Ignore transient disk write failures
    }
  }

  public loadState(): Partial<PersistedEngineState> | null {
    if (this.mode !== 'disk') return null;
    try {
      const candidate = fs.existsSync(this.stateFile)
        ? this.stateFile
        : path.join(this.activeCacheDir, 'orbiflow-state.json');
      if (!fs.existsSync(candidate)) return null;
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedEngineState>;
      return parsed;
    } catch {
      return null;
    }
  }

  public appendSnapshotLog(entry: {
    timestamp: number;
    rxBps: number;
    txBps: number;
    activeFlows: number;
    source: string;
  }): void {
    this.persistedCount += 1;
    if (this.mode !== 'disk') return;

    try {
      ensureWritableDir(this.activeCacheDir);
      // Rotate log if above 5 MB
      if (fs.existsSync(this.logFile)) {
        const stat = fs.statSync(this.logFile);
        if (stat.size > 5 * 1024 * 1024) {
          const rotated = path.join(this.activeCacheDir, 'traffic-snapshots.prev.jsonl');
          fs.renameSync(this.logFile, rotated);
        }
      }
      fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      // Ignore transient disk errors
    }
  }

  public saveState(state: PersistedEngineState, force = false): void {
    if (this.mode !== 'disk') return;
    const now = Date.now();
    if (!force && now - this.lastDiskWriteMs < 15_000) return;
    this.lastDiskWriteMs = now;

    try {
      ensureWritableDir(this.activeCacheDir);
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // Ignore transient disk errors
    }
  }

  public getStats() {
    let diskLogSizeBytes = 0;
    if (this.mode === 'disk') {
      try {
        if (fs.existsSync(this.logFile)) {
          diskLogSizeBytes += fs.statSync(this.logFile).size;
        }
        if (fs.existsSync(this.stateFile)) {
          diskLogSizeBytes += fs.statSync(this.stateFile).size;
        }
      } catch {
        // Ignore stat error
      }
    }
    return {
      configPath: this.configFile,
      activeCacheDir: this.activeCacheDir,
      persistedSnapshots: this.persistedCount,
      diskLogSizeBytes,
    };
  }
}
