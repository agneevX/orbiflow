import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Clock, RotateCcw } from 'lucide-react';
import type { BandwidthUnit, TimeFormat, TrafficPoint } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  buildZoomedRangeAnalysis,
  computeMonotoneSplineCurves,
  getDisplaySegmentsForAnalysis,
  summarizeSelectionRange,
  type PlotPoint,
  type TimeRange,
  type TimeWindowAnalysis,
} from '../lib/timeWindowUtils';
import { formatBandwidth, formatBytes, formatDuration, formatTimestamp } from '../lib/formatters';

interface ThroughputChartProps {
  analysis: TimeWindowAnalysis;
  fullHistory?: TrafficPoint[];
  fullRollupHistory?: TrafficPoint[];
  unit: BandwidthUnit;
  timeFormat?: TimeFormat;
  theme: ThemePalette;
  longWindow?: boolean;
  height?: number;
}

const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;

/**
 * Traces a smooth monotone cubic Hermite spline (Fritsch-Carlson) through sorted points.
 * Preserves local extrema without overshooting below baseline or dropping the final live segment.
 */
function traceMonotoneSpline(ctx: CanvasRenderingContext2D, pts: PlotPoint[], baselineY: number): void {
  const n = pts.length;
  if (n === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }

  const curves = computeMonotoneSplineCurves(pts, PAD_TOP, baselineY);
  for (const c of curves) {
    ctx.bezierCurveTo(c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y);
  }
}

/**
 * Mixes a hex color with white/black/alpha to build a smooth gradient stroke that matches every theme.
 */
