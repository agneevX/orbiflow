import express from 'express';
import fs from 'node:fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { TrafficMonitorEngine, exportFlowsToCsv } from './src/lib/telemetryEngine';
import { OrbiProbeSimulator } from './server/simulator';
import { RdnsCache } from './server/rdnsCache';
import { LanResolver } from './server/lanResolver';
import { NotificationDispatcher } from './server/notifications';
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_CONFIG_DIR,
  LEGACY_STATIC_PROBE_TOKEN,
  PersistenceStore,
  generateRandomProbeToken,
} from './server/storage';
import type {
  AlertEvent,
  AlertRule,
  NotificationConfig,
  PersistenceMode,
  ProbeSnapshot,
} from './src/types/telemetry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PORT = 3000;
const DIST_PATH = path.resolve(__dirname, 'dist');
const IS_DEV =
  process.argv.includes('--dev') || !fs.existsSync(path.join(DIST_PATH, 'index.html'));

const DEFAULT_STORAGE_MODE: PersistenceMode = 'memory';
const DEFAULT_RDNS_ENABLED = true;
const DEFAULT_RDNS_TTL_SEC = 3600;
const DEFAULT_LAN_DNS_ENABLED = true;
const DEFAULT_LAN_DNS_SERVER = '';
const DEFAULT_LAN_DNS_TTL_SEC = 300;
const DEFAULT_STRIP_LAN_DOMAIN = true;
const DEFAULT_INFER_DEVICE_NAMES = true;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const storage = new PersistenceStore(
    DEFAULT_STORAGE_MODE,
    DEFAULT_CONFIG_DIR,
    DEFAULT_CACHE_DIR
  );
  const rdnsCache = new RdnsCache({
    enabled: DEFAULT_RDNS_ENABLED,
    ttlSec: DEFAULT_RDNS_TTL_SEC,
    skipPrivate: true,
  });
  const lanResolver = new LanResolver({
    enabled: DEFAULT_LAN_DNS_ENABLED,
    server: DEFAULT_LAN_DNS_SERVER,
    ttlSec: DEFAULT_LAN_DNS_TTL_SEC,
    stripDomain: DEFAULT_STRIP_LAN_DOMAIN,
  });
  const notifier = new NotificationDispatcher();

  const engine = new TrafficMonitorEngine();
  engine.setSimulatorAvailable(IS_DEV);

  let activeProbeToken = '';
  let needsInitialConfigWrite = false;
  let initialSimulatorEnabled = IS_DEV;
  let initialInferDeviceNames = DEFAULT_INFER_DEVICE_NAMES;

  // Load persistent user config from /config/config.json before loading cached traffic history
  const savedUserConfig = storage.loadUserConfig();
  if (savedUserConfig) {
    const savedToken =
      typeof savedUserConfig.probeToken === 'string' ? savedUserConfig.probeToken.trim() : '';
    if (savedToken && savedToken !== LEGACY_STATIC_PROBE_TOKEN) {
      activeProbeToken = savedToken;
    } else {
      activeProbeToken = generateRandomProbeToken();
      needsInitialConfigWrite = true;
    }

    if (IS_DEV && typeof savedUserConfig.simulatorEnabled === 'boolean') {
      initialSimulatorEnabled = savedUserConfig.simulatorEnabled;
    }
    if (savedUserConfig.persistenceMode === 'memory' || savedUserConfig.persistenceMode === 'disk') {
      storage.setMode(savedUserConfig.persistenceMode);
    }
    if (typeof savedUserConfig.cacheDir === 'string' && savedUserConfig.cacheDir.trim()) {
      storage.setCacheDir(savedUserConfig.cacheDir);
    }
    rdnsCache.updateConfig({
      enabled: true,
      ttlSec:
        typeof savedUserConfig.rdnsTtlSec === 'number' ? savedUserConfig.rdnsTtlSec : undefined,
      skipPrivate:
        typeof savedUserConfig.rdnsSkipPrivate === 'boolean'
          ? savedUserConfig.rdnsSkipPrivate
          : undefined,
    });
    lanResolver.updateConfig({
      enabled:
        typeof savedUserConfig.lanDnsEnabled === 'boolean'
          ? savedUserConfig.lanDnsEnabled
          : undefined,
      server:
        typeof savedUserConfig.lanDnsServer === 'string'
          ? savedUserConfig.lanDnsServer
          : undefined,
      ttlSec:
        typeof savedUserConfig.lanDnsTtlSec === 'number'
          ? savedUserConfig.lanDnsTtlSec
          : undefined,
      stripDomain:
        typeof savedUserConfig.stripLanDomain === 'boolean'
          ? savedUserConfig.stripLanDomain
          : undefined,
    });
    if (typeof savedUserConfig.inferDeviceNames === 'boolean') {
      initialInferDeviceNames = savedUserConfig.inferDeviceNames;
    }
    if (savedUserConfig.deviceAliases && typeof savedUserConfig.deviceAliases === 'object') {
      engine.setDeviceAliases(savedUserConfig.deviceAliases);
    }
    if (savedUserConfig.notifications) {
      const cleanNotif = notifier.updateConfig(savedUserConfig.notifications);
      engine.updateNotifications(cleanNotif);
    }
    if (Array.isArray(savedUserConfig.rules) && savedUserConfig.rules.length > 0) {
      engine.mergeWithDefaultRules(savedUserConfig.rules);
    }
  } else {
    activeProbeToken = generateRandomProbeToken();
    needsInitialConfigWrite = true;
  }

  // Strictly disable simulator in production builds regardless of prior config
  engine.setSimulatorEnabled(IS_DEV ? initialSimulatorEnabled : false);

  engine.updateServerConfig({
    probeToken: activeProbeToken,
    persistenceMode: storage.getMode(),
    cacheDir: storage.getConfiguredCacheDir(),
    rdnsEnabled: rdnsCache.getConfig().enabled,
    rdnsTtlSec: rdnsCache.getConfig().ttlSec,
    rdnsSkipPrivate: rdnsCache.getConfig().skipPrivate,
    lanDnsEnabled: lanResolver.getConfig().enabled,
    lanDnsServer: lanResolver.getConfig().server,
    lanDnsTtlSec: lanResolver.getConfig().ttlSec,
    stripLanDomain: lanResolver.getConfig().stripDomain,
    inferDeviceNames: initialInferDeviceNames,
  });

  // Restore cached traffic history if disk persistence is active
  const savedState = storage.loadState();
  if (savedState) {
    engine.hydrateFromStorage({
      ...savedState,
      rules: engine.getSnapshot().rules,
      serverConfig: engine.getSnapshot().serverConfig,
    });
  }

  const persistUserConfig = () => {
    const snap = engine.getSnapshot();
    storage.saveUserConfig({
      probeToken: snap.serverConfig.probeToken,
      simulatorEnabled: IS_DEV ? engine.isSimulatorEnabled() : false,
      persistenceMode: snap.serverConfig.persistenceMode,
      cacheDir: snap.serverConfig.cacheDir,
      rdnsEnabled: snap.serverConfig.rdnsEnabled,
      rdnsTtlSec: snap.serverConfig.rdnsTtlSec,
      rdnsSkipPrivate: snap.serverConfig.rdnsSkipPrivate,
      lanDnsEnabled: snap.serverConfig.lanDnsEnabled,
      lanDnsServer: snap.serverConfig.lanDnsServer,
      lanDnsTtlSec: snap.serverConfig.lanDnsTtlSec,
      stripLanDomain: snap.serverConfig.stripLanDomain,
      inferDeviceNames: snap.serverConfig.inferDeviceNames,
      deviceAliases: engine.getDeviceAliases(),
      notifications: notifier.getConfig(),
      rules: snap.rules,
    });
  };

  if (needsInitialConfigWrite) {
    persistUserConfig();
  }

  // Dev-only simulator (never instantiated or seeded in production builds)
  const simulator = IS_DEV ? new OrbiProbeSimulator() : null;

  if (IS_DEV && simulator && engine.isSimulatorEnabled() && engine.getSnapshot().history.length === 0) {
    const now = Date.now();
    const threeHoursAgo = now - 180 * 60_000;
    for (let m = 0; m < 179; m++) {
      engine.ingest(simulator.nextSnapshot(threeHoursAgo + m * 60_000, 60));
    }
    const startRecent = now - 60 * 3_000;
    for (let s = 0; s <= 60; s++) {
      engine.ingest(
        simulator.nextSnapshot(startRecent + s * 3_000, 3),
        (ip) => rdnsCache.lookup(ip),
        (ip) => lanResolver.lookup(ip)
      );
    }
  }

  const server = http.createServer(app);
  const ingestWss = new WebSocketServer({ noServer: true });
  const dashboardWss = new WebSocketServer({ noServer: true });

  const broadcastDashboard = (event: { type: string; data: unknown }) => {
    const msg = JSON.stringify(event);
    for (const client of dashboardWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  };

  const dispatchAlertsAsync = (alerts: AlertEvent[]) => {
    for (const alert of alerts) {
      broadcastDashboard({ type: 'alert:fired', data: alert });
      void notifier.dispatchAlert(alert).catch(() => {});
    }
  };

  const syncStatsAndPersist = () => {
    const rStats = rdnsCache.getStats();
    const lStats = lanResolver.getStats();
    const sStats = storage.getStats();
    engine.setServerStats({
      configPath: sStats.configPath,
      activeCacheDir: sStats.activeCacheDir,
      persistedSnapshots: sStats.persistedSnapshots,
      diskLogSizeBytes: sStats.diskLogSizeBytes,
      rdnsCacheSize: rStats.size,
      rdnsHits: rStats.hits,
      rdnsMisses: rStats.misses,
      lanDnsCacheSize: lStats.size,
      lanDnsHits: lStats.hits,
      lanDnsMisses: lStats.misses,
      lanDnsResolved: lStats.resolved,
    });
  };

  const handleIngestSnapshot = (snapshot: ProbeSnapshot) => {
    const { dashboard, newAlerts } = engine.ingest(
      snapshot,
      (ip) => rdnsCache.lookup(ip),
      (ip) => lanResolver.lookup(ip)
    );
    storage.appendSnapshotLog({
      timestamp: snapshot.timestamp,
      rxBps: dashboard.kpis.rxBps,
      txBps: dashboard.kpis.txBps,
      activeFlows: dashboard.kpis.activeFlows,
      source: snapshot.source,
    });
    syncStatsAndPersist();
    storage.saveState(engine.getExportableState());

    const latest = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: latest });
    dispatchAlertsAsync(newAlerts);
  };

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const protocolHeader = request.headers['sec-websocket-protocol'];
    const protocols = (Array.isArray(protocolHeader) ? protocolHeader.join(',') : protocolHeader || '')
      .split(',')
      .map((p) => p.trim());

    if (url.pathname === '/ws/ingest') {
      const tokenHeader = request.headers['x-probe-token'];
      const queryToken = url.searchParams.get('token');
      const providedToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader || queryToken;

      const expectedToken = engine.getSnapshot().serverConfig.probeToken;
      if (expectedToken && providedToken !== expectedToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      ingestWss.handleUpgrade(request, socket, head, (ws) => {
        ingestWss.emit('connection', ws, request);
      });
    } else if (url.pathname === '/ws/dashboard') {
      dashboardWss.handleUpgrade(request, socket, head, (ws) => {
        dashboardWss.emit('connection', ws, request);
      });
    } else if (IS_DEV && (protocols.includes('vite-hmr') || protocols.includes('vite-ping'))) {
      return;
    } else {
      socket.destroy();
    }
  });

  ingestWss.on('connection', (ws) => {
    let connectedProbeId = 'router-wan';

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'probe:hello') {
          connectedProbeId = msg.probeId || connectedProbeId;
          return;
        }
        if (msg.type === 'probe:snapshot' && msg.data) {
          const snap: ProbeSnapshot = {
            ...msg.data,
            source: 'live',
            timestamp: msg.data.timestamp || Date.now(),
          };
          connectedProbeId = snap.probeId || connectedProbeId;
          handleIngestSnapshot(snap);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      const offlineAlerts = engine.markProbeDisconnected(connectedProbeId);
      broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
      dispatchAlertsAsync(offlineAlerts);
    });
  });

  dashboardWss.on('connection', (ws) => {
    syncStatsAndPersist();
    ws.send(JSON.stringify({ type: 'traffic:init', data: engine.getSnapshot() }));
  });

  // Dev-only simulator cadence (3s live updates)
  const simTimer =
    IS_DEV && simulator
      ? setInterval(() => {
          if (engine.hasActiveLiveProbe()) return;
          if (!engine.isSimulatorEnabled()) return;
          handleIngestSnapshot(simulator.nextSnapshot(Date.now(), 3));
        }, 3000)
      : null;

  app.get('/api/health', (_req, res) => {
    const snap = engine.getSnapshot();
    res.json({
      ok: true,
      mode: IS_DEV ? 'development' : 'production',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      probeMode: snap.probe.mode,
      activeFlows: snap.kpis.activeFlows,
      storageMode: storage.getMode(),
      configPath: storage.getConfigPath(),
      cacheDir: storage.getActiveCacheDir(),
    });
  });

  app.get('/api/state', (_req, res) => {
    syncStatsAndPersist();
    res.json(engine.getSnapshot());
  });

  app.post('/api/ingest', (req, res) => {
    const token = req.headers['x-probe-token'] || req.query.token;
    const expectedToken = engine.getSnapshot().serverConfig.probeToken;
    if (expectedToken && token !== expectedToken) {
      res.status(401).json({ error: 'Invalid probe token' });
      return;
    }
    const body = req.body as ProbeSnapshot;
    if (!body || !body.iface) {
      res.status(400).json({ error: 'Missing iface payload' });
      return;
    }
    handleIngestSnapshot({
      ...body,
      source: 'live',
      timestamp: body.timestamp || Date.now(),
    });
    res.json({ ok: true });
  });

  app.post('/api/simulator', (req, res) => {
    if (!IS_DEV || !simulator) {
      res.status(403).json({
        error: 'Simulator is disabled in production',
        enabled: false,
      });
      return;
    }
    const enabled = Boolean(req.body?.enabled);
    engine.setSimulatorEnabled(enabled);
    persistUserConfig();
    if (enabled && !engine.hasActiveLiveProbe()) {
      handleIngestSnapshot(simulator.nextSnapshot(Date.now(), 2));
    } else {
      broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    }
    res.json({ enabled: engine.isSimulatorEnabled(), snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    const nextProbeToken =
      typeof body.probeToken === 'string' && body.probeToken.trim()
        ? body.probeToken.trim()
        : engine.getSnapshot().serverConfig.probeToken;

    if (typeof body.cacheDir === 'string' && body.cacheDir.trim()) {
      storage.setCacheDir(body.cacheDir);
    }
    if (body.persistenceMode === 'memory' || body.persistenceMode === 'disk') {
      storage.setMode(body.persistenceMode);
    }
    const nextInferDeviceNames =
      typeof body.inferDeviceNames === 'boolean'
        ? body.inferDeviceNames
        : engine.getSnapshot().serverConfig.inferDeviceNames;

    engine.updateServerConfig({
      probeToken: nextProbeToken,
      persistenceMode: storage.getMode(),
      cacheDir: storage.getConfiguredCacheDir(),
      inferDeviceNames: nextInferDeviceNames,
    });
    syncStatsAndPersist();
    persistUserConfig();
    storage.saveState(engine.getExportableState(), true);
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({
      serverConfig: snap.serverConfig,
      serverStats: snap.serverStats,
      snapshot: snap,
    });
  });

  app.post('/api/notifications', (req, res) => {
    const body = req.body as Partial<NotificationConfig> | undefined;
    const updated = notifier.updateConfig(body);
    engine.updateNotifications(updated);
    persistUserConfig();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, notifications: updated });
  });

  app.post('/api/notifications/test', async (req, res) => {
    const channel = req.body?.channel === 'telegram' ? 'telegram' : 'ntfy';
    const override = req.body?.config as Partial<NotificationConfig> | undefined;
    const testAlert: AlertEvent = {
      id: `test-${Date.now()}`,
      ruleId: 'test',
      ruleName: 'Test Notification',
      severity: 'warning',
      message: 'OrbiFlow alert delivery test succeeded.',
      value: 1,
      threshold: 1,
      timestamp: Date.now(),
      acknowledged: true,
    };

    const result =
      channel === 'telegram'
        ? await notifier.sendTelegram(testAlert, override?.telegram)
        : await notifier.sendNtfy(testAlert, override?.ntfy);

    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/devices/alias', (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const matchBy = req.body?.matchBy === 'ip' ? 'ip' : 'mac';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!key) {
      res.status(400).json({ error: 'Missing device alias key' });
      return;
    }
    const aliases = engine.setDeviceAlias({ key, matchBy, name });
    persistUserConfig();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, deviceAliases: aliases, snapshot: snap });
  });

  app.delete('/api/devices/alias/:key', (req, res) => {
    const key = decodeURIComponent(req.params.key || '');
    const aliases = engine.deleteDeviceAlias(key);
    persistUserConfig();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, deviceAliases: aliases, snapshot: snap });
  });

  app.post('/api/rules', (req, res) => {
    const rules = req.body?.rules as AlertRule[] | undefined;
    if (!Array.isArray(rules)) {
      res.status(400).json({ error: 'Invalid rules array' });
      return;
    }
    const updated = engine.updateRules(rules);
    persistUserConfig();
    storage.saveState(engine.getExportableState(), true);
    broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    res.json({ rules: updated });
  });

  app.post('/api/alerts/:id/ack', (req, res) => {
    engine.acknowledgeAlert(req.params.id);
    storage.saveState(engine.getExportableState(), true);
    broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    res.json({ ok: true });
  });

  app.post('/api/alerts/clear', (_req, res) => {
    engine.clearAlerts();
    storage.saveState(engine.getExportableState(), true);
    broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    res.json({ ok: true });
  });

  app.get('/api/export/flows.csv', (_req, res) => {
    const csv = exportFlowsToCsv(engine.getSnapshot().flows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orbiflow-connections.csv"');
    res.send(csv);
  });

  if (IS_DEV) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_PATH));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_PATH, 'index.html'));
    });
  }

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
    const gid = typeof process.getgid === 'function' ? process.getgid() : 'n/a';
    console.log(
      `OrbiFlow listening on http://0.0.0.0:${SERVER_PORT} (mode=${IS_DEV ? 'development' : 'production'}, uid=${uid}, gid=${gid})`
    );
  });

  process.on('SIGTERM', () => {
    if (simTimer) clearInterval(simTimer);
    persistUserConfig();
    storage.saveState(engine.getExportableState(), true);
    server.close();
  });
}

startServer().catch((err) => {
  console.error('Failed to start OrbiFlow server:', err);
  process.exit(1);
});
