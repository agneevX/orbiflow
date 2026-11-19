import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { TrafficMonitorEngine, exportFlowsToCsv } from './src/lib/telemetryEngine';
import { OrbiProbeSimulator } from './server/simulator';
import { RdnsCache } from './server/rdnsCache';
import { LanResolver } from './server/lanResolver';
import { DEFAULT_CACHE_DIR, DEFAULT_CONFIG_DIR, PersistenceStore } from './server/storage';
import { DEFAULT_GEOIP_DIR, MaxMindService } from './server/geoip';
import type { AlertRule, PersistenceMode, ProbeSnapshot } from './src/types/telemetry';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PROBE_TOKEN = process.env.ORBIFLOW_PROBE_TOKEN || 'orbi-rbk50-voxel-secret';
const SIMULATOR_DEFAULT = process.env.ORBIFLOW_ENABLE_SIMULATOR !== 'false';
const STORAGE_MODE: PersistenceMode =
  process.env.ORBIFLOW_STORAGE_MODE === 'disk' ? 'disk' : 'memory';
const CONFIG_DIR = process.env.ORBIFLOW_CONFIG_DIR || DEFAULT_CONFIG_DIR;
const CACHE_DIR = process.env.ORBIFLOW_CACHE_DIR || DEFAULT_CACHE_DIR;
const GEOIP_DIR = process.env.ORBIFLOW_GEOIP_DIR || DEFAULT_GEOIP_DIR;
const GEOIP_ENABLED_DEFAULT = process.env.ORBIFLOW_GEOIP_ENABLED !== 'false';
const RDNS_ENABLED_DEFAULT = process.env.ORBIFLOW_RDNS_ENABLED === 'true';
const LAN_DNS_ENABLED_DEFAULT = process.env.ORBIFLOW_LAN_DNS_ENABLED !== 'false';
const LAN_DNS_SERVER_DEFAULT = process.env.ORBIFLOW_LAN_DNS_SERVER || '';
const LAN_DNS_TTL_DEFAULT = Number(process.env.ORBIFLOW_LAN_DNS_TTL || 300);
const STRIP_LAN_DOMAIN_DEFAULT = process.env.ORBIFLOW_STRIP_LAN_DOMAIN !== 'false';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const storage = new PersistenceStore(STORAGE_MODE, CONFIG_DIR, CACHE_DIR);
  const geoip = new MaxMindService({
    enabled: GEOIP_ENABLED_DEFAULT,
    geoipDir: GEOIP_DIR,
    fallbackBaseDir: path.dirname(storage.getConfigPath()),
  });
  const rdnsCache = new RdnsCache({
    enabled: RDNS_ENABLED_DEFAULT,
    ttlSec: Number(process.env.ORBIFLOW_RDNS_TTL || 3600),
    skipPrivate: true,
  });
  const lanResolver = new LanResolver({
    enabled: LAN_DNS_ENABLED_DEFAULT,
    server: LAN_DNS_SERVER_DEFAULT,
    ttlSec: LAN_DNS_TTL_DEFAULT,
    stripDomain: STRIP_LAN_DOMAIN_DEFAULT,
  });

  const engine = new TrafficMonitorEngine();
  engine.setSimulatorEnabled(SIMULATOR_DEFAULT);

  // Load persistent user config from /config/config.json before loading cached traffic history
  const savedUserConfig = storage.loadUserConfig();
  if (savedUserConfig) {
    if (savedUserConfig.persistenceMode === 'memory' || savedUserConfig.persistenceMode === 'disk') {
      storage.setMode(savedUserConfig.persistenceMode);
    }
    if (typeof savedUserConfig.cacheDir === 'string' && savedUserConfig.cacheDir.trim()) {
      storage.setCacheDir(savedUserConfig.cacheDir);
    }
    await geoip.updateConfig({
      enabled:
        typeof savedUserConfig.geoipEnabled === 'boolean'
          ? savedUserConfig.geoipEnabled
          : undefined,
      geoipDir:
        typeof savedUserConfig.geoipDir === 'string' && savedUserConfig.geoipDir.trim()
          ? savedUserConfig.geoipDir
          : undefined,
    });
    rdnsCache.updateConfig({
      enabled:
        typeof savedUserConfig.rdnsEnabled === 'boolean' ? savedUserConfig.rdnsEnabled : undefined,
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
    if (savedUserConfig.deviceAliases && typeof savedUserConfig.deviceAliases === 'object') {
      engine.setDeviceAliases(savedUserConfig.deviceAliases);
    }
    if (Array.isArray(savedUserConfig.rules) && savedUserConfig.rules.length > 0) {
      engine.updateRules(savedUserConfig.rules);
    }
  } else {
    await geoip.reload();
  }

  engine.updateServerConfig({
    persistenceMode: storage.getMode(),
    cacheDir: storage.getConfiguredCacheDir(),
    rdnsEnabled: rdnsCache.getConfig().enabled,
    rdnsTtlSec: rdnsCache.getConfig().ttlSec,
    rdnsSkipPrivate: rdnsCache.getConfig().skipPrivate,
    lanDnsEnabled: lanResolver.getConfig().enabled,
    lanDnsServer: lanResolver.getConfig().server,
    lanDnsTtlSec: lanResolver.getConfig().ttlSec,
    stripLanDomain: lanResolver.getConfig().stripDomain,
    geoipEnabled: geoip.isEnabled(),
    geoipDir: geoip.getConfiguredDir(),
  });

  // Restore cached traffic history if disk persistence is active
  const savedState = storage.loadState();
  if (savedState) {
    engine.hydrateFromStorage({
      ...savedState,
      // Keep user config & rules from /config/config.json authoritative over cache snapshots
      rules: savedUserConfig?.rules?.length ? savedUserConfig.rules : savedState.rules,
      serverConfig: engine.getSnapshot().serverConfig,
    });
  }

  const persistUserConfig = () => {
    const snap = engine.getSnapshot();
    storage.saveUserConfig({
      persistenceMode: snap.serverConfig.persistenceMode,
      cacheDir: snap.serverConfig.cacheDir,
      rdnsEnabled: snap.serverConfig.rdnsEnabled,
      rdnsTtlSec: snap.serverConfig.rdnsTtlSec,
      rdnsSkipPrivate: snap.serverConfig.rdnsSkipPrivate,
      lanDnsEnabled: snap.serverConfig.lanDnsEnabled,
      lanDnsServer: snap.serverConfig.lanDnsServer,
      lanDnsTtlSec: snap.serverConfig.lanDnsTtlSec,
      stripLanDomain: snap.serverConfig.stripLanDomain,
      geoipEnabled: snap.serverConfig.geoipEnabled,
      geoipDir: snap.serverConfig.geoipDir,
      deviceAliases: engine.getDeviceAliases(),
      rules: snap.rules,
    });
  };

  // Ensure /config/config.json exists on first boot so users can inspect or back it up
  if (!savedUserConfig) {
    persistUserConfig();
  }

  const simulator = new OrbiProbeSimulator();

  // Seed historical buckets + recent 150s samples if empty and simulator is enabled
  if (SIMULATOR_DEFAULT && engine.getSnapshot().history.length === 0) {
    const now = Date.now();
    // Seed 3 hours of 1-minute samples so 1m/5m/15m/1h have full continuity while 6h/24h denote earlier unrecorded hours
    const threeHoursAgo = now - 180 * 60_000;
    for (let m = 0; m < 179; m++) {
      engine.ingest(simulator.nextSnapshot(threeHoursAgo + m * 60_000, 60));
    }
    // Then seed recent 150 seconds at 5s intervals (matching low-CPU 5s agent cadence)
    const startRecent = now - 150_000;
    for (let s = 0; s <= 30; s++) {
      engine.ingest(simulator.nextSnapshot(startRecent + s * 5_000, 5));
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

  const syncStatsAndPersist = () => {
    const rStats = rdnsCache.getStats();
    const lStats = lanResolver.getStats();
    const sStats = storage.getStats();
    const gStats = geoip.getStats();
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
      geoipActiveDir: gStats.activeDir,
      geoipCityLoaded: gStats.cityLoaded,
      geoipAsnLoaded: gStats.asnLoaded,
      geoipCityFile: gStats.cityFile,
      geoipAsnFile: gStats.asnFile,
      geoipLookups: gStats.lookups,
    });
  };

  const handleIngestSnapshot = (snapshot: ProbeSnapshot) => {
    const { dashboard, newAlerts } = engine.ingest(
      snapshot,
      (ip) => rdnsCache.lookup(ip),
      (ip) => geoip.lookup(ip),
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
    for (const alert of newAlerts) {
      broadcastDashboard({ type: 'alert:fired', data: alert });
    }
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

      if (PROBE_TOKEN && providedToken !== PROBE_TOKEN) {
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
    } else if (
      process.env.NODE_ENV !== 'production' &&
      (protocols.includes('vite-hmr') || protocols.includes('vite-ping'))
    ) {
      // Allow Vite dev middleware WebSocket handler to complete @vite/client handshakes cleanly
      return;
    } else {
      socket.destroy();
    }
  });

  ingestWss.on('connection', (ws) => {
    let connectedProbeId = 'orbi-rbk50-eth0';

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
      engine.markProbeDisconnected(connectedProbeId);
      broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    });
  });

  dashboardWss.on('connection', (ws) => {
    syncStatsAndPersist();
    ws.send(JSON.stringify({ type: 'traffic:init', data: engine.getSnapshot() }));
  });

  // Low-overhead 2s simulator cadence (real Orbi agent defaults to 5s low-CPU interval)
  const simTimer = setInterval(() => {
    if (engine.hasActiveLiveProbe()) return;
    if (!engine.isSimulatorEnabled()) return;
    handleIngestSnapshot(simulator.nextSnapshot(Date.now(), 2));
  }, 2000);

  app.get('/api/health', (_req, res) => {
    const snap = engine.getSnapshot();
    const gStats = geoip.getStats();
    res.json({
      ok: true,
      probeMode: snap.probe.mode,
      activeFlows: snap.kpis.activeFlows,
      storageMode: storage.getMode(),
      configPath: storage.getConfigPath(),
      cacheDir: storage.getActiveCacheDir(),
      geoipDir: gStats.activeDir,
      geoipCityLoaded: gStats.cityLoaded,
      geoipAsnLoaded: gStats.asnLoaded,
      rdnsEnabled: rdnsCache.getConfig().enabled,
      lanDnsEnabled: lanResolver.getConfig().enabled,
      lanDnsServer: lanResolver.getConfig().server,
    });
  });

  app.get('/api/state', (_req, res) => {
    syncStatsAndPersist();
    res.json(engine.getSnapshot());
  });

  app.post('/api/ingest', (req, res) => {
    const token = req.headers['x-probe-token'] || req.query.token;
    if (PROBE_TOKEN && token !== PROBE_TOKEN) {
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
    const enabled = Boolean(req.body?.enabled);
    engine.setSimulatorEnabled(enabled);
    if (enabled && !engine.hasActiveLiveProbe()) {
      handleIngestSnapshot(simulator.nextSnapshot(Date.now(), 2));
    } else {
      broadcastDashboard({ type: 'traffic:tick', data: engine.getSnapshot() });
    }
    res.json({ enabled: engine.isSimulatorEnabled(), snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings', async (req, res) => {
    const body = req.body || {};
    if (typeof body.cacheDir === 'string' && body.cacheDir.trim()) {
      storage.setCacheDir(body.cacheDir);
    }
    if (body.persistenceMode === 'memory' || body.persistenceMode === 'disk') {
      storage.setMode(body.persistenceMode);
    }
    await geoip.updateConfig({
      enabled: typeof body.geoipEnabled === 'boolean' ? body.geoipEnabled : undefined,
      geoipDir: typeof body.geoipDir === 'string' ? body.geoipDir : undefined,
    });
    const updatedRdns = rdnsCache.updateConfig({
      enabled: typeof body.rdnsEnabled === 'boolean' ? body.rdnsEnabled : undefined,
      ttlSec: typeof body.rdnsTtlSec === 'number' ? body.rdnsTtlSec : undefined,
      skipPrivate: typeof body.rdnsSkipPrivate === 'boolean' ? body.rdnsSkipPrivate : undefined,
    });
    const updatedLanDns = lanResolver.updateConfig({
      enabled: typeof body.lanDnsEnabled === 'boolean' ? body.lanDnsEnabled : undefined,
      server: typeof body.lanDnsServer === 'string' ? body.lanDnsServer : undefined,
      ttlSec: typeof body.lanDnsTtlSec === 'number' ? body.lanDnsTtlSec : undefined,
      stripDomain: typeof body.stripLanDomain === 'boolean' ? body.stripLanDomain : undefined,
    });
    engine.updateServerConfig({
      persistenceMode: storage.getMode(),
      cacheDir: storage.getConfiguredCacheDir(),
      rdnsEnabled: updatedRdns.enabled,
      rdnsTtlSec: updatedRdns.ttlSec,
      rdnsSkipPrivate: updatedRdns.skipPrivate,
      lanDnsEnabled: updatedLanDns.enabled,
      lanDnsServer: updatedLanDns.server,
      lanDnsTtlSec: updatedLanDns.ttlSec,
      stripLanDomain: updatedLanDns.stripDomain,
      geoipEnabled: geoip.isEnabled(),
      geoipDir: geoip.getConfiguredDir(),
    });
    syncStatsAndPersist();
    persistUserConfig();
    storage.saveState(engine.getExportableState(), true);
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ serverConfig: snap.serverConfig, serverStats: snap.serverStats });
  });

  app.post('/api/geoip/reload', async (_req, res) => {
    await geoip.reload();
    syncStatsAndPersist();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, serverStats: snap.serverStats });
  });

  app.post(
    '/api/geoip/upload',
    express.raw({ type: 'application/octet-stream', limit: '120mb' }),
    async (req, res) => {
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await geoip.saveUploadedDb(filename, buf);
      if (!result.ok) {
        res.status(400).json({ ok: false, error: result.error });
        return;
      }
      syncStatsAndPersist();
      const snap = engine.getSnapshot();
      broadcastDashboard({ type: 'traffic:tick', data: snap });
      res.json({
        ok: true,
        savedFile: result.savedFile,
        serverStats: snap.serverStats,
      });
    }
  );

  app.post('/api/rdns/clear', (_req, res) => {
    rdnsCache.clear();
    syncStatsAndPersist();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, serverStats: snap.serverStats });
  });

  app.post('/api/lan-dns/clear', (_req, res) => {
    lanResolver.clear();
    syncStatsAndPersist();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, serverStats: snap.serverStats });
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

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server },
        ws: { server },
        watch: hmrDisabled ? null : {},
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OrbiFlow Network Monitor listening on http://0.0.0.0:${PORT}`);
  });

  process.on('SIGTERM', () => {
    clearInterval(simTimer);
    persistUserConfig();
    storage.saveState(engine.getExportableState(), true);
    server.close();
  });
}

startServer().catch((err) => {
  console.error('Failed to start OrbiFlow server:', err);
  process.exit(1);
});
