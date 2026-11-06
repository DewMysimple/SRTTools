import { memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type Ref } from 'react';
import type { SubtitleCue } from '../../core/models';
import { formatTimestamp, parseTimestamp } from '../../core/time';
import { errorText } from '../../components/common';
import type { CueIndex } from './core/cue-index';
import { fitScale, getTimeTicks, MIN_SPAN_MS, msToX, scrollGeometry, tickInterval, xToMs, zoomAround } from './core/coordinates';
import { timeChanges, type EditMode } from './core/editing-session';
import type { layoutCues } from './core/interval-layout';

const RULER_HEIGHT = 28;
const LANE_HEIGHT = 34;
const MIN_BLOCK_WIDTH = 24;
const MOVE_THRESHOLD_PX = 3;
const SNAP_DISTANCE_PX = 8;

interface Drag {
  pointerId: number;
  x: number;
  viewportStartMs: number;
  pixelsPerSecond: number;
  cue: SubtitleCue;
  targets: SubtitleCue[];
  mode: EditMode;
  boundaries: number[];
}

interface Preview {
  changes: SubtitleCue[];
  error?: string;
  snapMs?: number;
}

export interface TimelineViewHandle {
  reveal: (timeMs: number, cueId?: string) => void;
}

interface Props {
  ref?: Ref<TimelineViewHandle>;
  index: CueIndex;
  layout: ReturnType<typeof layoutCues>;
  numbers: ReadonlyMap<string, number>;
  selectedIds: readonly string[];
  playheadMs: number;
  disabled: boolean;
  editDisabled: boolean;
  onSelect: (id: string, extend: boolean, range: boolean) => void;
  onCommit: (changes: SubtitleCue[]) => void;
  onSeek: (timeMs: number) => void;
  onError: (message: string) => void;
}

function nearestBoundary(sorted: readonly number[], time: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  const before = sorted[lo - 1] ?? -Infinity;
  const after = sorted[lo] ?? Infinity;
  return time - before <= after - time ? before : after;
}

function projectDrag(drag: Drag, clientX: number, startMs: number, snap: boolean): Preview {
  let delta = Math.round((clientX - drag.x) * 1000 / drag.pixelsPerSecond + startMs - drag.viewportStartMs);
  let snapMs: number | undefined;
  if (snap) {
    const tick = tickInterval(drag.pixelsPerSecond);
    const edges = drag.mode === 'move'
      ? [drag.cue.startMs, drag.cue.endMs] : [drag.mode === 'trim-start' ? drag.cue.startMs : drag.cue.endMs];
    let best = SNAP_DISTANCE_PX * 1000 / drag.pixelsPerSecond;
    let correction = 0;
    for (const edge of edges) {
      const time = edge + delta;
      for (const target of [nearestBoundary(drag.boundaries, time), Math.round(time / tick) * tick]) {
        const distance = Math.abs(target - time);
        if (target >= 0 && distance <= best) {
          best = distance;
          snapMs = target;
          correction = target - time;
        }
      }
    }
    delta += correction;
  }
  try {
    return { changes: timeChanges(drag.targets, drag.mode, delta), snapMs };
  } catch (problem) {
    return { changes: [], error: errorText(problem) };
  }
}

