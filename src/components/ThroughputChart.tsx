import { useEffect, useMemo, useRef, useState } from 'react';
import type { BandwidthUnit, TrafficPoint } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import type { TimeWindowAnalysis } from '../lib/timeWindowUtils';
import { formatBandwidth, formatTimestamp } from '../lib/formatters';

interface ThroughputChartProps {
  analysis: TimeWindowAnalysis;
  unit: BandwidthUnit;
  theme: ThemePalette;
  longWindow?: boolean;
  height?: number;
}

export function ThroughputChart({
  analysis,
  unit,
  theme,
  longWindow = false,
  height = 260,
}: ThroughputChartProps) {
  const { points, segments, noDataRanges, windowStart, windowEnd, status, window: timeWindow } =
    analysis;
  const is24h = timeWindow === '24h';

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverXRatio, setHoverXRatio] = useState<number | null>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setWidth(Math.floor(entry.contentRect.width));
        }
      }
    });
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth || 800));
    return () => ro.disconnect();
  }, []);

  const maxBps = useMemo(() => {
    let m = 250_000;
    for (const p of points) {
      if (p.rxBps > m) m = p.rxBps;
      if (p.txBps > m) m = p.txBps;
    }
    return m * 1.18;
  }, [points]);

  const hoverInfo = useMemo(() => {
    if (hoverXRatio === null) return null;
    const span = Math.max(1, windowEnd - windowStart);
    const hoverTs = windowStart + hoverXRatio * span;

    const inNoData = noDataRanges.find((r) => hoverTs >= r.start && hoverTs <= r.end);
    if (inNoData || points.length === 0) {
      return {
        timestamp: hoverTs,
        point: null as TrafficPoint | null,
        isNoData: true,
      };
    }

    let nearest = points[0];
    let bestDist = Math.abs(points[0].timestamp - hoverTs);
    for (let i = 1; i < points.length; i++) {
      const dist = Math.abs(points[i].timestamp - hoverTs);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = points[i];
      }
    }

    return {
      timestamp: nearest.timestamp,
      point: nearest,
      isNoData: false,
    };
  }, [hoverXRatio, windowStart, windowEnd, noDataRanges, points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 82;
    const padRight = 14;
    const padTop = 16;
    const padBottom = 28;
    const plotW = Math.max(40, width - padLeft - padRight);
    const plotH = Math.max(40, height - padTop - padBottom);
    const span = Math.max(1, windowEnd - windowStart);

    const xForTime = (ts: number) => {
      const ratio = Math.min(1, Math.max(0, (ts - windowStart) / span));
      return padLeft + ratio * plotW;
    };

    const yForBps = (bps: number) => {
      const norm = Math.min(1, Math.max(0, bps / maxBps));
      return padTop + plotH - norm * plotH;
    };

    // Draw horizontal gridlines + Y-axis labels
    const ticks = 4;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= ticks; i++) {
      const ratio = i / ticks;
      const y = padTop + plotH - ratio * plotH;
      const val = ratio * maxBps;

      ctx.strokeStyle = theme.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = theme.axisTextColor;
      ctx.fillText(formatBandwidth(val, unit), padLeft - 10, y);
    }

    // Draw shaded diagonal-hatched regions for every no-data span
    const noDataFill = theme.isDark
      ? 'rgba(148, 163, 184, 0.06)'
      : 'rgba(100, 116, 139, 0.07)';
    const hatchStroke = theme.isDark
      ? 'rgba(148, 163, 184, 0.14)'
      : 'rgba(100, 116, 139, 0.15)';

    for (const range of noDataRanges) {
      const x1 = xForTime(range.start);
      const x2 = xForTime(range.end);
      const bandW = x2 - x1;
      if (bandW < 2) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, padTop, bandW, plotH);
      ctx.clip();

      ctx.fillStyle = noDataFill;
      ctx.fillRect(x1, padTop, bandW, plotH);

      ctx.strokeStyle = hatchStroke;
      ctx.lineWidth = 1;
      const step = 12;
      ctx.beginPath();
      for (let x = x1 - plotH; x < x2 + plotH; x += step) {
        ctx.moveTo(x, padTop + plotH);
        ctx.lineTo(x + plotH, padTop);
      }
      ctx.stroke();
      ctx.restore();

      // Subtle dashed border lines where data starts/ends
      ctx.save();
      ctx.strokeStyle = hatchStroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (x1 > padLeft + 1) {
        ctx.beginPath();
        ctx.moveTo(x1, padTop);
        ctx.lineTo(x1, padTop + plotH);
        ctx.stroke();
      }
      if (x2 < padLeft + plotW - 1) {
        ctx.beginPath();
        ctx.moveTo(x2, padTop);
        ctx.lineTo(x2, padTop + plotH);
        ctx.stroke();
      }
      ctx.restore();

      // Inline "No data" label inside wide enough shaded spans
      if (status !== 'empty' && bandW >= 72) {
        ctx.save();
        ctx.fillStyle = theme.axisTextColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '11px "Public Sans", sans-serif';
        const cx = x1 + bandW / 2;
        const cy = padTop + plotH / 2;
        if (bandW >= 168) {
          ctx.fillText('No data', cx, cy - 8);
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillText(
            `${formatTimestamp(range.start, longWindow, is24h)} – ${formatTimestamp(range.end, longWindow, is24h)}`,
            cx,
            cy + 8
          );
        } else {
          ctx.fillText('No data', cx, cy);
        }
        ctx.restore();
      }
    }

    // Draw true time-window X-axis ticks (start, midpoint, end)
    ctx.fillStyle = theme.axisTextColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '11px "JetBrains Mono", monospace';
    const xTicks = [windowStart, windowStart + span / 2, windowEnd];
    for (const ts of xTicks) {
      const x = xForTime(ts);
      const edgePad = is24h ? 42 : 26;
      const alignedX = Math.min(padLeft + plotW - edgePad, Math.max(padLeft + edgePad, x));
      ctx.fillText(formatTimestamp(ts, longWindow, is24h), alignedX, padTop + plotH + 8);
    }

    // Empty state for the full selected window
    if (status === 'empty' || segments.length === 0) {
      ctx.fillStyle = theme.axisTextColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 13px "Public Sans", sans-serif';
      ctx.fillText(
        `No data recorded for the last ${timeWindow}`,
        padLeft + plotW / 2,
        padTop + plotH / 2 - 9
      );
      ctx.font = '11px "Public Sans", sans-serif';
      ctx.fillText(
        'Select a different period or wait for new samples from the router agent.',
        padLeft + plotW / 2,
        padTop + plotH / 2 + 11
      );
      return;
    }

    // Draw each contiguous segment independently so lines never bridge over no-data gaps
    const drawSeries = (
      accessor: (p: TrafficPoint) => number,
      strokeColor: string,
      fillTop: string,
      fillBottom: string
    ) => {
      for (const seg of segments) {
        if (seg.length === 0) continue;
        if (seg.length === 1) {
          const px = xForTime(seg[0].timestamp);
          const py = yForBps(accessor(seg[0]));
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = strokeColor;
          ctx.fill();
          continue;
        }

        ctx.beginPath();
        seg.forEach((p, idx) => {
          const x = xForTime(p.timestamp);
          const y = yForBps(accessor(p));
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        const lastX = xForTime(seg[seg.length - 1].timestamp);
        const firstX = xForTime(seg[0].timestamp);
        ctx.lineTo(lastX, padTop + plotH);
        ctx.lineTo(firstX, padTop + plotH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, fillBottom);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    };

    drawSeries((p) => p.rxBps, theme.rxColor, theme.rxFillTop, theme.rxFillBottom);
    drawSeries((p) => p.txBps, theme.txColor, theme.txFillTop, theme.txFillBottom);

    // Hover crosshair
    if (hoverInfo) {
      const hx = hoverInfo.point
        ? xForTime(hoverInfo.point.timestamp)
        : xForTime(hoverInfo.timestamp);

      ctx.strokeStyle = theme.axisTextColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (hoverInfo.point && !hoverInfo.isNoData) {
        const hyRx = yForBps(hoverInfo.point.rxBps);
        const hyTx = yForBps(hoverInfo.point.txBps);
        for (const [hy, color] of [
          [hyRx, theme.rxColor],
          [hyTx, theme.txColor],
        ] as const) {
          ctx.beginPath();
          ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = theme.nodeFill;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }, [
    analysis,
    points,
    segments,
    noDataRanges,
    windowStart,
    windowEnd,
    status,
    timeWindow,
    width,
    height,
    maxBps,
    hoverInfo,
    unit,
    theme,
    longWindow,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padLeft = 82;
    const padRight = 14;
    const plotW = Math.max(40, width - padLeft - padRight);
    const ratio = Math.min(1, Math.max(0, (x - padLeft) / plotW));
    setHoverXRatio(ratio);
  };

  const latestPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs">
        <div className="flex flex-wrap items-center gap-5">
          <span className="inline-flex items-center gap-2 app-text-secondary">
            <span
              className="inline-block w-3 h-0.5"
              style={{ backgroundColor: theme.rxColor }}
              aria-hidden="true"
            />
            <span>Download (Rx)</span>
          </span>
          <span className="inline-flex items-center gap-2 app-text-secondary">
            <span
              className="inline-block w-3 h-0.5"
              style={{ backgroundColor: theme.txColor }}
              aria-hidden="true"
            />
            <span>Upload (Tx)</span>
          </span>
          {noDataRanges.length > 0 && (
            <span className="inline-flex items-center gap-2 app-text-muted">
              <span
                className="inline-block w-3 h-2.5 rounded-[2px] border"
                style={{
                  borderColor: theme.axisTextColor,
                  background: `repeating-linear-gradient(-45deg, transparent, transparent 2px, ${theme.gridColor} 2px, ${theme.gridColor} 4px)`,
                }}
                aria-hidden="true"
              />
              <span>No data</span>
            </span>
          )}
        </div>

        {hoverInfo ? (
          hoverInfo.isNoData || !hoverInfo.point ? (
            <div className="font-mono app-text-muted tabular-nums flex items-center gap-2">
              <span>{formatTimestamp(hoverInfo.timestamp, longWindow, is24h)}</span>
              <span aria-hidden="true">·</span>
              <span>No data</span>
            </div>
          ) : (
            <div className="font-mono app-text-muted tabular-nums flex items-center gap-3">
              <span>{formatTimestamp(hoverInfo.point.timestamp, longWindow, is24h)}</span>
              <span aria-hidden="true">·</span>
              <span style={{ color: theme.rxColor }}>
                Rx {formatBandwidth(hoverInfo.point.rxBps, unit)}
              </span>
              <span aria-hidden="true">·</span>
              <span style={{ color: theme.txColor }}>
                Tx {formatBandwidth(hoverInfo.point.txBps, unit)}
              </span>
            </div>
          )
        ) : latestPoint ? (
          <div className="font-mono app-text-muted tabular-nums flex items-center gap-3">
            <span>{formatTimestamp(latestPoint.timestamp, longWindow, is24h)}</span>
            <span aria-hidden="true">·</span>
            <span style={{ color: theme.rxColor }}>
              Rx {formatBandwidth(latestPoint.rxBps, unit)}
            </span>
            <span aria-hidden="true">·</span>
            <span style={{ color: theme.txColor }}>
              Tx {formatBandwidth(latestPoint.txBps, unit)}
            </span>
          </div>
        ) : (
          <div className="font-mono app-text-muted tabular-nums">
            No data ({timeWindow})
          </div>
        )}
      </div>

      <canvas
        ref={canvasRef}
        data-testid="throughput-chart"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverXRatio(null)}
        style={{ width: '100%', height: `${height}px` }}
        className="block cursor-crosshair"
        aria-label="Real-time WAN download and upload bandwidth chart"
      />
    </div>
  );
}
