import { useEffect, useMemo, useRef, useState } from 'react';
import { clamp, eventEndSeconds, secondsToClock, trackName } from '../lib/format';
import type { LiveSFXProject, SFXEvent } from '../lib/types';

interface SFXTimelineCanvasProps {
  project: LiveSFXProject;
  currentSeconds: number;
  selectedEventId: string | null;
  selectedEventIds: string[];
  zoom: number;
  onSeek: (seconds: number) => void;
  onScrubSeconds: (deltaSeconds: number) => void;
  onZoomChange: (zoom: number) => void;
  onSelectEvent: (id: string, mode?: 'replace' | 'toggle' | 'range') => void;
  onSelectEvents: (ids: string[], primaryId?: string | null, mode?: 'replace' | 'toggle') => void;
  onClearSelection: () => void;
  onBeginTimingEdit: () => void;
  onMoveEvents: (eventIds: string[], anchorEventId: string, targetStartSeconds: number) => void;
  onResizeEvent: (eventId: string, edge: 'left' | 'right', targetSeconds: number) => void;
  onEndTimingEdit: () => void;
  focusPlayheadSignal: number;
  waveformByPath: Record<string, number[]>;
}

const LANE_HEIGHT = 60;
const HEADER_WIDTH = 154;
const TOP_RULER = 36;
const MIN_ZOOM = 24;
const MAX_ZOOM = 180;
const SCRUB_SECONDS_PER_PIXEL = 0.012;

type HitRegion = { id: string; x: number; y: number; w: number; h: number };
type EventHitRegion = HitRegion & { kind: 'body' | 'left-edge' | 'right-edge' };
type SelectionRect = { startX: number; startY: number; endX: number; endY: number } | null;
type EventBodyDrag = {
  eventId: string;
  eventIds: string[];
  didMove: boolean;
  pointerOffsetSeconds: number;
  startClientX: number;
};
type EventResizeDrag = {
  eventId: string;
  edge: 'left' | 'right';
  didMove: boolean;
  startClientX: number;
};

