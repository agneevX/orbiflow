import { useMemo, useState } from 'react';
import type { BandwidthUnit, ClientDestinationLink } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes } from '../lib/formatters';

interface ClientFlowDiagramProps {
  links: ClientDestinationLink[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  onSelectFilter: (query: string) => void;
}

interface PositionedNode {
  id: string;
  label: string;
  subLabel: string;
  bps: number;
  bytes: number;
  x: number;
  y: number;
  height: number;
  color: string;
}

export function ClientFlowDiagram({
  links,
  unit,
  theme,
  onSelectFilter,
}: ClientFlowDiagramProps) {
  const [hoveredClient, setHoveredClient] = useState<string | null>(null);
  const [hoveredService, setHoveredService] = useState<string | null>(null);
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);

  const layout = useMemo(() => {
    const clientTotals = new Map<string, { name: string; bps: number; bytes: number }>();
    const serviceTotals = new Map<string, { bps: number; bytes: number }>();

    for (const l of links) {
      const c = clientTotals.get(l.clientIp) || { name: l.clientName, bps: 0, bytes: 0 };
      c.bps += l.totalBps;
      c.bytes += l.totalBytes;
      clientTotals.set(l.clientIp, c);

      const s = serviceTotals.get(l.service) || { bps: 0, bytes: 0 };
      s.bps += l.totalBps;
      s.bytes += l.totalBytes;
      serviceTotals.set(l.service, s);
    }

    const topClients = Array.from(clientTotals.entries())
      .sort((a, b) => b[1].bps - a[1].bps || b[1].bytes - a[1].bytes)
      .slice(0, 6);

    const topServices = Array.from(serviceTotals.entries())
      .sort((a, b) => b[1].bps - a[1].bps || b[1].bytes - a[1].bytes)
      .slice(0, 6);

    const clientSet = new Set(topClients.map(([ip]) => ip));
    const serviceSet = new Set(topServices.map(([srv]) => srv));

    const svgWidth = 860;
    const svgHeight = 320;
    const padY = 16;
    const gap = 10;
    const usableH = svgHeight - padY * 2;

    const distributeNodes = <T,>(
      items: Array<[string, T]>,
      getWeight: (v: T) => number,
      getLabel: (k: string, v: T) => { label: string; sub: string; bps: number; bytes: number },
      x: number,
      usePalette: boolean
    ): PositionedNode[] => {
      if (items.length === 0) return [];
      const totalGap = gap * Math.max(0, items.length - 1);
      const avail = Math.max(60, usableH - totalGap);
      const weights = items.map(([, v]) => Math.max(1, getWeight(v)));
      const sumW = weights.reduce((a, b) => a + b, 0);

      let cursorY = padY;
      return items.map(([key, v], idx) => {
        const rawH = (weights[idx] / sumW) * avail;
        const h = Math.max(28, Math.min(80, rawH));
        const info = getLabel(key, v);
        const node: PositionedNode = {
          id: key,
          label: info.label,
          subLabel: info.sub,
          bps: info.bps,
          bytes: info.bytes,
          x,
          y: cursorY,
          height: h,
          color: usePalette
            ? theme.ribbonColors[idx % theme.ribbonColors.length]
            : theme.rxColor,
        };
        cursorY += h + gap;
        return node;
      });
    };

    const clientNodes = distributeNodes(
      topClients,
      (v) => v.bps || v.bytes,
      (ip, v) => ({ label: v.name, sub: ip, bps: v.bps, bytes: v.bytes }),
      14,
      true
    );

    const serviceNodes = distributeNodes(
      topServices,
      (v) => v.bps || v.bytes,
      (srv, v) => ({ label: srv, sub: formatBytes(v.bytes), bps: v.bps, bytes: v.bytes }),
      svgWidth - 194,
      false
    );

    // Center both columns vertically if shorter than svgHeight
    const centerColumn = (nodes: PositionedNode[]) => {
      if (nodes.length === 0) return;
      const last = nodes[nodes.length - 1];
      const totalSpan = last.y + last.height - nodes[0].y;
      const offset = Math.max(0, (svgHeight - totalSpan) / 2 - nodes[0].y);
      for (const n of nodes) n.y += offset;
    };
    centerColumn(clientNodes);
    centerColumn(serviceNodes);

    const clientNodeMap = new Map(clientNodes.map((n) => [n.id, n]));
    const serviceNodeMap = new Map(serviceNodes.map((n) => [n.id, n]));

    const filteredLinks = links.filter(
      (l) => clientSet.has(l.clientIp) && serviceSet.has(l.service)
    );
    const maxLinkWeight = Math.max(
      1,
      ...filteredLinks.map((l) => l.totalBps || l.totalBytes)
    );

    const clientOffsets = new Map<string, number>();
    const serviceOffsets = new Map<string, number>();

    const ribbons = filteredLinks.map((l) => {
      const src = clientNodeMap.get(l.clientIp)!;
      const dst = serviceNodeMap.get(l.service)!;
      const weight = l.totalBps || l.totalBytes;
      const thickness = Math.max(2.5, Math.min(18, (weight / maxLinkWeight) * 16));

      const cOff = clientOffsets.get(src.id) ?? 0;
      const sOff = serviceOffsets.get(dst.id) ?? 0;

      const y1 = Math.min(src.y + src.height - 6, src.y + 8 + cOff);
      const y2 = Math.min(dst.y + dst.height - 6, dst.y + 8 + sOff);

      clientOffsets.set(src.id, (cOff + Math.max(4, thickness * 0.55)) % Math.max(8, src.height - 12));
      serviceOffsets.set(dst.id, (sOff + Math.max(4, thickness * 0.55)) % Math.max(8, dst.height - 12));

      const x1 = src.x + 180;
      const x2 = dst.x;
      const mx = (x1 + x2) / 2;

      return {
        key: `${l.clientIp}=>${l.service}`,
        link: l,
        path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        thickness,
        color: src.color,
      };
    });

    return { svgWidth, svgHeight, clientNodes, serviceNodes, ribbons };
  }, [links, theme]);