export const TimelineView = memo(function TimelineView({
  ref, index, layout, numbers, selectedIds, playheadMs, disabled, editDisabled, onSelect, onCommit, onSeek, onError,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const activeDrag = useRef<Drag | null>(null);
  const seekPointer = useRef<number | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [scale, setScale] = useState<number>();
  const [height, setHeight] = useState(154);
  const [snap, setSnap] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [jump, setJump] = useState('');
  const { width } = dimensions;
  const durationMs = Math.max(index.endMs, MIN_SPAN_MS);
  const fitted = fitScale(durationMs, width);
  const pixelsPerSecond = Math.max(fitted, scale ?? fitted);
  const rail = scrollGeometry(durationMs, pixelsPerSecond, width);
  const viewport = { startMs: rail.toTime(scroll.left), pixelsPerSecond };
  const endMs = Math.min(durationMs, viewport.startMs + width * 1000 / pixelsPerSecond);
  const trackHeight = Math.max(dimensions.height, RULER_HEIGHT + Math.max(1, layout.laneCount) * LANE_HEIGHT + 8);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setDimensions({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scroller.current) {
      scroller.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  });

  useImperativeHandle(ref, () => ({
    reveal(timeMs, cueId) {
      const element = scroller.current;
      if (!element) return;
      const x = msToX(timeMs, viewport);
      if (x < 0 || x > width - MIN_BLOCK_WIDTH) {
        element.scrollLeft = rail.toScroll(timeMs - width * 250 / pixelsPerSecond);
      }
      const lane = cueId === undefined ? undefined : layout.lanes.get(cueId);
      if (lane !== undefined) {
        const y = RULER_HEIGHT + lane * LANE_HEIGHT;
        if (y < element.scrollTop + RULER_HEIGHT || y + LANE_HEIGHT > element.scrollTop + dimensions.height) {
          element.scrollTop = Math.max(0, y - RULER_HEIGHT);
        }
      }
    },
  }));

  function cancelPointer() {
    const pointerId = activeDrag.current?.pointerId ?? seekPointer.current;
    activeDrag.current = null;
    seekPointer.current = null;
    setPreview(undefined);
    if (pointerId !== null && surface.current?.hasPointerCapture(pointerId)) surface.current.releasePointerCapture(pointerId);
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (activeDrag.current || seekPointer.current !== null)) {
        event.preventDefault();
        event.stopPropagation();
        cancelPointer();
      }
    };
    window.addEventListener('blur', cancelPointer);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('blur', cancelPointer);
      window.removeEventListener('keydown', escape, true);
    };
  }, []);

  function zoom(factor: number, anchor: number) {
    if (activeDrag.current) return;
    const next = zoomAround(viewport, factor, anchor, durationMs, width);
    const nextLeft = scrollGeometry(durationMs, next.pixelsPerSecond, width).toScroll(next.startMs);
    pendingScroll.current = nextLeft;
    setScale(next.pixelsPerSecond);
    setScroll(current => ({ ...current, left: nextLeft }));
  }

  useEffect(() => {
    const element = scroller.current;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !element) return;
      event.preventDefault();
      const anchor = Math.max(0, Math.min(width, event.clientX - element.getBoundingClientRect().left));
      zoom(event.deltaY < 0 ? 1.25 : 0.8, anchor);
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  });

  function seekAt(clientX: number) {
    if (!surface.current || !scroller.current) return;
    const x = Math.max(0, Math.min(width, clientX - surface.current.getBoundingClientRect().left));
    const time = xToMs(x, { startMs: rail.toTime(scroller.current.scrollLeft), pixelsPerSecond });
    onSeek(Number.isNaN(time) ? durationMs : Math.min(durationMs, time));
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || activeDrag.current || seekPointer.current !== null) return;
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-cue-mode]') : null;
    const cue = target && visibleById.get(target.dataset.cueId ?? '');
    if (!cue || !target) {
      if (!disabled) {
        seekPointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        seekAt(event.clientX);
      }
      return;
    }
    if (disabled || target.disabled) return;
    target.focus({ preventScroll: true });
    if (editDisabled || event.ctrlKey || event.shiftKey || event.metaKey) {
      onSelect(cue.id, event.ctrlKey || event.metaKey, event.shiftKey);
      return;
    }
    const mode = target.dataset.cueMode as EditMode;
    if (!selectedIds.includes(cue.id)) onSelect(cue.id, false, false);
    const targets = mode === 'move' && selectedIds.includes(cue.id)
      ? index.sorted.filter(item => selected.has(item.id)) : [cue];
    const targetIds = new Set(targets.map(item => item.id));
    const boundaries = snap ? index.sorted.filter(item => !targetIds.has(item.id))
      .flatMap(item => [item.startMs, item.endMs]).sort((a, b) => a - b) : [];
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDrag.current = { pointerId: event.pointerId, x: event.clientX, viewportStartMs: viewport.startMs, pixelsPerSecond, cue, targets, mode, boundaries };
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (seekPointer.current === event.pointerId) seekAt(event.clientX);
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.x) < MOVE_THRESHOLD_PX && !preview) return;
    setPreview(projectDrag(drag, event.clientX, rail.toTime(scroller.current?.scrollLeft ?? 0), snap));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (seekPointer.current === event.pointerId) {
      seekAt(event.clientX);
      cancelPointer();
      return;
    }
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const startMs = rail.toTime(scroller.current?.scrollLeft ?? 0);
    const changed = Math.abs(event.clientX - drag.x) >= MOVE_THRESHOLD_PX || startMs !== drag.viewportStartMs;
    cancelPointer();
    if (!changed) {
      onSelect(drag.cue.id, false, false);
      return;
    }
    const result = projectDrag(drag, event.clientX, startMs, snap);
    if (result.error) onError(result.error);
    else onCommit(result.changes);
  }

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(
    () => index.visible(viewport.startMs - 36_000 / pixelsPerSecond, endMs + 36_000 / pixelsPerSecond),
    [index, viewport.startMs, endMs, pixelsPerSecond],
  );
  // Fit can place thousands of adjacent cues into a single screen. Keep one
  // representative per clickable slot and always expose the focused cue.
  const changedCues = new Set(preview?.changes.map(cue => cue.id));
  const slots = new Map<string, SubtitleCue>();
  let condensed = 0;
  for (const cue of [...visible.filter(cue => !changedCues.has(cue.id)), ...(preview?.changes ?? [])]) {
    const lane = layout.lanes.get(cue.id) ?? 0;
    const top = RULER_HEIGHT + lane * LANE_HEIGHT;
    if (top + LANE_HEIGHT < scroll.top || top > scroll.top + dimensions.height + LANE_HEIGHT) continue;
    const left = msToX(cue.startMs, viewport);
    if (left >= width || Math.max(left + MIN_BLOCK_WIDTH, msToX(cue.endMs, viewport)) <= 0) continue;
    const slot = `${lane}:${Math.floor(Math.max(0, left) / MIN_BLOCK_WIDTH)}`;
    const previous = slots.get(slot);
    if (previous) condensed++;
    if (!previous || cue.id === selectedIds.at(-1)) slots.set(slot, cue);
  }
  const visibleById = new Map(Array.from(slots.values(), cue => [cue.id, cue]));
  const ticks = getTimeTicks(viewport.startMs, endMs, pixelsPerSecond);
  const playheadX = msToX(playheadMs, viewport);
  const snapX = preview?.snapMs === undefined ? -1 : msToX(preview.snapMs, viewport);

  return <section className="timeline-card timeline-track" aria-label="字幕时间轨道">
    <div className="timeline-controls">
      <h2>时间轴</h2>
      <div className="button-row" role="group" aria-label="时间轴缩放">
        <button type="button" className="button secondary small" aria-label="缩小时间轴" onClick={() => zoom(0.8, width / 2)}>−</button>
        <button type="button" className="button secondary small" aria-label="放大时间轴" onClick={() => zoom(1.25, width / 2)}>＋</button>
        <button type="button" className="button secondary small" onClick={() => { pendingScroll.current = 0; setScale(undefined); setScroll(current => ({ ...current, left: 0 })); }}>拟合全部</button>
      </div>
      <label className="timeline-check"><input type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />时间吸附</label>
      <label className="timeline-slider">轨道高度<input type="range" min={120} max={310} value={height} onChange={event => setHeight(Number(event.target.value))} /></label>
      <form className="timeline-jump" onSubmit={event => {
        event.preventDefault();
        try {
          const time = parseTimestamp(jump);
          if (time > durationMs) throw new Error('跳转时间超出当前时间轴范围。');
          onSeek(time);
          if (scroller.current) scroller.current.scrollLeft = rail.toScroll(time - width * 250 / pixelsPerSecond);
        } catch (problem) { onError(errorText(problem)); }
      }}>
        <input value={jump} onChange={event => setJump(event.target.value)} aria-label="跳转到时间" placeholder="00:00:00.000" />
        <button type="submit" className="button secondary small" disabled={disabled}>跳转</button>
      </form>
    </div>
    <div className="timeline-viewport" aria-label="可滚动字幕时间轴" tabIndex={0} ref={scroller} style={{ height }} onScroll={event => {
      setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
    }}>
      <div className="timeline-rail" style={{ width: rail.contentWidth, height: trackHeight }}>
        <div ref={surface} className="timeline-surface" style={{ width, height: trackHeight }}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
          onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}>
          <div className="timeline-ruler" aria-label="时间刻度">
            {ticks.map(time => <span className="timeline-tick" key={time} style={{ left: msToX(time, viewport) }}>{formatTimestamp(time, '.')}</span>)}
          </div>
          {Array.from(slots.values(), cue => {
            const number = numbers.get(cue.id);
            const left = msToX(cue.startMs, viewport);
            const widthPx = Math.max(MIN_BLOCK_WIDTH, msToX(cue.endMs, viewport) - left);
            const overlap = layout.overlapping.has(cue.id);
            const chosen = selected.has(cue.id);
            const label = `字幕 ${number}`;
            const props = { 'data-cue-id': cue.id, disabled };
            return <div key={cue.id} className={`timeline-cue${chosen ? ' selected' : ''}${overlap ? ' overlap' : ''}`}
              style={{ left: Math.max(-MIN_BLOCK_WIDTH, left), width: Math.min(width + MIN_BLOCK_WIDTH * 2, widthPx + Math.min(0, left + MIN_BLOCK_WIDTH)), top: RULER_HEIGHT + (layout.lanes.get(cue.id) ?? 0) * LANE_HEIGHT }}
              title={`${label} · ${formatTimestamp(cue.startMs, '.')} – ${formatTimestamp(cue.endMs, '.')}${overlap ? ' · 时间重叠' : ''}`}>
              <button type="button" className="timeline-cue-body" {...props} data-cue-mode="move" aria-label={label}
                aria-pressed={chosen} onClick={event => { if (event.detail === 0) onSelect(cue.id, event.ctrlKey || event.metaKey, event.shiftKey); }}>
                <span>{number} · {cue.text || '空正文'}</span>
              </button>
              {!editDisabled && left >= 0 && <button type="button" className="timeline-edge start" {...props} data-cue-mode="trim-start" aria-label={`调整字幕 ${number} 入点`} tabIndex={-1} />}
              {!editDisabled && left + widthPx <= width && <button type="button" className="timeline-edge end" {...props} data-cue-mode="trim-end" aria-label={`调整字幕 ${number} 出点`} tabIndex={-1} />}
            </div>;
          })}
          {playheadX >= 0 && playheadX <= width && <div className="timeline-playhead" style={{ left: Math.min(width - 1, playheadX) }} aria-hidden="true" />}
          {snapX >= 0 && snapX <= width && <div className="timeline-snap-line" style={{ left: snapX }} aria-hidden="true" />}
        </div>
      </div>
    </div>
    <div className="timeline-track-status" aria-live="polite">
      {preview?.error ?? (preview?.snapMs !== undefined ? `已吸附到 ${formatTimestamp(preview.snapMs, '.')}`
        : condensed ? `当前缩放合并显示 ${condensed} 条密集字幕。放大或从列表选择以编辑。`
        : '拖动字幕块平移，拖动两端修剪。Ctrl + 滚轮缩放。')}
    </div>
  </section>;
});