function rgbaFromHex(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return `rgba(147, 168, 214, ${alpha})`;
  const value = Number.parseInt(raw, 16);
  if (!Number.isFinite(value)) return `rgba(147, 168, 214, ${alpha})`;
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizeWheelDelta(event: React.WheelEvent): { x: number; y: number } {
  const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 240 : 1;
  return { x: event.deltaX * scale, y: event.deltaY * scale };
}

export function SFXTimelineCanvas({
  project,
  currentSeconds,
  selectedEventId,
  selectedEventIds,
  zoom,
  onSeek,
  onScrubSeconds,
  onZoomChange,
  onSelectEvent,
  onSelectEvents,
  onClearSelection,
  onBeginTimingEdit,
  onMoveEvents,
  onResizeEvent,
  onEndTimingEdit,
  focusPlayheadSignal,
  waveformByPath,
}: SFXTimelineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const hitRegions = useRef<EventHitRegion[]>([]);
  const draggingRuler = useRef(false);
  const draggingEvent = useRef<EventBodyDrag | null>(null);
  const resizingEvent = useRef<EventResizeDrag | null>(null);
  const boxSelecting = useRef(false);
  const selectionRectRef = useRef<SelectionRect>(null);
  const tracks = useMemo(() => {
    const count = Math.max(5, ...project.events.map((event) => event.track), 1);
    return Array.from({ length: Math.min(24, count) }, (_, index) => index + 1);
  }, [project.events]);
  const canvasHeight = TOP_RULER + LANE_HEIGHT * tracks.length;
  const [scrollLeft, setScrollLeft] = useState(0);
  const [selectionRect, setSelectionRect] = useState<SelectionRect>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [cursor, setCursor] = useState('crosshair');
  const width = useMemo(() => Math.max(1400, HEADER_WIDTH + project.duration * zoom + 340), [project.duration, zoom]);
  const latest = useRef({
    currentSeconds,
    project,
    scrollLeft,
    selectedEventId,
    selectedEventIds,
    tracks,
    viewportWidth,
    zoom,
    waveformByPath,
    canvasHeight,
  });

  latest.current = { currentSeconds, project, scrollLeft, selectedEventId, selectedEventIds, tracks, viewportWidth, zoom, waveformByPath, canvasHeight };

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      setViewportWidth(Math.max(320, scroller.clientWidth));
      setScrollLeft(scroller.scrollLeft);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    scroller.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    let animationFrame = 0;
    const render = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        drawTimeline(canvas, ctx, latest.current, hitRegions.current);
        drawSelectionRect(ctx, selectionRect);
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [selectionRect]);

  useEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;
    const centerPlayhead = () => keepPlayheadVisible(latest.current.currentSeconds, true);
    firstFrame = window.requestAnimationFrame(() => {
      centerPlayhead();
      secondFrame = window.requestAnimationFrame(centerPlayhead);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [focusPlayheadSignal, project.events.length, project.name]);

  function contentXToSeconds(x: number): number {
    return clamp((x + latest.current.scrollLeft - HEADER_WIDTH) / latest.current.zoom, 0, latest.current.project.duration);
  }

  function hitTest(x: number, y: number): EventHitRegion | undefined {
    for (let index = hitRegions.current.length - 1; index >= 0; index -= 1) {
      const region = hitRegions.current[index];
      if (x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h) {
        return region;
      }
    }
    return undefined;
  }

  function keepPlayheadVisible(seconds: number, center: boolean) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const playheadX = HEADER_WIDTH + seconds * latest.current.zoom;
    const leftGuard = scroller.scrollLeft + HEADER_WIDTH + 84;
    const rightGuard = scroller.scrollLeft + scroller.clientWidth - 120;

    if (center) {
      scroller.scrollTo({ left: Math.max(0, playheadX - scroller.clientWidth * 0.42), behavior: 'auto' });
      return;
    }
    if (playheadX > rightGuard) {
      scroller.scrollTo({ left: Math.max(0, playheadX - scroller.clientWidth * 0.38), behavior: 'auto' });
    } else if (playheadX < leftGuard) {
      scroller.scrollTo({ left: Math.max(0, playheadX - HEADER_WIDTH - 120), behavior: 'auto' });
    }
  }

  function seekFromPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x <= HEADER_WIDTH) return;
    const seconds = contentXToSeconds(x);
    onSeek(seconds);
    keepPlayheadVisible(seconds, false);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitTest(x, y);
    if (hit) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const existingSelectedIds = latest.current.selectedEventIds;
      const useExistingSelection = !event.shiftKey && !event.metaKey && existingSelectedIds.includes(hit.id);
      const eventIds = useExistingSelection ? existingSelectedIds : [hit.id];
      if (useExistingSelection) {
        onSelectEvents(eventIds, hit.id, 'replace');
      } else {
        onSelectEvent(hit.id, event.shiftKey ? 'range' : event.metaKey ? 'toggle' : 'replace');
      }
      const sfxEvent = latest.current.project.events.find((item) => item.id === hit.id);
      if (sfxEvent && hit.kind !== 'body' && !event.shiftKey && !event.metaKey) {
        resizingEvent.current = {
          eventId: hit.id,
          edge: hit.kind === 'left-edge' ? 'left' : 'right',
          didMove: false,
          startClientX: event.clientX,
        };
        onBeginTimingEdit();
      } else if (sfxEvent && !event.shiftKey && !event.metaKey) {
        draggingEvent.current = {
          eventId: hit.id,
          eventIds,
          didMove: false,
          pointerOffsetSeconds: contentXToSeconds(x) - sfxEvent.startSeconds,
          startClientX: event.clientX,
        };
        onBeginTimingEdit();
      }
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    if (y <= TOP_RULER) {
      draggingRuler.current = true;
      seekFromPointer(event);
      return;
    }
    if (x > HEADER_WIDTH) {
      boxSelecting.current = true;
      const next = { startX: x, startY: y, endX: x, endY: y };
      selectionRectRef.current = next;
      setSelectionRect(next);
      return;
    }
    onClearSelection();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (resizingEvent.current) {
      event.preventDefault();
      if (Math.abs(event.clientX - resizingEvent.current.startClientX) > 2) {
        resizingEvent.current.didMove = true;
      }
      onResizeEvent(resizingEvent.current.eventId, resizingEvent.current.edge, contentXToSeconds(x));
      return;
    }
    if (draggingEvent.current) {
      event.preventDefault();
      if (Math.abs(event.clientX - draggingEvent.current.startClientX) > 3) {
        draggingEvent.current.didMove = true;
      }
      if (draggingEvent.current.didMove) {
        const targetStartSeconds = contentXToSeconds(x) - draggingEvent.current.pointerOffsetSeconds;
        onMoveEvents(draggingEvent.current.eventIds, draggingEvent.current.eventId, targetStartSeconds);
      }
      return;
    }
    if (draggingRuler.current) {
      seekFromPointer(event);
      return;
    }
    if (boxSelecting.current) {
      const next = selectionRectRef.current ? { ...selectionRectRef.current, endX: x, endY: y } : null;
      selectionRectRef.current = next;
      setSelectionRect(next);
      return;
    }
    const hoverHit = hitTest(x, y);
    const nextCursor = hoverHit?.kind === 'left-edge' || hoverHit?.kind === 'right-edge'
      ? 'ew-resize'
      : hoverHit?.kind === 'body'
        ? 'grab'
        : y <= TOP_RULER
          ? 'col-resize'
          : 'crosshair';
    if (nextCursor !== cursor) setCursor(nextCursor);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (resizingEvent.current) {
      resizingEvent.current = null;
      onEndTimingEdit();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (draggingEvent.current) {
      draggingEvent.current = null;
      onEndTimingEdit();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const finalSelectionRect = selectionRectRef.current;
    if (boxSelecting.current && finalSelectionRect) {
      const rect = normalizedRect(finalSelectionRect);
      const hits = hitRegions.current
        .filter((region) => region.kind === 'body' && rectsOverlap(rect, region))
        .sort((a, b) => {
          const eventA = latest.current.project.events.find((item) => item.id === a.id);
          const eventB = latest.current.project.events.find((item) => item.id === b.id);
          return (eventA?.startSeconds ?? 0) - (eventB?.startSeconds ?? 0);
        })
        .map((region) => region.id);
      if (hits.length > 0) {
        onSelectEvents(hits, hits[0] ?? null, event.metaKey ? 'toggle' : 'replace');
      } else {
        onClearSelection();
      }
    }
    draggingRuler.current = false;
    boxSelecting.current = false;
    selectionRectRef.current = null;
    setSelectionRect(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const delta = normalizeWheelDelta(event);
    if (event.ctrlKey) {
      event.preventDefault();
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const anchorSeconds = clamp((scroller.scrollLeft + pointerX - HEADER_WIDTH) / latest.current.zoom, 0, latest.current.project.duration);
      const factor = Math.exp(-delta.y * 0.004);
      const nextZoom = clamp(latest.current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      onZoomChange(nextZoom);
      window.requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(0, HEADER_WIDTH + anchorSeconds * nextZoom - pointerX);
      });
      return;
    }
    if (Math.abs(delta.y) >= Math.abs(delta.x)) {
      event.preventDefault();
      const deltaSeconds = delta.y * SCRUB_SECONDS_PER_PIXEL;
      const next = clamp(latest.current.currentSeconds + deltaSeconds, 0, latest.current.project.duration);
      onScrubSeconds(next - latest.current.currentSeconds);
      keepPlayheadVisible(next, false);
    }
  }

  return (
    <div className="timeline-scroller" ref={scrollerRef} onWheel={handleWheel}>
      <div className="timeline-content" style={{ width, height: canvasHeight }}>
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          tabIndex={0}
          aria-label="SFX timeline"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{ cursor }}
        />
      </div>
    </div>
  );
}