function hexToRgba(hex: string, alpha: number, lighten = 0): string {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return hex;
  let r = parseInt(cleaned.slice(0, 2), 16);
  let g = parseInt(cleaned.slice(2, 4), 16);
  let b = parseInt(cleaned.slice(4, 6), 16);
  if (lighten > 0) {
    r = Math.min(255, Math.round(r + (255 - r) * lighten));
    g = Math.min(255, Math.round(g + (255 - g) * lighten));
    b = Math.min(255, Math.round(b + (255 - b) * lighten));
  } else if (lighten < 0) {
    const factor = 1 + lighten;
    r = Math.max(0, Math.round(r * factor));
    g = Math.max(0, Math.round(g * factor));
    b = Math.max(0, Math.round(b * factor));
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ThroughputChart({
  analysis,
  fullHistory,
  fullRollupHistory,
  unit,
  timeFormat = '12h',
  theme,
  longWindow = false,
  height = 250,
}: ThroughputChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverXRatio, setHoverXRatio] = useState<number | null>(null);
  const [width, setWidth] = useState(800);

  // Interactive legend series filter (at least one series remains visible)
  const [showDownload, setShowDownload] = useState(true);
  const [showUpload, setShowUpload] = useState(true);

  // Interactive drag-to-zoom state
  const [zoomRange, setZoomRange] = useState<TimeRange | null>(null);
  const [dragState, setDragState] = useState<{
    startX: number;
    currentX: number;
    startTs: number;
    currentTs: number;
  } | null>(null);

  useEffect(() => {
    setZoomRange(null);
    setDragState(null);
  }, [analysis.window]);

  const handleToggleDownload = () => {
    if (showDownload && !showUpload) {
      setShowDownload(true);
      setShowUpload(true);
      return;
    }
    setShowDownload((prev) => !prev);
  };

  const handleToggleUpload = () => {
    if (showUpload && !showDownload) {
      setShowDownload(true);
      setShowUpload(true);
      return;
    }
    setShowUpload((prev) => !prev);
  };

  // When zoomed, resolve full un-downsampled resolution across the zoomed span
  const displayAnalysis = useMemo(() => {
    if (!zoomRange) return analysis;
    return buildZoomedRangeAnalysis(
      analysis,
      zoomRange.start,
      zoomRange.end,
      fullHistory,
      fullRollupHistory
    );
  }, [analysis, zoomRange, fullHistory, fullRollupHistory]);

  // Reduce points on 15m+ windows for smooth overview curves; show full data when zoomed
  const plottedSegments = useMemo(
    () => getDisplaySegmentsForAnalysis(displayAnalysis, Boolean(zoomRange)),
    [displayAnalysis, zoomRange]
  );

  const plottedPoints = useMemo(() => plottedSegments.flat(), [plottedSegments]);

  const {
    points: fullRangePoints,
    leadingAnchor,
    noDataRanges,
    windowStart,
    windowEnd,
    status,
    window: timeWindow,
  } = displayAnalysis;
  const effectiveLong = longWindow && !zoomRange;

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
    for (const p of plottedPoints) {
      if (showDownload && p.rxBps > m) m = p.rxBps;
      if (showUpload && p.txBps > m) m = p.txBps;
    }
    return m * 1.18;
  }, [plottedPoints, showDownload, showUpload]);

  // Measure tight left gutter so Y-axis speed labels sit flush left with "Internet traffic"
  const padLeft = useMemo(() => {
    const labels = [0, 0.25, 0.5, 0.75, 1].map((r) => formatBandwidth(r * maxBps, unit));
    if (typeof document !== 'undefined') {
      const probe = document.createElement('canvas').getContext('2d');
      if (probe) {
        probe.font = '11px "Inter", sans-serif';
        const maxW = Math.max(...labels.map((l) => probe.measureText(l).width));
        return Math.max(46, Math.ceil(maxW) + 10);
      }
    }
    const maxLen = Math.max(...labels.map((l) => l.length));
    return Math.max(46, Math.ceil(maxLen * 6.5) + 10);
  }, [maxBps, unit]);

  const activeDragRange: TimeRange | null = useMemo(() => {
    if (dragState && Math.abs(dragState.currentX - dragState.startX) >= 4) {
      return {
        start: Math.min(dragState.startTs, dragState.currentTs),
        end: Math.max(dragState.startTs, dragState.currentTs),
      };
    }
    return null;
  }, [dragState]);

  // Show live summary while dragging OR for the currently zoomed range (using full-resolution points)
  const inspectedRange = activeDragRange || zoomRange;
  const selectionSummary = useMemo(() => {
    if (!inspectedRange) return null;
    return summarizeSelectionRange(fullRangePoints, inspectedRange.start, inspectedRange.end);
  }, [inspectedRange, fullRangePoints]);

  const hoverInfo = useMemo(() => {
    if (hoverXRatio === null || dragState !== null) return null;
    const span = Math.max(1, windowEnd - windowStart);
    const hoverTs = windowStart + hoverXRatio * span;

    const inNoData = noDataRanges.find((r) => hoverTs >= r.start && hoverTs <= r.end);
    if (inNoData || plottedPoints.length === 0) {
      return {
        timestamp: hoverTs,
        point: null as TrafficPoint | null,
        isNoData: true,
      };
    }

    // Never snap hover markers into empty canvas outside the actually drawn data bounds
    const firstDrawnTs = leadingAnchor ? windowStart : plottedPoints[0].timestamp;
    const lastDrawnTs = plottedPoints[plottedPoints.length - 1].timestamp;
    const edgeSnapMargin = Math.max(4_000, Math.min(18_000, span * 0.02));
    if (hoverTs < firstDrawnTs - edgeSnapMargin || hoverTs > lastDrawnTs + edgeSnapMargin) {
      return {
        timestamp: hoverTs,
        point: null as TrafficPoint | null,
        isNoData: true,
      };
    }

    let nearest = plottedPoints[0];
    let bestDist = Math.abs(plottedPoints[0].timestamp - hoverTs);
    for (let i = 1; i < plottedPoints.length; i++) {
      const dist = Math.abs(plottedPoints[i].timestamp - hoverTs);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = plottedPoints[i];
      }
    }

    return {
      timestamp: nearest.timestamp,
      point: nearest,
      isNoData: false,
    };
  }, [hoverXRatio, dragState, windowStart, windowEnd, noDataRanges, plottedPoints, leadingAnchor]);

  const clientXToPlot = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: padLeft, ratio: 0, ts: windowStart };
      const rect = canvas.getBoundingClientRect();
      const rawX = clientX - rect.left;
      const plotW = Math.max(40, width - padLeft - PAD_RIGHT);
      const clampedX = Math.min(padLeft + plotW, Math.max(padLeft, rawX));
      const ratio = (clampedX - padLeft) / plotW;
      const span = Math.max(1, windowEnd - windowStart);
      return {
        x: clampedX,
        ratio,
        ts: Math.round(windowStart + ratio * span),
      };
    },
    [width, padLeft, windowStart, windowEnd]
  );

  // Drag-selecting an area immediately zooms into that range with full-resolution data
  useEffect(() => {
    if (!dragState) return;

    const onWindowMove = (e: MouseEvent) => {
      const pos = clientXToPlot(e.clientX);
      setDragState((prev) =>
        prev
          ? {
              ...prev,
              currentX: pos.x,
              currentTs: pos.ts,
            }
          : null
      );
    };

    const onWindowUp = (e: MouseEvent) => {
      const pos = clientXToPlot(e.clientX);
      setDragState((prev) => {
        if (!prev) return null;
        if (Math.abs(pos.x - prev.startX) >= 8) {
          const start = Math.min(prev.startTs, pos.ts);
          const end = Math.max(prev.startTs, pos.ts);
          if (end - start >= 1000) {
            setZoomRange({ start, end });
          }
        }
        return null;
      });
    };

    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    return () => {
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
    };
  }, [dragState !== null, clientXToPlot]);

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

    const plotW = Math.max(40, width - padLeft - PAD_RIGHT);
    const plotH = Math.max(40, height - PAD_TOP - PAD_BOTTOM);
    const baselineY = PAD_TOP + plotH;
    const span = Math.max(1, windowEnd - windowStart);

    const xForTimeRaw = (ts: number) => padLeft + ((ts - windowStart) / span) * plotW;

    const xForTime = (ts: number) => {
      const ratio = Math.min(1, Math.max(0, (ts - windowStart) / span));
      return padLeft + ratio * plotW;
    };

    const yForBps = (bps: number) => {
      const safe = Number.isFinite(bps) && bps > 0 ? bps : 0;
      const norm = Math.min(1, Math.max(0, safe / maxBps));
      return baselineY - norm * plotH;
    };

    // Draw horizontal gridlines + left-aligned Y-axis labels flush with card heading
    const ticks = 4;
    ctx.font = '11px "Inter", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= ticks; i++) {
      const ratio = i / ticks;
      const y = baselineY - ratio * plotH;
      const val = ratio * maxBps;

      ctx.strokeStyle = theme.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = theme.axisTextColor;
      ctx.fillText(formatBandwidth(val, unit), 0, y);
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
      ctx.rect(x1, PAD_TOP, bandW, plotH);
      ctx.clip();

      ctx.fillStyle = noDataFill;
      ctx.fillRect(x1, PAD_TOP, bandW, plotH);

      ctx.strokeStyle = hatchStroke;
      ctx.lineWidth = 1;
      const step = 12;
      ctx.beginPath();
      for (let x = x1 - plotH; x < x2 + plotH; x += step) {
        ctx.moveTo(x, baselineY);
        ctx.lineTo(x + plotH, PAD_TOP);
      }
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = hatchStroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (x1 > padLeft + 1) {
        ctx.beginPath();
        ctx.moveTo(x1, PAD_TOP);
        ctx.lineTo(x1, baselineY);
        ctx.stroke();
      }
      if (x2 < padLeft + plotW - 1) {
        ctx.beginPath();
        ctx.moveTo(x2, PAD_TOP);
        ctx.lineTo(x2, baselineY);
        ctx.stroke();
      }
      ctx.restore();

      if (status !== 'empty' && bandW >= 72) {
        ctx.save();
        ctx.fillStyle = theme.axisTextColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '11px "Inter", sans-serif';
        const cx = x1 + bandW / 2;
        const cy = PAD_TOP + plotH / 2;
        if (bandW >= 168) {
          ctx.fillText('No data', cx, cy - 8);
          ctx.font = '10px "Inter", sans-serif';
          ctx.fillText(
            `${formatTimestamp(range.start, effectiveLong, false, timeFormat)} – ${formatTimestamp(range.end, effectiveLong, false, timeFormat)}`,
            cx,
            cy + 8
          );
        } else {
          ctx.fillText('No data', cx, cy);
        }
        ctx.restore();
      }
    }

    // Draw true time-window X-axis ticks aligned flush with the plot edges
    ctx.fillStyle = theme.axisTextColor;
    ctx.textBaseline = 'top';
    ctx.font = '11px "Inter", sans-serif';

    ctx.textAlign = 'left';
    ctx.fillText(
      formatTimestamp(windowStart, effectiveLong, false, timeFormat),
      padLeft,
      baselineY + 8
    );

    ctx.textAlign = 'center';
    ctx.fillText(
      formatTimestamp(windowStart + span / 2, effectiveLong, false, timeFormat),
      padLeft + plotW / 2,
      baselineY + 8
    );

    ctx.textAlign = 'right';
    ctx.fillText(
      formatTimestamp(windowEnd, effectiveLong, false, timeFormat),
      padLeft + plotW,
      baselineY + 8
    );

    // Empty state for the full selected window
    if (status === 'empty' || plottedSegments.length === 0) {
      ctx.fillStyle = theme.axisTextColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 13px "Inter", sans-serif';
      ctx.fillText(
        zoomRange ? 'No data in zoomed range' : `No data recorded for the last ${timeWindow}`,
        padLeft + plotW / 2,
        PAD_TOP + plotH / 2 - 9
      );
      ctx.font = '11px "Inter", sans-serif';
      ctx.fillText(
        zoomRange
          ? 'Reset zoom to return to the full time window.'
          : 'Select a different period or wait for new samples from the router agent.',
        padLeft + plotW / 2,
        PAD_TOP + plotH / 2 + 11
      );
      return;
    }

    // Prepend leadingAnchor to the first segment so the curve enters flush at padLeft
    const renderSegments = plottedSegments.map((seg, idx) =>
      idx === 0 && leadingAnchor ? [leadingAnchor, ...seg] : seg
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft - 2, PAD_TOP - 6, plotW + 10, plotH + 10);
    ctx.clip();

    const drawSeries = (
      accessor: (p: TrafficPoint) => number,
      baseColor: string
    ) => {
      // Smooth vertical gradient fill beneath the curve
      const areaGrad = ctx.createLinearGradient(0, PAD_TOP, 0, baselineY);
      areaGrad.addColorStop(0, hexToRgba(baseColor, theme.isDark ? 0.30 : 0.22, theme.isDark ? 0.12 : 0));
      areaGrad.addColorStop(0.55, hexToRgba(baseColor, theme.isDark ? 0.11 : 0.08));
      areaGrad.addColorStop(1, hexToRgba(baseColor, 0.0));

      // Refined vertical gradient stroke (brighter peaks, softer low baseline)
      const strokeGrad = ctx.createLinearGradient(0, PAD_TOP, 0, baselineY);
      strokeGrad.addColorStop(0, hexToRgba(baseColor, 1, theme.isDark ? 0.28 : -0.06));
      strokeGrad.addColorStop(0.65, hexToRgba(baseColor, 0.94));
      strokeGrad.addColorStop(1, hexToRgba(baseColor, 0.62, theme.isDark ? -0.1 : 0.08));

      for (const seg of renderSegments) {
        if (seg.length === 0) continue;
        if (seg.length === 1) {
          const px = Math.min(padLeft + plotW, Math.max(padLeft, xForTimeRaw(seg[0].timestamp)));
          const py = yForBps(accessor(seg[0]));
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px, baselineY);
          ctx.strokeStyle = hexToRgba(baseColor, 0.3);
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(px, py, 6, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(baseColor, 0.22);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(px, py, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = baseColor;
          ctx.fill();
          continue;
        }

        const pts: PlotPoint[] = seg.map((p) => ({
          x: xForTimeRaw(p.timestamp),
          y: yForBps(accessor(p)),
        }));

        // Fill gradient area under the smooth spline first
        ctx.beginPath();
        traceMonotoneSpline(ctx, pts, baselineY);
        ctx.lineTo(pts[pts.length - 1].x, baselineY);
        ctx.lineTo(pts[0].x, baselineY);
        ctx.closePath();
        ctx.fillStyle = areaGrad;
        ctx.fill();

        // Draw smooth gradient stroke on top
        ctx.beginPath();
        traceMonotoneSpline(ctx, pts, baselineY);
        ctx.strokeStyle = strokeGrad;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Always render the latest live incoming point cleanly at the right edge
      if (!zoomRange && renderSegments.length > 0) {
        const lastSeg = renderSegments[renderSegments.length - 1];
        const livePt = lastSeg[lastSeg.length - 1];
        if (livePt && windowEnd - livePt.timestamp <= 30_000) {
          const lx = Math.min(padLeft + plotW, Math.max(padLeft, xForTimeRaw(livePt.timestamp)));
          const ly = yForBps(accessor(livePt));
          ctx.beginPath();
          ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(baseColor, 0.22);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
          ctx.fillStyle = baseColor;
          ctx.fill();
          ctx.strokeStyle = theme.nodeFill;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    };

    if (showDownload) {
      drawSeries((p) => p.rxBps, theme.rxColor);
    }
    if (showUpload) {
      drawSeries((p) => p.txBps, theme.txColor);
    }

    ctx.restore();

    // Highlight active brush selection band while dragging
    if (activeDragRange) {
      const sx1 = xForTime(activeDragRange.start);
      const sx2 = xForTime(activeDragRange.end);
      const sw = Math.max(2, sx2 - sx1);

      ctx.save();
      ctx.fillStyle = theme.isDark ? 'rgba(0, 0, 0, 0.24)' : 'rgba(15, 23, 42, 0.06)';
      if (sx1 > padLeft) {
        ctx.fillRect(padLeft, PAD_TOP, sx1 - padLeft, plotH);
      }
      if (sx2 < padLeft + plotW) {
        ctx.fillRect(sx2, PAD_TOP, padLeft + plotW - sx2, plotH);
      }

      ctx.fillStyle = theme.isDark
        ? 'rgba(56, 189, 248, 0.14)'
        : 'rgba(2, 132, 199, 0.12)';
      ctx.fillRect(sx1, PAD_TOP, sw, plotH);

      ctx.strokeStyle = theme.rxColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(sx1, PAD_TOP);
      ctx.lineTo(sx1, baselineY);
      ctx.moveTo(sx2, PAD_TOP);
      ctx.lineTo(sx2, baselineY);
      ctx.stroke();

      const midY = PAD_TOP + plotH / 2;
      ctx.fillStyle = theme.rxColor;
      for (const ex of [sx1, sx2]) {
        ctx.beginPath();
        ctx.roundRect(ex - 2, midY - 12, 4, 24, 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Hover crosshair + active series markers (hidden while actively dragging)
    if (hoverInfo) {
      const hx = hoverInfo.point
        ? xForTime(hoverInfo.point.timestamp)
        : xForTime(hoverInfo.timestamp);

      ctx.strokeStyle = theme.axisTextColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, PAD_TOP);
      ctx.lineTo(hx, baselineY);
      ctx.stroke();
      ctx.setLineDash([]);

      if (hoverInfo.point && !hoverInfo.isNoData) {
        const markers: Array<[number, string]> = [];
        if (showDownload) markers.push([yForBps(hoverInfo.point.rxBps), theme.rxColor]);
        if (showUpload) markers.push([yForBps(hoverInfo.point.txBps), theme.txColor]);
        for (const [hy, color] of markers) {
          ctx.beginPath();
          ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = theme.nodeFill;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
    }
  }, [
    displayAnalysis,
    plottedSegments,
    leadingAnchor,
    noDataRanges,
    windowStart,
    windowEnd,
    status,
    timeWindow,
    width,
    height,
    padLeft,
    maxBps,
    hoverInfo,
    activeDragRange,
    zoomRange,
    unit,
    timeFormat,
    theme,
    effectiveLong,
    showDownload,
    showUpload,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = clientXToPlot(e.clientX);
    setHoverXRatio(pos.ratio);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const pos = clientXToPlot(e.clientX);
    setDragState({
      startX: pos.x,
      currentX: pos.x,
      startTs: pos.ts,
      currentTs: pos.ts,
    });
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) return;
    const pos = clientXToPlot(e.touches[0].clientX);
    setDragState({
      startX: pos.x,
      currentX: pos.x,
      startTs: pos.ts,
      currentTs: pos.ts,
    });
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!dragState || e.touches.length !== 1) return;
    const pos = clientXToPlot(e.touches[0].clientX);
    setDragState((prev) =>
      prev
        ? {
            ...prev,
            currentX: pos.x,
            currentTs: pos.ts,
          }
        : null
    );
  };

  const handleTouchEnd = () => {
    setDragState((prev) => {
      if (!prev) return null;
      if (Math.abs(prev.currentX - prev.startX) >= 8) {
        const start = Math.min(prev.startTs, prev.currentTs);
        const end = Math.max(prev.startTs, prev.currentTs);
        if (end - start >= 1000) {
          setZoomRange({ start, end });
        }
      }
      return null;
    });
  };

  const handleResetZoom = () => {
    setZoomRange(null);
    setDragState(null);
  };

  const tooltipLeftPct = hoverXRatio !== null ? Math.min(82, Math.max(18, hoverXRatio * 100)) : 50;

  return (
    <div ref={containerRef} className="relative w-full space-y-2.5">
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="throughput-chart"
          data-zoomed={zoomRange ? 'true' : 'false'}
          data-plotted-points={plottedPoints.length}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverXRatio(null)}
          onDoubleClick={handleResetZoom}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ width: '100%', height: `${height}px` }}
          className="block cursor-crosshair select-none touch-pan-y"
          aria-label="Internet traffic history chart"
        />

        {hoverInfo && (
          <div
            data-testid="chart-hover-tooltip"
            style={{ left: `${tooltipLeftPct}%` }}
            className="pointer-events-none absolute top-2 -translate-x-1/2 px-3 py-1.5 rounded-xl border app-floating-bar text-[11px] tabular-nums flex items-center gap-2.5 whitespace-nowrap z-10"
          >
            <span className="app-text-muted">
              {formatTimestamp(
                hoverInfo.point ? hoverInfo.point.timestamp : hoverInfo.timestamp,
                effectiveLong,
                false,
                timeFormat
              )}
            </span>
            {hoverInfo.isNoData || !hoverInfo.point ? (
              <span className="app-text-muted">No data</span>
            ) : (
              <>
                {showDownload && (
                  <span className="font-semibold" style={{ color: theme.rxColor }}>
                    ↓ {formatBandwidth(hoverInfo.point.rxBps, unit)}
                  </span>
                )}
                {showUpload && (
                  <span className="font-semibold" style={{ color: theme.txColor }}>
                    ↑ {formatBandwidth(hoverInfo.point.txBps, unit)}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Interactive Filter Legend Below the Graph */}
      <div
        data-testid="chart-legend"
        className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs"
      >
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            data-testid="legend-toggle-download"
            aria-pressed={showDownload}
            onClick={handleToggleDownload}
            className={`inline-flex items-center gap-2 py-0.5 transition-opacity text-xs font-medium cursor-pointer ${
              showDownload
                ? 'app-text-secondary hover:opacity-80'
                : 'app-text-muted opacity-40 line-through hover:opacity-75'
            }`}
          >
            <span
              className="inline-block w-3 h-0.5 rounded-full"
              style={{ backgroundColor: theme.rxColor }}
              aria-hidden="true"
            />
            <span>Download</span>
          </button>

          <button
            type="button"
            data-testid="legend-toggle-upload"
            aria-pressed={showUpload}
            onClick={handleToggleUpload}
            className={`inline-flex items-center gap-2 py-0.5 transition-opacity text-xs font-medium cursor-pointer ${
              showUpload
                ? 'app-text-secondary hover:opacity-80'
                : 'app-text-muted opacity-40 line-through hover:opacity-75'
            }`}
          >
            <span
              className="inline-block w-3 h-0.5 rounded-full"
              style={{ backgroundColor: theme.txColor }}
              aria-hidden="true"
            />
            <span>Upload</span>
          </button>

          {noDataRanges.length > 0 && (
            <span className="inline-flex items-center gap-2 px-2 py-1 app-text-muted">
              <span
                className="inline-block w-3 h-2.5 rounded-sm border"
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

        <div className="flex items-center gap-2">
          <span className="text-[11px] app-text-muted hidden sm:inline">
            {zoomRange ? 'Double-click chart to reset' : 'Drag to zoom into full resolution'}
          </span>
        </div>
      </div>

      {/* Structured Zoomed / Selected Range Inspection Panel */}
      {selectionSummary && (
        <div
          data-testid="chart-selection-inspector"
          className="rounded-xl border app-border app-input p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b app-border">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium app-text-secondary">
                <Clock className="h-3.5 w-3.5 text-sky-500 shrink-0" aria-hidden="true" />
                {activeDragRange ? 'Selecting Range' : 'Zoomed Range (Full Data)'}
              </span>
              <span className="font-semibold tabular-nums">
                {formatTimestamp(selectionSummary.start, false, false, timeFormat)} –{' '}
                {formatTimestamp(selectionSummary.end, false, false, timeFormat)}
              </span>
              <span className="app-text-muted" aria-hidden="true">
                ·
              </span>
              <span className="app-text-muted tabular-nums">
                {formatDuration(selectionSummary.durationSec)}
                {selectionSummary.hasData
                  ? ` · ${selectionSummary.sampleCount} ${selectionSummary.sampleCount === 1 ? 'sample' : 'samples'}`
                  : ''}
              </span>
            </div>

            {zoomRange && !activeDragRange && (
              <button
                type="button"
                data-testid="inspector-reset-zoom-btn"
                onClick={handleResetZoom}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Reset Zoom
              </button>
            )}
          </div>

          {selectionSummary.hasData ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:divide-x app-border">
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <ArrowDownRight
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: theme.rxColor }}
                      aria-hidden="true"
                    />
                    <span style={{ color: theme.rxColor }}>Download</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="text-[11px] app-text-muted">Average</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBandwidth(selectionSummary.avgRxBps, unit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] app-text-muted">Peak</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBandwidth(selectionSummary.peakRxBps, unit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] app-text-muted">Est. Transfer</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBytes(selectionSummary.estimatedRxBytes)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 md:pl-4 pt-3 md:pt-0 border-t md:border-t-0 app-border">
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <ArrowUpRight
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: theme.txColor }}
                      aria-hidden="true"
                    />
                    <span style={{ color: theme.txColor }}>Upload</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="text-[11px] app-text-muted">Average</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBandwidth(selectionSummary.avgTxBps, unit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] app-text-muted">Peak</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBandwidth(selectionSummary.peakTxBps, unit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] app-text-muted">Est. Transfer</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatBytes(selectionSummary.estimatedTxBytes)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t app-border flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs app-text-muted">
                  Total Transfer <span className="hidden sm:inline">(Download + Upload)</span>
                </div>
                <div
                  data-testid="zoom-total-transfer"
                  className="text-sm font-semibold tabular-nums"
                >
                  {formatBytes(
                    selectionSummary.estimatedRxBytes + selectionSummary.estimatedTxBytes
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-amber-500 font-medium py-1">
              No data recorded in this zoomed time range.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