  const activeLink = useMemo(() => {
    if (!hoveredLinkKey) return null;
    return layout.ribbons.find((r) => r.key === hoveredLinkKey)?.link || null;
  }, [hoveredLinkKey, layout.ribbons]);

  if (layout.clientNodes.length === 0 || layout.serviceNodes.length === 0) {
    return (
      <div className="py-10 text-center text-xs app-text-muted">
        Waiting for active client-to-destination traffic flows...
      </div>
    );
  }

  return (
    <div className="relative" data-testid="client-flow-diagram">
      {activeLink && (
        <div className="pointer-events-none absolute right-2 top-1 z-10 px-2.5 py-1 rounded-lg border app-border app-surface/95 shadow text-[11px] tabular-nums app-text-secondary">
          {activeLink.clientName} → {activeLink.service} ·{' '}
          {formatBandwidth(activeLink.totalBps, unit)} · {formatBytes(activeLink.totalBytes)} (
          {activeLink.flowCount} conn)
        </div>
      )}

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.svgWidth} ${layout.svgHeight}`}
          className="w-full min-w-[600px] h-auto block select-none"
          role="img"
          aria-label="Client to destination traffic flow diagram"
        >
          {/* Curved Flow Ribbons */}
          <g>
            {layout.ribbons.map((r) => {
              const isHighlighted =
                hoveredLinkKey === r.key ||
                hoveredClient === r.link.clientIp ||
                hoveredService === r.link.service;
              const anyHover = Boolean(hoveredLinkKey || hoveredClient || hoveredService);
              const opacity = anyHover ? (isHighlighted ? 0.85 : 0.1) : 0.45;

              return (
                <path
                  key={r.key}
                  d={r.path}
                  fill="none"
                  stroke={r.color}
                  strokeWidth={r.thickness}
                  strokeOpacity={opacity}
                  strokeLinecap="round"
                  className="transition-opacity duration-150 cursor-pointer"
                  onMouseEnter={() => setHoveredLinkKey(r.key)}
                  onMouseLeave={() => setHoveredLinkKey(null)}
                  onClick={() => onSelectFilter(r.link.clientIp)}
                />
              );
            })}
          </g>

          {/* Left Column: LAN Clients */}
          <g>
            {layout.clientNodes.map((n) => {
              const active = hoveredClient === n.id;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredClient(n.id)}
                  onMouseLeave={() => setHoveredClient(null)}
                  onClick={() => onSelectFilter(n.id)}
                >
                  <rect
                    width={180}
                    height={n.height}
                    rx={12}
                    fill={theme.nodeFill}
                    stroke={active ? n.color : theme.nodeBorder}
                    strokeWidth={active ? 1.5 : 1}
                  />
                  <rect
                    x={6}
                    y={Math.min(6, n.height * 0.2)}
                    width={3.5}
                    height={Math.max(10, n.height - Math.min(12, n.height * 0.4))}
                    rx={2}
                    fill={n.color}
                  />
                  <text
                    x={16}
                    y={n.height / 2 - (n.height >= 34 ? 4 : -4)}
                    fontSize={12}
                    fontWeight={600}
                    fill={theme.isDark ? '#F8FAFC' : '#0F172A'}
                  >
                    {n.label.length > 17 ? `${n.label.slice(0, 16)}…` : n.label}
                  </text>
                  {n.height >= 34 && (
                    <text
                      x={16}
                      y={n.height / 2 + 11}
                      fontSize={10}
                      fontFamily="JetBrains Mono, monospace"
                      fill={theme.axisTextColor}
                    >
                      {formatBandwidth(n.bps, unit)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* Right Column: Destination Services */}
          <g>
            {layout.serviceNodes.map((n) => {
              const active = hoveredService === n.id;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredService(n.id)}
                  onMouseLeave={() => setHoveredService(null)}
                  onClick={() => onSelectFilter(n.id)}
                >
                  <rect
                    width={180}
                    height={n.height}
                    rx={12}
                    fill={theme.nodeFill}
                    stroke={active ? theme.rxColor : theme.nodeBorder}
                    strokeWidth={active ? 1.5 : 1}
                  />
                  <text
                    x={14}
                    y={n.height / 2 - (n.height >= 34 ? 4 : -4)}
                    fontSize={12}
                    fontWeight={600}
                    fill={theme.isDark ? '#F8FAFC' : '#0F172A'}
                  >
                    {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
                  </text>
                  {n.height >= 34 && (
                    <text
                      x={14}
                      y={n.height / 2 + 11}
                      fontSize={10}
                      fontFamily="JetBrains Mono, monospace"
                      fill={theme.axisTextColor}
                    >
                      {formatBandwidth(n.bps, unit)} · {n.subLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
