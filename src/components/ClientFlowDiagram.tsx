import { useMemo, useState } from 'react';
import type { BandwidthUnit, ClientDestinationLink } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes, isPrivateIp } from '../lib/formatters';

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

const MAX_FLOW_DEVICES = 3;
const MAX_FLOW_DESTINATIONS = 5;

function isInternetLink(link: ClientDestinationLink): boolean {
  if (link.scope === 'lan') return false;
  if (link.scope === 'internet') return true;
  if (link.category === 'Local Network') return false;
  if (link.dstIp && isPrivateIp(link.dstIp)) return false;
  return true;
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
    const scopedLinks = links.filter(isInternetLink);

    const clientTotals = new Map<string, { name: string; bps: number; bytes: number }>();
    for (const l of scopedLinks) {
      const c = clientTotals.get(l.clientIp) || { name: l.clientName, bps: 0, bytes: 0 };
      c.bps += l.totalBps;
      c.bytes += l.totalBytes;
      clientTotals.set(l.clientIp, c);
    }

    // Show up to a max of 3 active devices with traffic
    const topClients = Array.from(clientTotals.entries())
      .sort((a, b) => b[1].bps - a[1].bps || b[1].bytes - a[1].bytes)
      .slice(0, MAX_FLOW_DEVICES);

    const clientSet = new Set(topClients.map(([ip]) => ip));
    const linksForTopClients = scopedLinks.filter((l) => clientSet.has(l.clientIp));

    // Aggregate destinations ONLY from the selected top devices so every device has connecting ribbons
    const serviceTotals = new Map<string, { bps: number; bytes: number }>();
    for (const l of linksForTopClients) {
      const s = serviceTotals.get(l.service) || { bps: 0, bytes: 0 };
      s.bps += l.totalBps;
      s.bytes += l.totalBytes;
      serviceTotals.set(l.service, s);
    }

    // Guarantee each top device's primary destination is included, then fill up to MAX_FLOW_DESTINATIONS
    const guaranteedServices = new Set<string>();
    for (const [clientIp] of topClients) {
      const bestForClient = linksForTopClients
        .filter((l) => l.clientIp === clientIp)
        .sort((a, b) => b.totalBps - a.totalBps || b.totalBytes - a.totalBytes)[0];
      if (bestForClient) {
        guaranteedServices.add(bestForClient.service);
      }
    }

    const sortedServices = Array.from(serviceTotals.entries()).sort(
      (a, b) => b[1].bps - a[1].bps || b[1].bytes - a[1].bytes
    );

    const topServices: Array<[string, { bps: number; bytes: number }]> = [];
    const chosenServiceKeys = new Set<string>();

    for (const entry of sortedServices) {
      if (guaranteedServices.has(entry[0]) && !chosenServiceKeys.has(entry[0])) {
        topServices.push(entry);
        chosenServiceKeys.add(entry[0]);
      }
    }
    for (const entry of sortedServices) {
      if (topServices.length >= MAX_FLOW_DESTINATIONS) break;
      if (!chosenServiceKeys.has(entry[0])) {
        topServices.push(entry);
        chosenServiceKeys.add(entry[0]);
      }
    }
    topServices.sort((a, b) => b[1].bps - a[1].bps || b[1].bytes - a[1].bytes);

    const serviceSet = new Set(topServices.map(([srv]) => srv));

    // ~15% tighter height than 320px and mathematically bounded so devices can never clip
    const svgWidth = 860;
    const svgHeight = 256;
    const padY = 10;
    const gap = 8;
    const usableH = svgHeight - padY * 2;

    const distributeNodes = <T,>(
      items: Array<[string, T]>,
      getWeight: (v: T) => number,
      getLabel: (k: string, v: T) => { label: string; sub: string; bps: number; bytes: number },
      x: number,
      usePalette: boolean
    ): PositionedNode[] => {
      if (items.length === 0) return [];
      const count = items.length;
      const totalGap = gap * Math.max(0, count - 1);
      const avail = Math.max(44, usableH - totalGap);
      const weights = items.map(([, v]) => Math.max(1, getWeight(v)));
      const sumW = weights.reduce((a, b) => a + b, 0);

      // Compute balanced heights that ALWAYS fit strictly inside `avail`
      const minH = Math.min(36, Math.floor(avail / count));
      const maxH = Math.min(68, Math.floor(avail - minH * (count - 1)));
      const rawHeights = weights.map((w) => {
        const proportional = (w / sumW) * avail;
        return Math.max(minH, Math.min(maxH, proportional));
      });
      const sumRaw = rawHeights.reduce((a, b) => a + b, 0);
      const scale = sumRaw > avail ? avail / sumRaw : 1;
      const heights = rawHeights.map((h) => Math.max(26, Math.floor(h * scale)));

      let cursorY = padY;
      return items.map(([key, v], idx) => {
        const h = heights[idx];
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
      1,
      true
    );

    const serviceNodes = distributeNodes(
      topServices,
      (v) => v.bps || v.bytes,
      (srv, v) => ({ label: srv, sub: formatBytes(v.bytes), bps: v.bps, bytes: v.bytes }),
      svgWidth - 181,
      false
    );

    // Center both columns vertically within svgHeight without ever exceeding padY bounds
    const centerColumn = (nodes: PositionedNode[]) => {
      if (nodes.length === 0) return;
      const last = nodes[nodes.length - 1];
      const totalSpan = last.y + last.height - nodes[0].y;
      const targetStart = Math.max(padY, (svgHeight - totalSpan) / 2);
      const offset = targetStart - nodes[0].y;
      for (const n of nodes) n.y += offset;
    };
    centerColumn(clientNodes);
    centerColumn(serviceNodes);

    const clientNodeMap = new Map(clientNodes.map((n) => [n.id, n]));
    const serviceNodeMap = new Map(serviceNodes.map((n) => [n.id, n]));

    const filteredLinks = linksForTopClients.filter(
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
      const thickness = Math.max(2.5, Math.min(14, (weight / maxLinkWeight) * 13));

      const cOff = clientOffsets.get(src.id) ?? 0;
      const sOff = serviceOffsets.get(dst.id) ?? 0;

      const y1 = Math.min(src.y + src.height - 6, src.y + 8 + cOff);
      const y2 = Math.min(dst.y + dst.height - 6, dst.y + 8 + sOff);

      clientOffsets.set(
        src.id,
        (cOff + Math.max(4, thickness * 0.55)) % Math.max(8, src.height - 12)
      );
      serviceOffsets.set(
        dst.id,
        (sOff + Math.max(4, thickness * 0.55)) % Math.max(8, dst.height - 12)
      );

      const x1 = src.x + 180;
      const x2 = dst.x;
      const mx = (x1 + x2) / 2;

      return {
        key: `internet:${l.clientIp}=>${l.service}`,
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
      <div
        data-testid="client-flow-empty"
        className="py-8 text-center text-xs app-text-muted space-y-1.5"
      >
        <div>Waiting for active internet traffic flows...</div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      data-testid="client-flow-diagram"
      data-scope="internet"
      data-client-count={layout.clientNodes.length}
    >
      {activeLink && (
        <div className="pointer-events-none absolute right-2 top-1 z-10 px-2.5 py-1 rounded-lg border app-border app-floating-bar shadow text-[11px] tabular-nums app-text-secondary">
          {activeLink.clientName} → {activeLink.service} ·{' '}
          {formatBandwidth(activeLink.totalBps, unit)} · {formatBytes(activeLink.totalBytes)} (
          {activeLink.flowCount} conn)
        </div>
      )}

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.svgWidth} ${layout.svgHeight}`}
          className="w-full min-w-[600px] max-h-[260px] h-auto block select-none"
          role="img"
          aria-label="Client to internet service traffic flow diagram"
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

          {/* Left Column: Active Source Devices (Max 3) */}
          <g>
            {layout.clientNodes.map((n) => {
              const active = hoveredClient === n.id;
              return (
                <g
                  key={n.id}
                  data-testid={`flow-client-node-${n.id}`}
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

          {/* Right Column: Destination Services / LAN Targets */}
          <g>
            {layout.serviceNodes.map((n) => {
              const active = hoveredService === n.id;
              return (
                <g
                  key={n.id}
                  data-testid={`flow-service-node-${n.id}`}
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