function worldX(seconds: number, zoom: number, scrollLeft: number): number {
  return HEADER_WIDTH + seconds * zoom - scrollLeft;
}

function drawTimeline(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  state: {
    currentSeconds: number;
    project: LiveSFXProject;
    scrollLeft: number;
    selectedEventId: string | null;
    selectedEventIds: string[];
    tracks: number[];
    viewportWidth: number;
    zoom: number;
    waveformByPath: Record<string, number[]>;
    canvasHeight: number;
  },
  hitRegions: EventHitRegion[],
) {
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.floor(state.viewportWidth * dpr));
  const targetHeight = Math.floor(state.canvasHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.style.width = `${state.viewportWidth}px`;
    canvas.style.height = `${state.canvasHeight}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.viewportWidth, state.canvasHeight);
  hitRegions.length = 0;

  drawBackground(ctx, state.viewportWidth, state.project.duration, state.zoom, state.scrollLeft, state.tracks, state.canvasHeight);
  drawZoomMarkers(ctx, state.project.zoomMarkers, state.zoom, state.scrollLeft, state.viewportWidth, state.canvasHeight);
  drawEvents(ctx, state.project.events, state.selectedEventId, state.selectedEventIds, state.zoom, state.scrollLeft, state.viewportWidth, state.tracks, state.waveformByPath, hitRegions);
  drawPlayhead(ctx, state.currentSeconds, state.zoom, state.scrollLeft, state.viewportWidth, state.canvasHeight);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  duration: number,
  zoom: number,
  scrollLeft: number,
  tracks: number[],
  canvasHeight: number,
) {
  ctx.fillStyle = '#080809';
  ctx.fillRect(0, 0, width, canvasHeight);
  ctx.fillStyle = 'rgba(16, 17, 21, 0.96)';
  ctx.fillRect(0, 0, width, TOP_RULER);

  const tickEvery = zoom > 110 ? 1 : zoom > 56 ? 2 : 5;
  const startSecond = Math.max(0, Math.floor((scrollLeft - HEADER_WIDTH) / zoom / tickEvery) * tickEvery);
  const endSecond = Math.min(duration + 10, Math.ceil((scrollLeft + width - HEADER_WIDTH) / zoom / tickEvery) * tickEvery);
  ctx.font = '10px JetBrains Mono, monospace';
  for (let second = startSecond; second <= endSecond; second += tickEvery) {
    const x = worldX(second, zoom, scrollLeft);
    ctx.strokeStyle = second % 10 === 0 ? 'rgba(85, 111, 212, 0.22)' : 'rgba(85, 111, 212, 0.08)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
    if (second % 10 === 0 && zoom > 34) {
      ctx.fillStyle = 'rgba(222, 228, 252, 0.58)';
      ctx.fillText(secondsToClock(second), x + 6, 20);
    }
  }

  tracks.forEach((track, index) => {
    const y = TOP_RULER + index * LANE_HEIGHT;
    const even = track % 2 === 0;
    ctx.fillStyle = even ? 'rgba(23, 30, 48, 0.18)' : 'rgba(31, 28, 54, 0.16)';
    ctx.fillRect(0, y, width, LANE_HEIGHT - 6);
    ctx.strokeStyle = even ? 'rgba(71, 103, 205, 0.42)' : 'rgba(88, 88, 180, 0.38)';
    ctx.strokeRect(0.5, y + 0.5, width - 1, LANE_HEIGHT - 7);

    ctx.fillStyle = 'rgba(9, 10, 13, 0.96)';
    ctx.fillRect(0, y, HEADER_WIDTH, LANE_HEIGHT - 6);
    ctx.fillStyle = 'rgba(136, 154, 239, 0.62)';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.fillText(trackName(track), 16, y + 20);
    ctx.fillStyle = 'rgba(222, 228, 252, 0.42)';
    ctx.fillText(`${track - 1} overlaps`, 16, y + 39);
  });
}

function drawZoomMarkers(
  ctx: CanvasRenderingContext2D,
  markers: LiveSFXProject['zoomMarkers'],
  zoom: number,
  scrollLeft: number,
  viewportWidth: number,
  canvasHeight: number,
) {
  if (markers.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(HEADER_WIDTH, 0, Math.max(0, viewportWidth - HEADER_WIDTH), canvasHeight);
  ctx.clip();
  ctx.font = '10px JetBrains Mono, monospace';
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const x = worldX(marker.startSeconds, zoom, scrollLeft);
    const endX = worldX(marker.endSeconds, zoom, scrollLeft);
    const w = Math.max(5, endX - x);
    if (x + w < HEADER_WIDTH || x > viewportWidth + 24) continue;
    const strong = zoom >= 52;
    ctx.fillStyle = 'rgba(255, 198, 86, 0.075)';
    ctx.fillRect(x, TOP_RULER, w, canvasHeight - TOP_RULER);
    ctx.strokeStyle = 'rgba(255, 205, 92, 0.78)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvasHeight);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255, 205, 92, 0.95)';
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
    if (strong) {
      ctx.fillStyle = 'rgba(255, 231, 175, 0.82)';
      ctx.fillText(`ZOOM ${index + 1}`, x + 6, 8);
    }
  }
  ctx.restore();
}

function drawEvents(
  ctx: CanvasRenderingContext2D,
  events: SFXEvent[],
  selectedEventId: string | null,
  selectedEventIds: string[],
  zoom: number,
  scrollLeft: number,
  viewportWidth: number,
  tracks: number[],
  waveformByPath: Record<string, number[]>,
  hitRegions: EventHitRegion[],
) {
  const selectedSet = new Set(selectedEventIds);
  const compact = zoom < 44;
  const medium = zoom >= 44 && zoom < 82;
  ctx.textBaseline = 'top';
  ctx.save();
  ctx.beginPath();
  ctx.rect(HEADER_WIDTH, TOP_RULER, Math.max(0, viewportWidth - HEADER_WIDTH), TOP_RULER + tracks.length * LANE_HEIGHT);
  ctx.clip();

  for (const event of events) {
    const trackIndex = tracks.indexOf(event.track);
    if (trackIndex < 0) continue;
    const x = worldX(event.startSeconds, zoom, scrollLeft);
    const actualW = Math.max(0, (eventEndSeconds(event.startSeconds, event.duration) - event.startSeconds) * zoom);
    const selected = event.id === selectedEventId || selectedSet.has(event.id);
    const minVisualW = selected ? 20 : compact ? 8 : 12;
    const w = Math.max(minVisualW, actualW);
    if (x + w < HEADER_WIDTH || x > viewportWidth + 24) continue;
    const tiny = actualW < 48;
    const h = compact ? 24 : medium ? 29 : 36;
    const y = TOP_RULER + trackIndex * LANE_HEIGHT + Math.round((LANE_HEIGHT - h - 6) / 2);
    const radius = 4;

    ctx.shadowColor = selected ? 'rgba(80, 115, 255, 0.34)' : 'rgba(0,0,0,0.32)';
    ctx.shadowBlur = selected ? 11 : compact ? 0 : 3;
    const fill = ctx.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, selected ? rgbaFromHex(event.color, 0.30) : rgbaFromHex(event.color, tiny ? 0.24 : 0.18));
    fill.addColorStop(1, 'rgba(7, 8, 12, 0.96)');
    ctx.fillStyle = fill;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = selected ? 'rgba(125, 150, 255, 0.98)' : rgbaFromHex(event.color, 0.82);
    ctx.lineWidth = selected ? 2 : 1.25;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = event.color;
    ctx.fillRect(x + 3, y + 3, Math.max(2, w - 6), 2);
    const waveformPeaks = event.waveformPeaks?.length ? event.waveformPeaks : waveformByPath[event.filePath];
    if (waveformPeaks?.length && w > 12) {
      drawEventWaveform(ctx, event, waveformPeaks, x, y, w, h);
    }
    if (selected) {
      ctx.strokeStyle = 'rgba(210, 220, 255, 0.82)';
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 8);
      ctx.lineTo(x + 5, y + h - 8);
      ctx.moveTo(x + w - 5, y + 8);
      ctx.lineTo(x + w - 5, y + h - 8);
      ctx.stroke();
    }
    if (event.audibleOffsetSeconds > 0.002) {
      const onsetX = x + event.audibleOffsetSeconds * zoom;
      if (onsetX >= x && onsetX <= x + w) {
        ctx.strokeStyle = event.snapZoomId ? 'rgba(255, 229, 132, 0.96)' : 'rgba(245, 247, 255, 0.72)';
        ctx.beginPath();
        ctx.moveTo(onsetX, y + 5);
        ctx.lineTo(onsetX, y + h - 5);
        ctx.stroke();
      }
    }

    if (!tiny) {
      ctx.font = compact ? '10px ui-sans-serif, system-ui' : '11px ui-sans-serif, system-ui';
      ctx.fillStyle = selected ? 'rgba(245, 247, 255, 0.96)' : rgbaFromHex(event.color, 0.96);
      const title = `${event.categoryName}${Math.abs(event.playbackRate - 1) > 0.01 ? ` ${event.playbackRate.toFixed(3)}x` : ''}`;
      const text = truncate(ctx, title, Math.max(18, w - 16));
      if (text) ctx.fillText(text, x + 9, y + (compact ? 8 : 7));
      if (!compact && w > 92) {
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(222, 228, 252, 0.54)';
        ctx.fillText(truncate(ctx, event.fileName, Math.max(16, w - 18)), x + 9, y + 22);
      }
    }

    const hitW = Math.max(w, 10);
    const hitX = x - Math.max(0, hitW - w) / 2;
    const edgeW = Math.min(12, Math.max(6, hitW * 0.25));
    hitRegions.push({ id: event.id, kind: 'body', x: hitX, y, w: hitW, h });
    hitRegions.push({ id: event.id, kind: 'left-edge', x: hitX, y, w: edgeW, h });
    hitRegions.push({ id: event.id, kind: 'right-edge', x: hitX + hitW - edgeW, y, w: edgeW, h });
  }

  ctx.restore();
}

function drawEventWaveform(ctx: CanvasRenderingContext2D, event: SFXEvent, peaks: number[], x: number, y: number, w: number, h: number) {
  const rate = Math.max(0.001, event.playbackRate || 1);
  const sourceDuration = Math.max(0.001, (event.baseDuration || event.duration) * rate);
  const sourceStart = clamp(event.sourceOffsetSeconds || 0, 0, sourceDuration);
  const sourceEnd = clamp(sourceStart + event.duration * rate, sourceStart + 0.001, sourceDuration);
  const visibleRatioStart = sourceStart / sourceDuration;
  const visibleRatioEnd = sourceEnd / sourceDuration;
  const innerX = x + 7;
  const innerW = Math.max(1, w - 14);
  const centerY = y + h * 0.58;
  const maxH = Math.max(4, h * 0.32);
  const bars = Math.max(4, Math.min(96, Math.floor(innerW / 3)));

  ctx.save();
  roundRect(ctx, x + 1, y + 4, Math.max(1, w - 2), Math.max(1, h - 5), 3);
  ctx.clip();
  ctx.strokeStyle = rgbaFromHex(event.color, 0.66);
  ctx.lineWidth = Math.max(1, Math.min(2, innerW / 220));
  for (let bar = 0; bar < bars; bar += 1) {
    const ratioA = visibleRatioStart + (bar / bars) * (visibleRatioEnd - visibleRatioStart);
    const ratioB = visibleRatioStart + ((bar + 1) / bars) * (visibleRatioEnd - visibleRatioStart);
    const startIndex = clamp(Math.floor(ratioA * peaks.length), 0, Math.max(0, peaks.length - 1));
    const endIndex = clamp(Math.ceil(ratioB * peaks.length), startIndex + 1, peaks.length);
    let peak = 0;
    for (let index = startIndex; index < endIndex; index += 1) {
      peak = Math.max(peak, peaks[index] || 0);
    }
    const barX = innerX + (bar / Math.max(1, bars - 1)) * innerW;
    const barH = Math.max(1.5, Math.min(1, peak) * maxH);
    ctx.beginPath();
    ctx.moveTo(barX, centerY - barH);
    ctx.lineTo(barX, centerY + barH);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayhead(ctx: CanvasRenderingContext2D, seconds: number, zoom: number, scrollLeft: number, viewportWidth: number, canvasHeight: number) {
  const x = worldX(seconds, zoom, scrollLeft);
  if (x < HEADER_WIDTH || x > viewportWidth) return;
  ctx.strokeStyle = 'rgba(255, 57, 76, 0.98)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvasHeight);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255, 57, 76, 0.98)';
  ctx.beginPath();
  ctx.moveTo(x - 7, 0);
  ctx.lineTo(x + 7, 0);
  ctx.lineTo(x, 11);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 225, 229, 0.88)';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(secondsToClock(seconds), x + 7, 20);
}

function normalizedRect(rect: NonNullable<SelectionRect>): { x: number; y: number; w: number; h: number } {
  const x = Math.min(rect.startX, rect.endX);
  const y = Math.min(rect.startY, rect.endY);
  return { x, y, w: Math.abs(rect.endX - rect.startX), h: Math.abs(rect.endY - rect.startY) };
}

function rectsOverlap(left: { x: number; y: number; w: number; h: number }, right: { x: number; y: number; w: number; h: number }): boolean {
  return left.x <= right.x + right.w && left.x + left.w >= right.x && left.y <= right.y + right.h && left.y + left.h >= right.y;
}

function drawSelectionRect(ctx: CanvasRenderingContext2D, selectionRect: SelectionRect) {
  if (!selectionRect) return;
  const rect = normalizedRect(selectionRect);
  if (rect.w < 2 && rect.h < 2) return;
  ctx.save();
  ctx.fillStyle = 'rgba(88, 122, 226, 0.16)';
  ctx.strokeStyle = 'rgba(112, 141, 245, 0.78)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
  ctx.restore();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (output.length > 1 && ctx.measureText(`${output}...`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return output.length > 1 ? `${output}...` : '';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
