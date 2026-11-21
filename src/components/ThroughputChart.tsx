import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Clock, RotateCcw, X, ZoomIn } from 'lucide-react';
import type { BandwidthUnit, TimeFormat, TrafficPoint } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  sliceAnalysisToRange,
  summarizeSelectionRange,
  type TimeRange,
  type TimeWindowAnalysis,
} from '../lib/timeWindowUtils';
import { formatBandwidth, formatBytes, formatDuration, formatTimestamp } from '../lib/formatters';

interface ThroughputChartProps {
  analysis: TimeWindowAnalysis;
  unit: BandwidthUnit;
  timeFormat?: TimeFormat;
  theme: ThemePalette;
  longWindow?: boolean;
  height?: number;
}

const PAD_LEFT = 76;
const PAD_RIGHT = 6;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;

export function ThroughputChart({
  analysis,
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

  // Interactive range selection & zoom state
  const [zoomRange, setZoomRange] = useState<TimeRange | null>(null);
  const [selectedRange, setSelectedRange] = useState<TimeRange | null>(null);
  const [dragState, setDragState] = useState<{
    startX: number;
    currentX: number;
    startTs: number;
    currentTs: number;
  } | null>(null);

  useEffect(() => {
    setZoomRange(null);
    setSelectedRange(null);
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

  const displayAnalysis = useMemo(() => {
    if (!zoomRange) return analysis;
    return sliceAnalysisToRange(analysis, zoomRange.start, zoomRange.end);
  }, [analysis, zoomRange]);

  const {
    points,
    segments,
    leadingAnchor,
    noDataRanges,
    windowStart,
    windowEnd,
    status,
    window: timeWindow,
  } = displayAnalysis;
  const is24h = timeWindow === '24h' && !zoomRange;
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
    for (const p of points) {
      if (showDownload && p.rxBps > m) m = p.rxBps;
      if (showUpload && p.txBps > m) m = p.txBps;
    }
    return m * 1.18;
  }, [points, showDownload, showUpload]);

  const activeSelectionRange: TimeRange | null = useMemo(() => {
    if (dragState && Math.abs(dragState.currentX - dragState.startX) >= 4) {
      return {
        start: Math.min(dragState.startTs, dragState.currentTs),
        end: Math.max(dragState.startTs, dragState.currentTs),
      };
    }
    return selectedRange;
  }, [dragState, selectedRange]);

  const selectionSummary = useMemo(() => {
    if (!activeSelectionRange) return null;
    return summarizeSelectionRange(
      displayAnalysis.points,
      activeSelectionRange.start,
      activeSelectionRange.end
    );
  }, [activeSelectionRange, displayAnalysis.points]);

  const hoverInfo = useMemo(() => {
    if (hoverXRatio === null || dragState !== null) return null;
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
  }, [hoverXRatio, dragState, windowStart, windowEnd, noDataRanges, points]);

  const clientXToPlot = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: PAD_LEFT, ratio: 0, ts: windowStart };
      const rect = canvas.getBoundingClientRect();
      const rawX = clientX - rect.left;
      const plotW = Math.max(40, width - PAD_LEFT - PAD_RIGHT);
      const clampedX = Math.min(PAD_LEFT + plotW, Math.max(PAD_LEFT, rawX));
      const ratio = (clampedX - PAD_LEFT) / plotW;
      const span = Math.max(1, windowEnd - windowStart);
      return {
        x: clampedX,
        ratio,
        ts: Math.round(windowStart + ratio * span),
      };
    },
    [width, windowStart, windowEnd]
  );

  // Global mousemove/mouseup while dragging so releasing outside canvas commits cleanly
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
            setSelectedRange({ start, end });
          }
        } else {
          setSelectedRange(null);
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

    const plotW = Math.max(40, width - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(40, height - PAD_TOP - PAD_BOTTOM);
    const span = Math.max(1, windowEnd - windowStart);

    // Unclamped X projection for clipped curve segments (prevents left/right edge gaps)
    const xForTimeRaw = (ts: number) => PAD_LEFT + ((ts - windowStart) / span) * plotW;

    const xForTime = (ts: number) => {
      const ratio = Math.min(1, Math.max(0, (ts - windowStart) / span));
      return PAD_LEFT + ratio * plotW;
    };

    const yForBps = (bps: number) => {
      const norm = Math.min(1, Math.max(0, bps / maxBps));
      return PAD_TOP + plotH - norm * plotH;
    };

    // Draw horizontal gridlines + Y-axis labels
    const ticks = 4;
    ctx.font = '11px "Inter", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= ticks; i++) {
      const ratio = i / ticks;
      const y = PAD_TOP + plotH - ratio * plotH;
      const val = ratio * maxBps;

      ctx.strokeStyle = theme.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();

      ctx.fillStyle = theme.axisTextColor;
      ctx.fillText(formatBandwidth(val, unit), PAD_LEFT - 10, y);
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
        ctx.moveTo(x, PAD_TOP + plotH);
        ctx.lineTo(x + plotH, PAD_TOP);
      }
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = hatchStroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (x1 > PAD_LEFT + 1) {
        ctx.beginPath();
        ctx.moveTo(x1, PAD_TOP);
        ctx.lineTo(x1, PAD_TOP + plotH);
        ctx.stroke();
      }
      if (x2 < PAD_LEFT + plotW - 1) {
        ctx.beginPath();
        ctx.moveTo(x2, PAD_TOP);
        ctx.lineTo(x2, PAD_TOP + plotH);
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
            `${formatTimestamp(range.start, effectiveLong, is24h, timeFormat)} – ${formatTimestamp(range.end, effectiveLong, is24h, timeFormat)}`,
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
      formatTimestamp(windowStart, effectiveLong, is24h, timeFormat),
      PAD_LEFT,
      PAD_TOP + plotH + 8
    );

    ctx.textAlign = 'center';
    ctx.fillText(
      formatTimestamp(windowStart + span / 2, effectiveLong, is24h, timeFormat),
      PAD_LEFT + plotW / 2,
      PAD_TOP + plotH + 8
    );

    ctx.textAlign = 'right';
    ctx.fillText(
      formatTimestamp(windowEnd, effectiveLong, is24h, timeFormat),
      PAD_LEFT + plotW,
      PAD_TOP + plotH + 8
    );

    // Empty state for the full selected window
    if (status === 'empty' || segments.length === 0) {
      ctx.fillStyle = theme.axisTextColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 13px "Inter", sans-serif';
      ctx.fillText(
        zoomRange ? 'No data in zoomed range' : `No data recorded for the last ${timeWindow}`,
        PAD_LEFT + plotW / 2,
        PAD_TOP + plotH / 2 - 9
      );
      ctx.font = '11px "Inter", sans-serif';
      ctx.fillText(
        zoomRange
          ? 'Reset zoom to return to the full time window.'
          : 'Select a different period or wait for new samples from the router agent.',
        PAD_LEFT + plotW / 2,
        PAD_TOP + plotH / 2 + 11
      );
      return;
    }

    // Build render segments, prepending leadingAnchor to the first segment so the line
    // seamlessly crosses PAD_LEFT and clips flush at the left border with zero empty gap.
    const renderSegments = segments.map((seg, idx) =>
      idx === 0 && leadingAnchor ? [leadingAnchor, ...seg] : seg
    );

    // Clip plotted series strictly to the chart plot area so anchored edges stay crisp
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.clip();

    const drawSeries = (
      accessor: (p: TrafficPoint) => number,
      strokeColor: string,
      fillTop: string,
      fillBottom: string
    ) => {
      for (const seg of renderSegments) {
        if (seg.length === 0) continue;
        if (seg.length === 1) {
          const px = xForTimeRaw(seg[0].timestamp);
          const py = yForBps(accessor(seg[0]));
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = strokeColor;
          ctx.fill();
          continue;
        }

        ctx.beginPath();
        seg.forEach((p, idx) => {
          const x = xForTimeRaw(p.timestamp);
          const y = yForBps(accessor(p));
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        const lastX = xForTimeRaw(seg[seg.length - 1].timestamp);
        const firstX = xForTimeRaw(seg[0].timestamp);
        ctx.lineTo(lastX, PAD_TOP + plotH);
        ctx.lineTo(firstX, PAD_TOP + plotH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + plotH);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, fillBottom);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    };

    if (showDownload) {
      drawSeries((p) => p.rxBps, theme.rxColor, theme.rxFillTop, theme.rxFillBottom);
    }
    if (showUpload) {
      drawSeries((p) => p.txBps, theme.txColor, theme.txFillTop, theme.txFillBottom);
    }

    ctx.restore();

    // Highlight active brush selection band with subtle side dimming + crisp handles
    if (activeSelectionRange) {
      const sx1 = xForTime(activeSelectionRange.start);
      const sx2 = xForTime(activeSelectionRange.end);
      const sw = Math.max(2, sx2 - sx1);

      ctx.save();
      ctx.fillStyle = theme.isDark ? 'rgba(0, 0, 0, 0.24)' : 'rgba(15, 23, 42, 0.06)';
      if (sx1 > PAD_LEFT) {
        ctx.fillRect(PAD_LEFT, PAD_TOP, sx1 - PAD_LEFT, plotH);
      }
      if (sx2 < PAD_LEFT + plotW) {
        ctx.fillRect(sx2, PAD_TOP, PAD_LEFT + plotW - sx2, plotH);
      }

      ctx.fillStyle = theme.isDark
        ? 'rgba(56, 189, 248, 0.14)'
        : 'rgba(2, 132, 199, 0.12)';
      ctx.fillRect(sx1, PAD_TOP, sw, plotH);

      ctx.strokeStyle = theme.rxColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx1, PAD_TOP);
      ctx.lineTo(sx1, PAD_TOP + plotH);
      ctx.moveTo(sx2, PAD_TOP);
      ctx.lineTo(sx2, PAD_TOP + plotH);
      ctx.stroke();

      const midY = PAD_TOP + plotH / 2;
      ctx.fillStyle = theme.rxColor;
      for (const ex of [sx1, sx2]) {
        ctx.beginPath();
        ctx.roundRect(ex - 2.5, midY - 12, 5, 24, 3);
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
      ctx.lineTo(hx, PAD_TOP + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (hoverInfo.point && !hoverInfo.isNoData) {
        const markers: Array<[number, string]> = [];
        if (showDownload) markers.push([yForBps(hoverInfo.point.rxBps), theme.rxColor]);
        if (showUpload) markers.push([yForBps(hoverInfo.point.txBps), theme.txColor]);
        for (const [hy, color] of markers) {
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
    displayAnalysis,
    points,
    segments,
    leadingAnchor,
    noDataRanges,
    windowStart,
    windowEnd,
    status,
    timeWindow,
    width,
    height,
    maxBps,
    hoverInfo,
    activeSelectionRange,
    zoomRange,
    unit,
    timeFormat,
    theme,
    effectiveLong,
    is24h,
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
          setSelectedRange({ start, end });
        }
      } else {
        setSelectedRange(null);
      }
      return null;
    });
  };

  const handleZoomToSelection = () => {
    if (!selectedRange) return;
    setZoomRange(selectedRange);
    setSelectedRange(null);
  };

  const handleResetZoom = () => {
    setZoomRange(null);
    setSelectedRange(null);
  };

  // Position subtle floating tooltip while hovering
  const tooltipLeftPct = hoverXRatio !== null ? Math.min(82, Math.max(18, hoverXRatio * 100)) : 50;

  return (
    <div ref={containerRef} className="relative w-full space-y-2.5">
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="throughput-chart"
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
            className="pointer-events-none absolute top-2 -translate-x-1/2 px-2.5 py-1.5 rounded-xl border app-border app-surface/95 shadow-lg text-[11px] tabular-nums flex items-center gap-2.5 whitespace-nowrap z-10"
          >
            <span className="app-text-muted">
              {formatTimestamp(
                hoverInfo.point ? hoverInfo.point.timestamp : hoverInfo.timestamp,
                effectiveLong,
                is24h,
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="legend-toggle-download"
            aria-pressed={showDownload}
            onClick={handleToggleDownload}
            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border transition-all text-xs font-medium ${
              showDownload
                ? 'app-border app-input app-text-secondary'
                : 'border-transparent app-text-muted opacity-45 hover:opacity-75'
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
            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border transition-all text-xs font-medium ${
              showUpload
                ? 'app-border app-input app-text-secondary'
                : 'border-transparent app-text-muted opacity-45 hover:opacity-75'
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

        {zoomRange && (
          <button
            type="button"
            data-testid="reset-zoom-btn"
            onClick={handleResetZoom}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border app-border app-input app-row-hover text-[11px] font-medium transition-colors"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reset Zoom
          </button>
        )}
      </div>

      {/* Structured Selected Range Inspection Panel */}
      {selectionSummary && (
        <div
          data-testid="chart-selection-inspector"
          className="rounded-xl border app-border app-input p-4 space-y-3"
        >
          {/* Panel Header: Time Span + Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b app-border">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium app-text-secondary">
                <Clock className="h-3.5 w-3.5 text-sky-500 shrink-0" aria-hidden="true" />
                Selected Range
              </span>
              <span className="font-semibold tabular-nums">
                {formatTimestamp(selectionSummary.start, effectiveLong, is24h, timeFormat)} –{' '}
                {formatTimestamp(selectionSummary.end, effectiveLong, is24h, timeFormat)}
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

            {selectedRange && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="zoom-selection-btn"
                  onClick={handleZoomToSelection}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl app-btn-primary text-xs font-semibold transition-colors"
                >
                  <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                  Zoom In
                </button>
                <button
                  type="button"
                  data-testid="clear-selection-btn"
                  onClick={() => setSelectedRange(null)}
                  aria-label="Clear selected range"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Clear
                </button>
              </div>
            )}
          </div>

          {/* Structured Download | Upload Breakdown */}
          {selectionSummary.hasData ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:divide-x app-border">
              {/* Download Summary Column */}
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

              {/* Upload Summary Column */}
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
          ) : (
            <div className="text-xs text-amber-500 font-medium py-1">
              No data recorded in this selected time range.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
