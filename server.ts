import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { TrafficMonitorEngine, exportFlowsToCsv } from './src/lib/telemetryEngine';
import { OrbiProbeSimulator } from './server/simulator';
import { RdnsCache } from './server/rdnsCache';
import { PersistenceStore } from './server/storage';
import type { AlertRule, PersistenceMode, ProbeSnapshot } from './src/types/telemetry';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PROBE_TOKEN = process.env.ORBIFLOW_PROBE_TOKEN || 'orbi-rbk50-voxel-secret';
const SIMULATOR_DEFAULT = process.env.ORBIFLOW_ENABLE_SIMULATOR !== 'false';
const STORAGE_MODE: PersistenceMode =
  process.env.ORBIFLOW_STORAGE_MODE === 'disk' ? 'disk' : 'memory';
const RDNS_ENABLED_DEFAULT = process.env.ORBIFLOW_RDNS_ENABLED === 'true';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const storage = new PersistenceStore(STORAGE_MODE);
  const rdnsCache = new RdnsCache({
    enabled: RDNS_ENABLED_DEFAULT,
    ttlSec: Number(process.env.ORBIFLOW_RDNS_TTL || 3600),
    skipPrivate: true,
  });

  const engine = new TrafficMonitorEngine();
  engine.setSimulatorEnabled(SIMULATOR_DEFAULT);
  engine.updateServerConfig({
    persistenceMode: storage.getMode(),
    ...rdnsCache.getConfig(),
    rdnsEnabled: rdnsCache.getConfig().enabled,
  });

  // Restore saved state if disk persistence is active
  const savedState = storage.loadState();
  if (savedState) {
    engine.hydrateFromStorage(savedState);
    if (savedState.serverConfig) {
      rdnsCache.updateConfig({
        enabled: savedState.serverConfig.rdnsEnabled,
        ttlSec: savedState.serverConfig.rdnsTtlSec,
        skipPrivate: savedState.serverConfig.rdnsSkipPrivate,
      });
    }
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
    const sStats = storage.getStats();
    engine.setServerStats({
      persistedSnapshots: sStats.persistedSnapshots,
      diskLogSizeBytes: sStats.diskLogSizeBytes,
      rdnsCacheSize: rStats.size,
      rdnsHits: rStats.hits,
      rdnsMisses: rStats.misses,
    });
  };

  const handleIngestSnapshot = (snapshot: ProbeSnapshot) => {
    const { dashboard, newAlerts } = engine.ingest(snapshot, (ip) => rdnsCache.lookup(ip));
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
    res.json({
      ok: true,
      probeMode: snap.probe.mode,
      activeFlows: snap.kpis.activeFlows,
      storageMode: storage.getMode(),
      rdnsEnabled: rdnsCache.getConfig().enabled,
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

  app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    if (body.persistenceMode === 'memory' || body.persistenceMode === 'disk') {
      storage.setMode(body.persistenceMode);
    }
    const updatedRdns = rdnsCache.updateConfig({
      enabled: typeof body.rdnsEnabled === 'boolean' ? body.rdnsEnabled : undefined,
      ttlSec: typeof body.rdnsTtlSec === 'number' ? body.rdnsTtlSec : undefined,
      skipPrivate: typeof body.rdnsSkipPrivate === 'boolean' ? body.rdnsSkipPrivate : undefined,
    });
    engine.updateServerConfig({
      persistenceMode: storage.getMode(),
      rdnsEnabled: updatedRdns.enabled,
      rdnsTtlSec: updatedRdns.ttlSec,
      rdnsSkipPrivate: updatedRdns.skipPrivate,
    });
    syncStatsAndPersist();
    storage.saveState(engine.getExportableState(), true);
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ serverConfig: snap.serverConfig, serverStats: snap.serverStats });
  });

  app.post('/api/rdns/clear', (_req, res) => {
    rdnsCache.clear();
    syncStatsAndPersist();
    const snap = engine.getSnapshot();
    broadcastDashboard({ type: 'traffic:tick', data: snap });
    res.json({ ok: true, serverStats: snap.serverStats });
  });

  app.post('/api/rules', (req, res) => {
    const rules = req.body?.rules as AlertRule[] | undefined;
    if (!Array.isArray(rules)) {
      res.status(400).json({ error: 'Invalid rules array' });
      return;
    }
    const updated = engine.updateRules(rules);
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
    storage.saveState(engine.getExportableState(), true);
    server.close();
  });
}

startServer().catch((err) => {
  console.error('Failed to start OrbiFlow server:', err);
  process.exit(1);
});
