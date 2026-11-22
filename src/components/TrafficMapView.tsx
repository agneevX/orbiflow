import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cable,
  Crosshair,
  ExternalLink,
  Globe,
  Minus,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Server,
  SlidersHorizontal,
  Wifi,
  X,
} from 'lucide-react';
import type {
  BandwidthUnit,
  DashboardSnapshot,
  EthernetPortMetrics,
  HostSummary,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  buildTopologyGraph,
  formatLinkSpeed,
  type TopologyDeviceIcon,
  type TopologyEdge,
  type TopologyNode,
} from '../lib/topology';
import { formatBandwidth, formatBytes, formatDuration } from '../lib/formatters';
import { SatelliteManager, type SatelliteSavePayload } from './SatelliteManager';

interface TrafficMapViewProps {
  snapshot: DashboardSnapshot;
  unit: BandwidthUnit;
  theme: ThemePalette;
  paused: boolean;
  connectionsEnabled?: boolean;
  onInspectHostFlows: (host: HostSummary) => void;
  onSaveSatellite: (payload: SatelliteSavePayload) => Promise<{ ok: boolean; error?: string }>;
  onDeleteSatellite: (id: string) => Promise<void>;
  onTestSatellite: (
    payload: SatelliteSavePayload
  ) => Promise<{ ok: boolean; error?: string; summary?: string }>;
}

interface Particle {
  edgeIdx: number;
  t: number;
  speed: number;
  direction: 1 | -1; // 1 = download (left->right), -1 = upload (right->left)
  offsetY: number;
  radius: number;
  alpha: number;
  fixedWired?: boolean;
}

function isWiredClientEdge(edge: TopologyEdge): boolean {
  return edge.targetId.startsWith('client:') && edge.connectionType === 'ethernet';
}

function cubicBezierPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number
): { x: number; y: number } {
  const mx = (x1 + x2) / 2;
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  const x = uuu * x1 + 3 * uu * t * mx + 3 * u * tt * mx + ttt * x2;
  const y = uuu * y1 + 3 * uu * t * y1 + 3 * u * tt * y2 + ttt * y2;
  return { x, y };
}

function buildEdgePath(e: TopologyEdge): string {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}

