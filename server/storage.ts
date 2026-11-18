import fs from 'node:fs';
import path from 'node:path';
import type { AlertEvent, AlertRule, PersistenceMode, ServerConfig, TrafficPoint } from '../src/types/telemetry';

export interface PersistedEngineState {
  history: TrafficPoint[];
  rollupHistory: TrafficPoint[];
  peakRxBps: number;
  peakTxBps: number;
  rules: AlertRule[];
  alerts: AlertEvent[];
  serverConfig: ServerConfig;
}

export class PersistenceStore {
  private mode: PersistenceMode;
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly logFile: string;
  private persistedCount = 0;
  private lastDiskWriteMs = 0;

  constructor(mode: PersistenceMode = 'memory', dataDir = path.resolve(process.cwd(), 'data')) {
    this.mode = mode;
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'orbiflow-state.json');
    this.logFile = path.join(dataDir, 'traffic-snapshots.jsonl');
  }

  public getMode(): PersistenceMode {
    return this.mode;
  }

  public setMode(mode: PersistenceMode): void {
    this.mode = mode;
    if (mode === 'disk') {
      this.ensureDir();
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  public loadState(): Partial<PersistedEngineState> | null {
    if (this.mode !== 'disk') return null;
    try {
      if (!fs.existsSync(this.stateFile)) return null;
      const raw = fs.readFileSync(this.stateFile, 'utf8');
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
      this.ensureDir();
      // Rotate log if above 5 MB
      if (fs.existsSync(this.logFile)) {
        const stat = fs.statSync(this.logFile);
        if (stat.size > 5 * 1024 * 1024) {
          const rotated = path.join(this.dataDir, 'traffic-snapshots.prev.jsonl');
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
      this.ensureDir();
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
      persistedSnapshots: this.persistedCount,
      diskLogSizeBytes,
    };
  }
}
