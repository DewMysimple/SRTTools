export interface TimelineViewport {
  startMs: number;
  pixelsPerSecond: number;
}

const MAX_SCALE = 2000;
const MAX_SCROLL_WIDTH = 4_000_000;
export const MIN_SPAN_MS = 10_000;

export function msToX(timeMs: number, viewport: TimelineViewport): number {
  return (timeMs - viewport.startMs) * viewport.pixelsPerSecond / 1000;
}

export function xToMs(x: number, viewport: TimelineViewport): number {
  if (!Number.isFinite(viewport.pixelsPerSecond) || viewport.pixelsPerSecond <= 0) return NaN;
  const time = Math.round(viewport.startMs + x * 1000 / viewport.pixelsPerSecond);
  return Number.isSafeInteger(time) && time >= 0 ? time : NaN;
}

export function fitScale(durationMs: number, width: number): number {
  return Math.min(MAX_SCALE, Math.max(1, width) * 1000 / Math.max(MIN_SPAN_MS, durationMs));
}

export function scrollGeometry(durationMs: number, pixelsPerSecond: number, width: number) {
  const totalMs = Math.max(MIN_SPAN_MS, durationMs);
  const viewSpan = width * 1000 / pixelsPerSecond;
  const lastStart = Math.max(0, totalMs - viewSpan);
  const contentWidth = Math.max(width, Math.min(MAX_SCROLL_WIDTH, Math.ceil(totalMs * pixelsPerSecond / 1000)));
  const range = contentWidth - width;
  return {
    contentWidth,
    toTime: (scrollLeft: number) => range ? Math.max(0, Math.min(lastStart, scrollLeft / range * lastStart)) : 0,
    toScroll: (startMs: number) => lastStart ? Math.max(0, Math.min(range, startMs / lastStart * range)) : 0,
  };
}

export function zoomAround(
  viewport: TimelineViewport, factor: number, anchorPx: number, durationMs: number, width: number,
): TimelineViewport {
  if (!Number.isFinite(factor) || factor <= 0) return viewport;
  const pixelsPerSecond = Math.max(fitScale(durationMs, width), Math.min(MAX_SCALE, viewport.pixelsPerSecond * factor));
  const anchorMs = viewport.startMs + anchorPx * 1000 / viewport.pixelsPerSecond;
  const rail = scrollGeometry(durationMs, pixelsPerSecond, width);
  return { pixelsPerSecond, startMs: rail.toTime(rail.toScroll(anchorMs - anchorPx * 1000 / pixelsPerSecond)) };
}

/** The 1/2/5 scale keeps labels about 90px apart or farther. */
export function tickInterval(pixelsPerSecond: number, gapPx = 90): number {
  const ideal = Math.max(1, gapPx * 1000 / pixelsPerSecond);
  const power = 10 ** Math.floor(Math.log10(ideal));
  return (ideal <= power ? 1 : ideal <= power * 2 ? 2 : ideal <= power * 5 ? 5 : 10) * power;
}

export function getTimeTicks(startMs: number, endMs: number, pixelsPerSecond: number): number[] {
  const step = tickInterval(pixelsPerSecond);
  const ticks: number[] = [];
  for (let time = Math.ceil(startMs / step) * step; time <= endMs && Number.isSafeInteger(time); time += step) {
    ticks.push(time);
  }
  return ticks;
}