function HardwareGlyph({
  icon,
  isDark,
  connected,
}: {
  icon: TopologyDeviceIcon;
  isDark: boolean;
  connected: boolean;
}) {
  const bodyFill = isDark ? '#334155' : '#e2e8f0';
  const bodyStroke = isDark ? '#64748b' : '#94a3b8';
  const screenFill = isDark ? '#0f172a' : '#1e293b';

  if (icon === 'internet') {
    return (
      <svg viewBox="0 0 48 48" className="w-11 h-11" aria-hidden="true">
        <defs>
          <linearGradient id="ispGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="20" fill="url(#ispGrad)" opacity={isDark ? 0.22 : 0.14} />
        <circle cx="24" cy="24" r="14" fill="none" stroke="url(#ispGrad)" strokeWidth="2.2" />
        <ellipse cx="24" cy="24" rx="6.5" ry="14" fill="none" stroke="url(#ispGrad)" strokeWidth="1.6" />
        <line x1="10" y1="24" x2="38" y2="24" stroke="url(#ispGrad)" strokeWidth="1.6" />
        <path d="M 13 17 Q 24 20 35 17" fill="none" stroke="url(#ispGrad)" strokeWidth="1.4" />
        <path d="M 13 31 Q 24 28 35 31" fill="none" stroke="url(#ispGrad)" strokeWidth="1.4" />
      </svg>
    );
  }

  if (icon === 'router') {
    return (
      <svg viewBox="0 0 84 40" className="w-[78px] h-10" aria-hidden="true">
        <defs>
          <linearGradient id="routerChassis" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isDark ? '#475569' : '#f8fafc'} />
            <stop offset="100%" stopColor={isDark ? '#1e293b' : '#cbd5e1'} />
          </linearGradient>
        </defs>
        <rect
          x="3"
          y="10"
          width="78"
          height="20"
          rx="4"
          fill="url(#routerChassis)"
          stroke={bodyStroke}
          strokeWidth="1.2"
        />
        {/* Status LED */}
        <circle
          cx="12"
          cy="20"
          r="2.4"
          fill={connected ? '#0ea5e9' : '#f59e0b'}
        />
        {/* Ethernet port bays */}
        {[34, 42, 50, 58, 66].map((px) => (
          <rect
            key={px}
            x={px}
            y="16"
            width="5"
            height="8"
            rx="1"
            fill={screenFill}
            opacity="0.85"
          />
        ))}
        <rect x="20" y="18" width="9" height="4" rx="1.5" fill={bodyStroke} opacity="0.6" />
      </svg>
    );
  }

  if (icon === 'satellite') {
    return (
      <svg viewBox="0 0 56 56" className="w-12 h-12" aria-hidden="true">
        <defs>
          <radialGradient id="satDisc" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor={isDark ? '#64748b' : '#ffffff'} />
            <stop offset="100%" stopColor={isDark ? '#1e293b' : '#cbd5e1'} />
          </radialGradient>
        </defs>
        <circle
          cx="28"
          cy="28"
          r="21"
          fill="url(#satDisc)"
          stroke={bodyStroke}
          strokeWidth="1.2"
        />
        <circle
          cx="28"
          cy="28"
          r="9"
          fill="none"
          stroke={connected ? '#38bdf8' : '#f59e0b'}
          strokeWidth="2.2"
          opacity="0.9"
        />
        <circle cx="28" cy="28" r="3" fill={connected ? '#38bdf8' : '#f59e0b'} opacity="0.35" />
      </svg>
    );
  }

  if (icon === 'tv') {
    return (
      <svg viewBox="0 0 48 40" className="w-10 h-9" aria-hidden="true">
        <rect
          x="8"
          y="9"
          width="32"
          height="22"
          rx="6"
          fill={screenFill}
          stroke={bodyStroke}
          strokeWidth="1.2"
        />
        <rect x="13" y="14" width="22" height="12" rx="3" fill="#334155" opacity="0.5" />
        <circle cx="35" cy="27" r="1.4" fill="#e2e8f0" />
      </svg>
    );
  }

  if (icon === 'phone') {
    return (
      <svg viewBox="0 0 40 48" className="w-9 h-10" aria-hidden="true">
        <rect
          x="10"
          y="4"
          width="20"
          height="40"
          rx="4.5"
          fill={screenFill}
          stroke={bodyStroke}
          strokeWidth="1.3"
        />
        <rect x="12.5" y="8" width="15" height="31" rx="2" fill="#0ea5e9" opacity="0.22" />
        <rect x="17" y="6" width="6" height="1.5" rx="0.75" fill="#64748b" />
      </svg>
    );
  }

  if (icon === 'laptop') {
    return (
      <svg viewBox="0 0 54 40" className="w-11 h-9" aria-hidden="true">
        <rect
          x="10"
          y="6"
          width="34"
          height="23"
          rx="2.5"
          fill={screenFill}
          stroke={bodyStroke}
          strokeWidth="1.2"
        />
        <rect
          x="13"
          y="9"
          width="28"
          height="17"
          rx="1"
          fill="url(#ispGrad)"
          opacity="0.35"
        />
        <path d="M 4 30 L 50 30 L 47 34 L 7 34 Z" fill={bodyFill} stroke={bodyStroke} strokeWidth="1" />
      </svg>
    );
  }

  if (icon === 'nas' || icon === 'server') {
    return (
      <svg viewBox="0 0 48 44" className="w-10 h-9" aria-hidden="true">
        <rect
          x="8"
          y="6"
          width="32"
          height="32"
          rx="4"
          fill={bodyFill}
          stroke={bodyStroke}
          strokeWidth="1.2"
        />
        {[12, 20, 28].map((py) => (
          <g key={py}>
            <rect x="12" y={py} width="24" height="5" rx="1.2" fill={screenFill} opacity="0.85" />
            <circle cx="32" cy={py + 2.5} r="1.1" fill="#34d399" />
          </g>
        ))}
      </svg>
    );
  }

  if (icon === 'gaming') {
    return (
      <svg viewBox="0 0 44 48" className="w-9 h-10" aria-hidden="true">
        <rect
          x="10"
          y="5"
          width="24"
          height="38"
          rx="3.5"
          fill={screenFill}
          stroke={bodyStroke}
          strokeWidth="1.3"
        />
        <line x1="15" y1="10" x2="15" y2="38" stroke="#38bdf8" strokeWidth="1.6" opacity="0.7" />
        <circle cx="24" cy="18" r="4.5" fill="none" stroke="#8b5cf6" strokeWidth="1.4" opacity="0.8" />
        <circle cx="24" cy="30" r="4.5" fill="none" stroke="#38bdf8" strokeWidth="1.4" opacity="0.8" />
      </svg>
    );
  }

  if (icon === 'iot') {
    return (
      <svg viewBox="0 0 44 44" className="w-9 h-9" aria-hidden="true">
        <rect
          x="10"
          y="7"
          width="24"
          height="30"
          rx="8"
          fill={bodyFill}
          stroke={bodyStroke}
          strokeWidth="1.3"
        />
        <circle cx="22" cy="18" r="5" fill={screenFill} />
        <circle cx="22" cy="18" r="2" fill="#38bdf8" opacity="0.8" />
        <circle cx="22" cy="30" r="1.6" fill="#64748b" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 44 44" className="w-9 h-9" aria-hidden="true">
      <rect
        x="9"
        y="9"
        width="26"
        height="26"
        rx="6"
        fill={bodyFill}
        stroke={bodyStroke}
        strokeWidth="1.3"
      />
      <circle cx="22" cy="22" r="5" fill={screenFill} opacity="0.75" />
    </svg>
  );
}

function PortNegotiationTable({
  ports,
  unit,
  theme,
}: {
  ports: EthernetPortMetrics[];
  unit: BandwidthUnit;
  theme: ThemePalette;
}) {
  if (!ports || ports.length === 0) {
    return (
      <div className="p-3 rounded-xl border app-border app-input text-xs app-text-muted">
        No Ethernet port telemetry reported yet. Update the router agent or configure SSH polling to
        read physical switch negotiation rates.
      </div>
    );
  }

  return (
    <div className="border app-border rounded-xl overflow-hidden">
      <table className="w-full text-[11px]">
        <thead className="app-sidebar border-b app-border text-[10px] app-text-muted">
          <tr>
            <th className="text-left font-medium px-2.5 py-2">Port</th>
            <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Link Rate</th>
            <th className="text-right font-medium px-2.5 py-2 whitespace-nowrap">Rx / Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y app-border font-mono tabular-nums">
          {ports.map((p) => {
            const speedText = formatLinkSpeed(p.speedMbps, p.role === 'wifi' ? 'wifi' : 'ethernet', p.linkUp);
            return (
              <tr key={p.id} className="app-input">
                <td className="px-2.5 py-2 font-sans min-w-0">
                  <div className="font-medium truncate max-w-[125px]" title={p.label}>
                    {p.label}
                  </div>
                  <div className="text-[10px] app-text-muted uppercase">{p.role}</div>
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <span
                    className={
                      !p.linkUp
                        ? 'app-text-muted opacity-60'
                        : p.speedMbps >= 2500
                          ? 'text-violet-500 font-semibold'
                          : p.speedMbps >= 1000
                            ? 'text-emerald-500 font-semibold'
                            : 'text-amber-500 font-semibold'
                    }
                  >
                    {speedText}
                  </span>
                  {p.linkUp && p.duplex && p.duplex !== 'unknown' && (
                    <span className="text-[10px] app-text-muted ml-1">
                      {p.duplex === 'full' ? 'FDX' : 'HDX'}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2 text-right whitespace-nowrap">
                  <div style={{ color: theme.rxColor }}>↓ {formatBandwidth(p.rxBps, unit)}</div>
                  <div style={{ color: theme.txColor }}>↑ {formatBandwidth(p.txBps, unit)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrafficMapView({
  snapshot,
  unit,
  theme,
  paused,
  connectionsEnabled = true,
  onInspectHostFlows,
  onSaveSatellite,
  onDeleteSatellite,
  onTestSatellite,
}: TrafficMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [showPortSpeeds, setShowPortSpeeds] = useState(true);
  const [showIdleClients, setShowIdleClients] = useState(true);
  const [animateFlow, setAnimateFlow] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [satelliteModalOpen, setSatelliteModalOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Pan & zoom transform state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 12 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const hasAutoFitRef = useRef(false);

  const graph = useMemo(
    () =>
      buildTopologyGraph(snapshot, {
        collapsedIds,
        showIdleClients,
        searchQuery,
      }),
    [snapshot, collapsedIds, showIdleClients, searchQuery]
  );

  const selectedNode: TopologyNode | null = useMemo(
    () => (selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) || null : null),
    [graph.nodes, selectedNodeId]
  );

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;
    const padX = 56;
    const padTop = 64;
    const padBottom = 48;
    const scaleX = (rect.width - padX) / graph.width;
    const scaleY = (rect.height - padTop - padBottom) / graph.height;
    const nextZoom = Math.max(0.55, Math.min(1.12, Math.min(scaleX, scaleY)));
    const nextPanX = Math.round((rect.width - graph.width * nextZoom) / 2);
    const nextPanY = Math.round(
      padTop + (rect.height - padTop - padBottom - graph.height * nextZoom) / 2
    );
    setZoom(Number(nextZoom.toFixed(3)));
    setPan({ x: nextPanX, y: Math.max(36, nextPanY) });
  }, [graph.width, graph.height]);

  useEffect(() => {
    if (!hasAutoFitRef.current && graph.nodes.length > 0) {
      hasAutoFitRef.current = true;
      fitToView();
    }
  }, [fitToView, graph.nodes.length]);

  useEffect(() => {
    if (!displayMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (displayMenuRef.current && !displayMenuRef.current.contains(e.target as Node)) {
        setDisplayMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [displayMenuOpen]);

  // Keep latest edges & animation settings in refs so rAF loop never tears down on 3s ticks
  const edgesRef = useRef<TopologyEdge[]>(graph.edges);
  const graphSizeRef = useRef({ width: graph.width, height: graph.height });
  const isDarkRef = useRef(theme.isDark);
  const animateRef = useRef(animateFlow && !paused);

  edgesRef.current = graph.edges;
  graphSizeRef.current = { width: graph.width, height: graph.height };
  isDarkRef.current = theme.isDark;
  animateRef.current = animateFlow && !paused;

  // UniFi-style glowing flowing dot-particle ribbon renderer on HTML5 Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let particles: Particle[] = [];
    let lastEdgeSignature = '';

    const rebuildParticles = (edges: TopologyEdge[]) => {
      const next: Particle[] = [];
      edges.forEach((edge, idx) => {
        // Wired Ethernet clients always show a steady, fixed-pace animation
        if (isWiredClientEdge(edge)) {
          const fixedCount = 8;
          for (let i = 0; i < fixedCount; i++) {
            next.push({
              edgeIdx: idx,
              t: i / fixedCount,
              speed: 0.0026,
              direction: 1,
              offsetY: 0,
              radius: 1.5,
              alpha: 0.72,
              fixedWired: true,
            });
          }
          return;
        }

        if (!edge.active) return;
        // Scale particle density logarithmically with live throughput
        const rxScore = edge.rxBps > 0 ? Math.min(1, Math.log10(edge.rxBps + 10) / 7.2) : 0;
        const txScore = edge.txBps > 0 ? Math.min(1, Math.log10(edge.txBps + 10) / 7.2) : 0;

        const rxCount = edge.rxBps > 0 ? Math.max(10, Math.round(14 + rxScore * 38)) : 0;
        const txCount = edge.txBps > 0 ? Math.max(6, Math.round(8 + txScore * 24)) : 0;
        const spread = 3 + Math.max(rxScore, txScore) * 5.5;

        for (let i = 0; i < rxCount; i++) {
          const seed = (idx * 97 + i * 31) % 1000;
          next.push({
            edgeIdx: idx,
            t: (i / rxCount + (seed % 17) * 0.004) % 1,
            speed: 0.0022 + rxScore * 0.0042 + ((seed % 11) * 0.00018),
            direction: 1,
            offsetY: (((seed % 200) / 100) - 1) * spread,
            radius: 1.15 + ((seed % 5) * 0.25),
            alpha: 0.45 + ((seed % 55) / 100),
          });
        }
        for (let i = 0; i < txCount; i++) {
          const seed = (idx * 131 + i * 43 + 7) % 1000;
          next.push({
            edgeIdx: idx,
            t: (i / txCount + (seed % 19) * 0.004) % 1,
            speed: 0.0018 + txScore * 0.0036 + ((seed % 9) * 0.00016),
            direction: -1,
            offsetY: (((seed % 200) / 100) - 1) * (spread * 0.85),
            radius: 1.1 + ((seed % 4) * 0.24),
            alpha: 0.4 + ((seed % 50) / 100),
          });
        }
      });
      particles = next;
    };

    let rafId = 0;
    let lastDraw = 0;

    const renderFrame = (ts: number) => {
      const { width, height } = graphSizeRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const edges = edgesRef.current;
      const sig = edges
        .map(
          (e) =>
            `${e.id}:${e.connectionType || ''}:${e.active ? 1 : 0}:${Math.round(Math.log10(e.rxBps + 10) * 4)}:${Math.round(Math.log10(e.txBps + 10) * 4)}`
        )
        .join('|');
      if (sig !== lastEdgeSignature) {
        lastEdgeSignature = sig;
        rebuildParticles(edges);
      }

      const dt = lastDraw > 0 ? Math.min(48, ts - lastDraw) / 16.67 : 1;
      lastDraw = ts;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const dark = isDarkRef.current;
      const shouldMove = animateRef.current && !prefersReduced;

      // Soft luminous ribbon glow under active splines and wired Ethernet links
      for (const e of edges) {
        const wiredClient = isWiredClientEdge(e);
        if (!e.active && !wiredClient) continue;
        const mx = (e.x1 + e.x2) / 2;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.bezierCurveTo(mx, e.y1, mx, e.y2, e.x2, e.y2);
        if (wiredClient) {
          ctx.strokeStyle = dark ? 'rgba(56, 189, 248, 0.10)' : 'rgba(14, 165, 233, 0.11)';
          ctx.lineWidth = 6;
        } else {
          ctx.strokeStyle = dark ? 'rgba(56, 189, 248, 0.14)' : 'rgba(56, 189, 248, 0.16)';
          ctx.lineWidth = 10;
        }
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Draw UniFi-style shimmering flow particles (and fixed steady particles on wired clients)
      for (const p of particles) {
        const edge = edges[p.edgeIdx];
        if (!edge) continue;
        if (shouldMove) {
          p.t += p.speed * p.direction * dt;
          if (p.t > 1) p.t -= 1;
          if (p.t < 0) p.t += 1;
        }
        const pt = cubicBezierPoint(edge.x1, edge.y1, edge.x2, edge.y2, p.t);
        // Taper ribbon slightly near node endpoints for crisp entry/exit
        const taper = Math.sin(p.t * Math.PI);
        const py = pt.y + p.offsetY * (0.35 + 0.65 * taper);

        ctx.beginPath();
        ctx.arc(pt.x, py, p.radius, 0, Math.PI * 2);
        if (p.fixedWired) {
          ctx.fillStyle = dark
            ? `rgba(56, 189, 248, ${p.alpha})`
            : `rgba(14, 165, 233, ${p.alpha})`;
        } else if (p.direction === 1) {
          ctx.fillStyle = dark
            ? `rgba(56, 189, 248, ${p.alpha})`
            : `rgba(14, 165, 233, ${p.alpha * 0.9})`;
        } else {
          ctx.fillStyle = dark
            ? `rgba(167, 139, 250, ${p.alpha})`
            : `rgba(139, 92, 246, ${p.alpha * 0.85})`;
        }
        ctx.fill();
      }

      ctx.restore();
      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const toggleCollapse = (parentId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.09 : 0.92;
    setZoom((z) => Number(Math.max(0.45, Math.min(2.0, z * factor)).toFixed(3)));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    setDragging(true);
    dragOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragOrigin.current.x;
    const dy = e.clientY - dragOrigin.current.y;
    setPan({ x: dragOrigin.current.panX + dx, y: dragOrigin.current.panY + dy });
  };

  const handleMouseUp = () => setDragging(false);

  const satCount = snapshot.topology?.satellites?.length || 0;
  const activeClientCount = graph.nodes.filter((n) => n.kind === 'client' && n.active).length;

  return (
    <div className="space-y-4">
      <section
        ref={containerRef}
        data-testid="traffic-map-viewport"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className={`relative w-full min-h-[600px] h-[calc(100vh-10.5rem)] rounded-2xl border app-border overflow-clip select-none ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundColor: theme.isDark ? 'var(--bg-surface)' : '#ffffff',
          backgroundImage: theme.isDark
            ? 'radial-gradient(rgba(148, 163, 184, 0.14) 1px, transparent 1px)'
            : 'radial-gradient(rgba(148, 163, 184, 0.22) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        {/* Top-Left Floating UniFi-Style Control Bar */}
        <div
          ref={displayMenuRef}
          className="absolute top-4 left-4 z-20 flex items-center gap-2"
        >
          <div className="flex items-center app-topbar border rounded-xl p-1 shadow-sm">
            <button
              type="button"
              data-testid="map-display-options-btn"
              onClick={() => setDisplayMenuOpen((v) => !v)}
              aria-expanded={displayMenuOpen}
              aria-label="Traffic map display options"
              title="Display options"
              className={`inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
                displayMenuOpen ? 'bg-sky-500/15 text-sky-500' : 'app-text-secondary app-row-hover'
              }`}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="map-animate-toggle-btn"
              onClick={() => setAnimateFlow((v) => !v)}
              aria-label={animateFlow ? 'Pause flow particles' : 'Play flow particles'}
              title={animateFlow ? 'Pause flow animation' : 'Play flow animation'}
              className={`inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
                animateFlow ? 'text-sky-500 app-row-hover' : 'app-text-muted app-row-hover'
              }`}
            >
              {animateFlow ? (
                <Pause className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>

          <button
            type="button"
            data-testid="manage-satellites-btn"
            onClick={() => setSatelliteModalOpen(true)}
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-xl app-topbar border text-xs font-medium app-text-secondary app-row-hover shadow-sm transition-colors whitespace-nowrap"
          >
            <Radio className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
            <span>Satellites ({satCount})</span>
          </button>

          {displayMenuOpen && (
            <div
              data-testid="map-display-popover"
              className="absolute top-12 left-0 w-64 p-3.5 rounded-2xl border app-border app-surface shadow-xl space-y-3"
            >
              <div className="relative">
                <Search
                  className="h-3.5 w-3.5 app-text-muted absolute left-2.5 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Find device or satellite..."
                  aria-label="Filter traffic map devices"
                  className="w-full app-input border rounded-lg pl-8 pr-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showPortSpeeds}
                    onChange={(e) => setShowPortSpeeds(e.target.checked)}
                    className="rounded text-sky-500 focus:ring-sky-500"
                  />
                  <span>Show Ethernet &amp; Wi-Fi link rates</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showIdleClients}
                    onChange={(e) => setShowIdleClients(e.target.checked)}
                    className="rounded text-sky-500 focus:ring-sky-500"
                  />
                  <span>Show idle devices</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={animateFlow}
                    onChange={(e) => setAnimateFlow(e.target.checked)}
                    className="rounded text-sky-500 focus:ring-sky-500"
                  />
                  <span>Animate live traffic streams</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Bottom-Right Compact Legend (keeps top canvas uncluttered) */}
        <div className="absolute bottom-4 right-4 z-10 hidden md:flex items-center gap-3 px-3.5 py-2 rounded-xl app-topbar border text-[11px] font-mono tabular-nums shadow-sm">
          <span className="text-sky-500 font-medium">↓ Download</span>
          <span aria-hidden="true" className="app-text-muted">
            ·
          </span>
          <span className="text-violet-500 font-medium">↑ Upload</span>
          <span aria-hidden="true" className="app-text-muted">
            ·
          </span>
          <span className="app-text-muted">
            {satCount} satellites · {activeClientCount} active
          </span>
        </div>

        {/* Bottom-Left Floating Zoom & Fit Controls (matching UniFi layout) */}
        <div className="absolute bottom-4 left-4 z-20 flex flex-col app-topbar border rounded-xl p-1 shadow-sm">
          <button
            type="button"
            data-testid="map-fit-btn"
            onClick={fitToView}
            aria-label="Center and fit traffic map"
            title="Fit to screen"
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg app-text-secondary app-row-hover transition-colors"
          >
            <Crosshair className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="h-px app-border bg-current opacity-15 my-0.5" />
          <button
            type="button"
            data-testid="map-zoom-in-btn"
            onClick={() => setZoom((z) => Number(Math.min(2, z * 1.15).toFixed(3)))}
            aria-label="Zoom in"
            title="Zoom in"
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg app-text-secondary app-row-hover transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="map-zoom-out-btn"
            onClick={() => setZoom((z) => Number(Math.max(0.45, z * 0.87).toFixed(3)))}
            aria-label="Zoom out"
            title="Zoom out"
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg app-text-secondary app-row-hover transition-colors"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Transformed World Layer: SVG Curves + Canvas Particles + Interactive Nodes */}
        <div
          className="origin-top-left will-change-transform"
          style={{
            width: `${graph.width}px`,
            height: `${graph.height}px`,
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
          }}
        >
          {/* Layer 1: Base Bézier Links & Port Negotiation Rate Labels */}
          <svg
            width={graph.width}
            height={graph.height}
            className="absolute inset-0 pointer-events-none overflow-visible"
            aria-hidden="true"
          >
            {/* Stem connectors from parent hardware icon to its blue collapse junction */}
            {graph.junctions.map((j) => {
              const parent = graph.nodes.find((n) => n.id === j.parentId);
              if (!parent) return null;
              const startX = parent.x + (parent.kind === 'router' ? 44 : 22);
              return (
                <line
                  key={`stem-${j.parentId}`}
                  x1={startX}
                  y1={j.y}
                  x2={j.x}
                  y2={j.y}
                  stroke={
                    parent.active
                      ? theme.isDark
                        ? 'rgba(56, 189, 248, 0.42)'
                        : 'rgba(56, 189, 248, 0.40)'
                      : theme.isDark
                        ? 'rgba(148, 163, 184, 0.28)'
                        : 'rgba(148, 163, 184, 0.36)'
                  }
                  strokeWidth={parent.active ? 2.5 : 1.5}
                />
              );
            })}

            {graph.edges.map((edge) => {
              const pathD = buildEdgePath(edge);
              const mid = cubicBezierPoint(edge.x1, edge.y1, edge.x2, edge.y2, 0.5);
              const wiredClient = isWiredClientEdge(edge);
              const isSolid = edge.active || wiredClient;
              return (
                <g key={edge.id}>
                  <path
                    d={pathD}
                    fill="none"
                    stroke={
                      isSolid
                        ? theme.isDark
                          ? 'rgba(56, 189, 248, 0.30)'
                          : 'rgba(56, 189, 248, 0.28)'
                        : theme.isDark
                          ? 'rgba(148, 163, 184, 0.22)'
                          : 'rgba(148, 163, 184, 0.34)'
                    }
                    strokeWidth={isSolid ? 2 : 1.5}
                    strokeDasharray={isSolid ? undefined : '4 5'}
                  />

                  {showPortSpeeds && edge.linkSpeedLabel && (() => {
                    const isClientEdge = edge.targetId.startsWith('client:');
                    // Keep client edge badges concise: "Wi-Fi" for wireless, "Ethernet" for wired
                    const displayLabel = isClientEdge
                      ? edge.connectionType === 'wifi'
                        ? 'Wi-Fi'
                        : edge.connectionType === 'ethernet'
                          ? 'Ethernet'
                          : edge.linkSpeedLabel
                      : edge.linkSpeedLabel;
                    const labelWidth = Math.max(38, displayLabel.length * 6.4 + 12);
                    return (
                      <g transform={`translate(${mid.x}, ${mid.y - 12})`}>
                        <rect
                          x={-labelWidth / 2}
                          y={-11}
                          width={labelWidth}
                          height={16}
                          rx={5}
                          fill={theme.isDark ? 'rgba(15, 23, 42, 0.85)' : 'rgba(255, 255, 255, 0.90)'}
                          stroke={theme.isDark ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.28)'}
                          strokeWidth="0.75"
                        />
                        <text
                          textAnchor="middle"
                          y={0}
                          className="font-mono"
                          fontSize="10"
                          fontWeight={edge.active ? '600' : '500'}
                          fill={
                            edge.active
                              ? theme.isDark
                                ? '#e2e8f0'
                                : '#334155'
                              : theme.isDark
                                ? '#64748b'
                                : '#94a3b8'
                          }
                        >
                          {displayLabel}
                        </text>
                      </g>
                    );
                  })()}
                </g>
              );
            })}
          </svg>

          {/* Layer 2: Animated UniFi Flowing Particle Streams */}
          <canvas
            ref={canvasRef}
            data-testid="traffic-map-canvas"
            style={{ width: `${graph.width}px`, height: `${graph.height}px` }}
            className="absolute inset-0 pointer-events-none"
          />

          {/* Layer 3A: Blue Circular Collapse/Expand Branch Junctions (rendered above nodes) */}
          {graph.junctions.map((j) => (
            <button
              key={`junc-${j.parentId}`}
              type="button"
              data-testid={`junction-${j.parentId}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(j.parentId);
              }}
              aria-label={
                j.collapsed
                  ? `Expand ${j.hiddenCount} downstream devices`
                  : `Collapse ${j.hiddenCount} downstream devices`
              }
              title={
                j.collapsed
                  ? `Expand ${j.hiddenCount} devices`
                  : `Collapse ${j.hiddenCount} devices`
              }
              style={{
                left: `${j.x}px`,
                top: `${j.y}px`,
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2 z-30 h-5 w-5 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-sm ring-2 ring-white/80 dark:ring-slate-900/80 flex items-center justify-center transition-transform hover:scale-110"
            >
              {j.collapsed ? (
                <Plus className="h-3 w-3 stroke-[2.5]" aria-hidden="true" />
              ) : (
                <Minus className="h-3 w-3 stroke-[2.5]" aria-hidden="true" />
              )}
            </button>
          ))}

          {/* Layer 3B: Crisp Accessible Hardware / Device Nodes (icon center anchored to node.y) */}
          {graph.nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const showRates = node.kind !== 'internet';
            return (
              <button
                key={node.id}
                type="button"
                data-testid={`map-node-${node.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedNodeId((cur) => (cur === node.id ? null : node.id));
                }}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  transform: 'translate(-50%, -30px)',
                }}
                className={`absolute z-20 flex flex-col items-center text-center px-2 py-1.5 rounded-2xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  isSelected
                    ? theme.isDark
                      ? 'bg-sky-500/15 ring-1 ring-sky-400/60'
                      : 'bg-sky-50 ring-1 ring-sky-400/70'
                    : theme.isDark
                      ? 'hover:bg-slate-800/65'
                      : 'hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center justify-center">
                  <HardwareGlyph
                    icon={node.icon}
                    isDark={theme.isDark}
                    connected={node.connected}
                  />
                </div>

                <div
                  className={`mt-1.5 text-xs font-semibold leading-tight max-w-[155px] truncate ${
                    node.active || node.kind === 'internet' || node.kind === 'router'
                      ? theme.isDark
                        ? 'text-sky-400'
                        : 'text-sky-700'
                      : 'app-text-secondary'
                  }`}
                >
                  {node.label}
                </div>

                {showRates ? (
                  <div
                    className={`mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums whitespace-nowrap ${
                      node.active ? '' : 'app-text-muted opacity-65'
                    }`}
                  >
                    <span className={node.active ? 'text-sky-500' : ''}>
                      ↓ {formatBandwidth(node.rxBps, unit)}
                    </span>
                    <span className={node.active ? 'text-violet-500' : ''}>
                      ↑ {formatBandwidth(node.txBps, unit)}
                    </span>
                  </div>
                ) : (
                  <div className="mt-0.5 text-[10px] font-mono app-text-muted tabular-nums whitespace-nowrap">
                    {node.sublabel}
                  </div>
                )}

                {showPortSpeeds && node.kind !== 'internet' && node.linkSpeedLabel && (
                  <div className="mt-0.5 text-[10px] font-mono app-text-muted whitespace-nowrap">
                    {node.kind === 'client'
                      ? node.connectionType === 'wifi'
                        ? node.linkSpeedLabel
                        : 'Ethernet'
                      : `${node.portLabel ? `${node.portLabel} · ` : ''}${node.linkSpeedLabel}`}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Slide-Over Node Inspector Panel (Router / Satellite Ethernet Ports & Client Details) */}
        {selectedNode && (
          <aside
            data-testid="map-node-inspector"
            aria-label={`Details for ${selectedNode.label}`}
            className="absolute top-4 right-4 bottom-4 z-40 w-[376px] max-w-[calc(100%-2rem)] rounded-2xl border app-border app-surface shadow-2xl flex flex-col overflow-hidden"
          >
            <div className="px-4 py-3.5 border-b app-border flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium app-text-muted capitalize">
                  {selectedNode.kind === 'router'
                    ? 'Main Router'
                    : selectedNode.kind === 'satellite'
                      ? 'Orbi Satellite'
                      : selectedNode.kind === 'internet'
                        ? 'Internet Uplink'
                        : 'Connected Device'}
                </div>
                <h3 className="font-display text-sm font-semibold truncate mt-0.5">
                  {selectedNode.label}
                </h3>
                {selectedNode.ip && (
                  <div className="text-[11px] font-mono app-text-muted tabular-nums mt-0.5">
                    {selectedNode.ip}
                    {selectedNode.mac ? ` · ${selectedNode.mac}` : ''}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedNodeId(null)}
                aria-label="Close node inspector"
                className="p-1.5 rounded-lg app-text-muted app-row-hover"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Live Rx / Tx Summary */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="p-3 rounded-xl border app-border app-input">
                  <div className="text-[11px] app-text-muted">Download (Rx)</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-sky-500">
                    ↓ {formatBandwidth(selectedNode.rxBps, unit)}
                  </div>
                </div>
                <div className="p-3 rounded-xl border app-border app-input">
                  <div className="text-[11px] app-text-muted">Upload (Tx)</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-violet-500">
                    ↑ {formatBandwidth(selectedNode.txBps, unit)}
                  </div>
                </div>
              </div>

              {/* Link Metadata */}
              {selectedNode.linkSpeedLabel && (
                <div className="p-3 rounded-xl border app-border app-input space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 app-text-muted">
                      {selectedNode.connectionType === 'wifi' ? (
                        <Wifi className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                      ) : (
                        <Cable className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                      )}
                      <span>
                        {selectedNode.kind === 'satellite'
                          ? selectedNode.connectionType === 'wifi'
                            ? 'Wi-Fi Backhaul'
                            : 'Ethernet Backhaul'
                          : selectedNode.kind === 'router'
                            ? 'WAN Negotiation'
                            : selectedNode.kind === 'internet'
                              ? 'WAN Link'
                              : selectedNode.connectionType === 'wifi'
                                ? 'Wi-Fi RX / TX'
                                : 'Connection'}
                      </span>
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {selectedNode.kind === 'client' && selectedNode.connectionType === 'ethernet'
                        ? 'Ethernet'
                        : selectedNode.linkSpeedLabel}
                    </span>
                  </div>
                  {selectedNode.kind === 'client' &&
                    selectedNode.connectionType === 'wifi' &&
                    (selectedNode.portLabel || selectedNode.wifiSignalDbm !== undefined) && (
                      <div className="flex items-center justify-between text-[11px] app-text-muted font-mono tabular-nums">
                        <span>{selectedNode.portLabel || 'Wireless'}</span>
                        {selectedNode.wifiSignalDbm !== undefined && (
                          <span>Signal {selectedNode.wifiSignalDbm} dBm</span>
                        )}
                      </div>
                    )}
                </div>
              )}

              {/* Router WAN Details for Internet Node */}
              {selectedNode.kind === 'internet' && (
                <div data-testid="internet-wan-details" className="space-y-2">
                  <h4 className="text-xs font-semibold flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                    <span>Router WAN Details</span>
                  </h4>
                  {selectedNode.wan ? (
                    <div className="p-3 rounded-xl border app-border app-input space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">WAN IP</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {selectedNode.wan.ip || 'Unavailable'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">Default Gateway</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {selectedNode.wan.gateway || 'Unavailable'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">DNS Servers</span>
                        <span className="font-mono app-text-secondary tabular-nums text-right truncate max-w-[200px]">
                          {selectedNode.wan.dns.length > 0
                            ? selectedNode.wan.dns.join(', ')
                            : 'Unavailable'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">Interface</span>
                        <span className="font-mono app-text-secondary">
                          {selectedNode.wan.iface}
                          {selectedNode.wan.state ? ` (${selectedNode.wan.state})` : ''}
                        </span>
                      </div>
                      {selectedNode.wan.linkSpeedMbps > 0 && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="app-text-muted">Link Rate</span>
                          <span className="font-mono app-text-secondary tabular-nums">
                            {formatLinkSpeed(
                              selectedNode.wan.linkSpeedMbps,
                              'ethernet',
                              selectedNode.wan.state !== 'down'
                            )}
                            {selectedNode.wan.duplex && selectedNode.wan.duplex !== 'unknown'
                              ? ` ${selectedNode.wan.duplex === 'full' ? 'FDX' : 'HDX'}`
                              : ''}
                          </span>
                        </div>
                      )}
                      {selectedNode.wan.mtu && selectedNode.wan.mtu > 0 && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="app-text-muted">MTU</span>
                          <span className="font-mono app-text-secondary tabular-nums">
                            {selectedNode.wan.mtu}
                          </span>
                        </div>
                      )}
                      {selectedNode.wan.connectionType && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="app-text-muted">Connection Type</span>
                          <span className="font-mono app-text-secondary">
                            {selectedNode.wan.connectionType}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1.5 border-t app-border">
                        <span className="app-text-muted">Configured Plan</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {snapshot.serverConfig.ispMaxDownMbps} /{' '}
                          {snapshot.serverConfig.ispMaxUpMbps} Mbps
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl border app-border app-input space-y-2 text-xs">
                      <p className="app-text-muted">
                        WAN interface details have not been reported by the router agent yet. Update
                        your router agent script to stream WAN IP, gateway, and DNS telemetry.
                      </p>
                      <div className="flex items-center justify-between gap-2 pt-1.5 border-t app-border">
                        <span className="app-text-muted">Configured Plan</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {snapshot.serverConfig.ispMaxDownMbps} /{' '}
                          {snapshot.serverConfig.ispMaxUpMbps} Mbps
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Satellite metadata */}
              {selectedNode.satellite && (
                <div className="space-y-1.5 text-xs app-text-muted">
                  <div className="flex items-center justify-between">
                    <span>Backhaul Mode</span>
                    <span className="font-mono app-text-secondary">
                      {selectedNode.satellite.backhaulType === 'wifi' ? 'Wi-Fi' : 'Ethernet'}
                      {selectedNode.satellite.backhaulIface
                        ? ` (${selectedNode.satellite.backhaulIface})`
                        : ''}
                    </span>
                  </div>
                  {selectedNode.satellite.backhaulStatus && (
                    <div className="flex items-center justify-between">
                      <span>Backhaul Status</span>
                      <span className="font-mono app-text-secondary">
                        {selectedNode.satellite.backhaulStatus}
                      </span>
                    </div>
                  )}
                  {selectedNode.satellite.backhaulSignalDbm !== undefined && (
                    <div className="flex items-center justify-between">
                      <span>Backhaul Signal</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {selectedNode.satellite.backhaulSignalDbm} dBm
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Telemetry Source</span>
                    <span className="font-mono app-text-secondary">
                      {selectedNode.satellite.source === 'ssh'
                        ? 'Stateless SSH'
                        : selectedNode.satellite.source === 'router'
                          ? 'Router (/usr/sbin/satelliteinfo)'
                          : 'Dev Simulator'}
                    </span>
                  </div>
                  {selectedNode.satellite.uptimeSec > 0 && (
                    <div className="flex items-center justify-between">
                      <span>Uptime</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {formatDuration(selectedNode.satellite.uptimeSec)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Total Transferred</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {formatBytes(
                        selectedNode.satellite.rxBytes + selectedNode.satellite.txBytes
                      )}
                    </span>
                  </div>
                  {selectedNode.satellite.lastError && !selectedNode.satellite.connected && (
                    <div className="text-[11px] text-amber-500 pt-1">
                      {selectedNode.satellite.lastError}
                    </div>
                  )}
                </div>
              )}

              {/* Ethernet Ports Table for Main Router and Satellites */}
              {(selectedNode.kind === 'router' || selectedNode.kind === 'satellite') && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                      <span>Ethernet Port Negotiation</span>
                    </h4>
                    <span className="text-[11px] font-mono app-text-muted tabular-nums">
                      {selectedNode.ports?.length || 0} ports
                    </span>
                  </div>
                  <PortNegotiationTable
                    ports={selectedNode.ports || []}
                    unit={unit}
                    theme={theme}
                  />
                </div>
              )}

              {/* Client Details */}
              {selectedNode.host && (
                <div className="space-y-3">
                  <div className="space-y-1.5 text-xs app-text-muted">
                    <div className="flex items-center justify-between gap-2">
                      <span>Vendor</span>
                      <span className="app-text-secondary truncate max-w-[160px]">
                        {selectedNode.host.vendor}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Active Connections</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {selectedNode.host.activeFlows}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Total Data</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {formatBytes(selectedNode.host.totalBytes)}
                      </span>
                    </div>
                    {selectedNode.host.topServices.length > 0 && (
                      <div className="pt-1">
                        <div className="app-text-muted mb-1">Top Services</div>
                        <div className="app-text-secondary leading-snug">
                          {selectedNode.host.topServices.join(', ')}
                        </div>
                      </div>
                    )}
                  </div>

                  {connectionsEnabled && (
                    <button
                      type="button"
                      onClick={() => onInspectHostFlows(selectedNode.host!)}
                      className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl app-btn-primary text-xs font-semibold transition-colors"
                    >
                      <span>Inspect Live Connections</span>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </section>

      {/* SSH Satellite Configuration Modal */}
      {satelliteModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
          onClick={() => setSatelliteModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Orbi Satellites SSH Configuration"
            data-testid="satellite-modal"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border app-border app-surface shadow-2xl"
          >
            <div className="px-5 py-4 border-b app-border flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                  <Radio className="h-4 w-4 text-sky-500" aria-hidden="true" />
                  <span>Orbi Satellites (Stateless SSH)</span>
                </h2>
                <p className="text-xs app-text-muted mt-0.5">
                  Collect Orbi-to-Satellite backhaul traffic, LAN clients, and Ethernet negotiation
                  rates without persistent satellite storage.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSatelliteModalOpen(false)}
                aria-label="Close satellite configuration modal"
                className="p-1.5 rounded-lg app-text-muted app-row-hover"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="p-5">
              <SatelliteManager
                configs={snapshot.topology?.satelliteConfigs || []}
                satellites={snapshot.topology?.satellites || []}
                unit={unit}
                onSaveSatellite={onSaveSatellite}
                onDeleteSatellite={onDeleteSatellite}
                onTestSatellite={onTestSatellite}
                compact
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
