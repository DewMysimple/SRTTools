import type { SubtitleCue } from '../../../core/models';
import { validateCueTime } from '../../../core/time';
import { DEFAULT_MIN_CUE_DURATION_MS } from '../../../core/validate';

export type CueTiming = Pick<SubtitleCue, 'id' | 'index' | 'startMs' | 'endMs'>;

export interface CalibrationAnchors {
  subtitle1: number;
  video1: number;
  subtitle2: number;
  video2: number;
}

export interface TimingChange {
  before: CueTiming;
  after: CueTiming;
}

export interface CalibrationPreview {
  scale: number;
  offsetMs: number;
  spanMs: number;
  unusualScale: boolean;
  scopedCount: number;
  changes: TimingChange[];
  invalidCount: number;
  issues: { position: number; message: string }[];
  priorOverlapPairs: number;
  newOverlapPairs: number;
  shorterCount: number;
  longerCount: number;
  newlyShortCount: number;
  minDurationDelta: number;
  maxDurationDelta: number;
  first?: TimingChange;
  last?: TimingChange;
}

const MAX_TIME = BigInt(Number.MAX_SAFE_INTEGER);

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const doubledRemainder = numerator % denominator * 2n;
  if (doubledRemainder >= denominator) return quotient + 1n;
  if (doubledRemainder < -denominator) return quotient - 1n;
  return quotient;
}

function mapping({ subtitle1, video1, subtitle2, video2 }: CalibrationAnchors) {
  if (![subtitle1, video1, subtitle2, video2].every(time => Number.isSafeInteger(time) && time >= 0)) {
    throw new Error('四个锚点须为非负的安全整数毫秒。');
  }
  if (subtitle1 === subtitle2) throw new Error('两个字幕锚点必须不同。');
  const sign = subtitle2 > subtitle1 ? 1n : -1n;
  const subtitleSpan = (BigInt(subtitle2) - BigInt(subtitle1)) * sign;
  const videoSpan = (BigInt(video2) - BigInt(video1)) * sign;
  if (subtitleSpan < 1000n) throw new Error('两个字幕锚点至少相隔 1000 毫秒。');
  if (videoSpan <= 0n) throw new Error('字幕和目标锚点必须同向，且目标锚点不能相同。');
  const start = BigInt(subtitle1);
  const base = BigInt(video1) * subtitleSpan;
  const spanMs = Number(subtitleSpan);
  const scale = Number(videoSpan) / spanMs;
  return {
    scale, spanMs, offsetMs: video1 - scale * subtitle1,
    unusualScale: videoSpan * 5n < subtitleSpan * 4n || videoSpan * 5n > subtitleSpan * 6n,
    apply(time: number) {
      const mapped = roundRatio(base + (BigInt(time) - start) * videoSpan, subtitleSpan);
      if (mapped < 0n) throw new Error('校准后出现负时间。');
      if (mapped > MAX_TIME) throw new Error('校准后时间超出 SRT 的安全整数范围。');
      return Number(mapped);
    },
  };
}

function boundary(numbers: readonly number[], target: number, inclusive: boolean): number {
  let lo = 0;
  let hi = numbers.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (numbers[mid] < target || inclusive && numbers[mid] === target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function overlapPairs(cues: readonly CueTiming[]): number {
  const starts = cues.map(cue => cue.startMs).sort((a, b) => a - b);
  const ends = cues.map(cue => cue.endMs).sort((a, b) => a - b);
  let finished = 0;
  let pairs = 0;
  starts.forEach((start, index) => {
    while (finished < ends.length && ends[finished] <= start) finished++;
    pairs += index - finished;
  });
  return pairs;
}

/** With a monotonic map, new overlaps can only cross from mapped to stationary cues. */
function newCrossPairs(stationary: CueTiming[], changes: readonly TimingChange[]): number {
  if (!stationary.length || !changes.length) return 0;
  stationary.sort((a, b) => a.startMs - b.startMs);
  const starts = stationary.map(cue => cue.startMs);
  const ends = stationary.map(cue => cue.endMs).sort((a, b) => a - b);
  const queries = changes.map(({ before, after }) => ({
    beforeAndAfterEnd: Math.min(before.endMs, after.endMs),
    beforeAndAfterStart: Math.max(before.startMs, after.startMs),
    afterCount: boundary(starts, after.endMs, false) - boundary(ends, after.startMs, true),
  })).sort((a, b) => a.beforeAndAfterEnd - b.beforeAndAfterEnd);

  // Sweep stationary starts and keep a Fenwick prefix count of their ends.
  // A stationary cue overlaps both intervals iff it starts before both ends
  // and ends after both starts. This holds even when the two intervals are disjoint.
  const activeEnds = new Uint32Array(ends.length + 1);
  let admitted = 0;
  let added = 0;
  for (const query of queries) {
    while (admitted < stationary.length && stationary[admitted].startMs < query.beforeAndAfterEnd) {
      const index = boundary(ends, stationary[admitted++].endMs, false);
      for (let i = index + 1; i < activeEnds.length; i += i & -i) activeEnds[i]++;
    }
    let ended = 0;
    for (let i = boundary(ends, query.beforeAndAfterStart, true); i > 0; i -= i & -i) ended += activeEnds[i];
    added += query.afterCount - (admitted - ended);
  }
  return added;
}

export function createCalibrationPreview(
  cues: readonly CueTiming[], anchors: CalibrationAnchors, selectedIds?: readonly string[],
): CalibrationPreview {
  const map = mapping(anchors);
  const selected = selectedIds && new Set(selectedIds);
  const changes: TimingChange[] = [];
  const stationary: CueTiming[] = [];
  const valid: CueTiming[] = [];
  const issues: CalibrationPreview['issues'] = [];
  let scopedCount = 0;
  let invalidCount = 0;
  let shorterCount = 0;
  let longerCount = 0;
  let newlyShortCount = 0;
  let minDurationDelta = Infinity;
  let maxDurationDelta = -Infinity;
  let first: TimingChange | undefined;
  let last: TimingChange | undefined;
  for (const [position, cue] of cues.entries()) {
    const invalid = validateCueTime(cue);
    if (!invalid) valid.push(cue);
    if (selected && !selected.has(cue.id)) {
      if (!invalid) stationary.push(cue);
      continue;
    }
    scopedCount++;
    try {
      if (invalid) throw new Error('原时间区间无效。' + invalid);
      const startMs = map.apply(cue.startMs);
      const endMs = map.apply(cue.endMs);
      if (endMs <= startMs) throw new Error('校准并舍入后，结束时间不晚于开始时间。');
      if (startMs === cue.startMs && endMs === cue.endMs) continue;
      const change = { before: cue, after: { ...cue, startMs, endMs } };
      changes.push(change);
      if (!first || cue.startMs < first.before.startMs) first = change;
      if (!last || cue.endMs > last.before.endMs) last = change;
      const beforeDuration = cue.endMs - cue.startMs;
      const afterDuration = endMs - startMs;
      const delta = afterDuration - beforeDuration;
      if (delta < 0) shorterCount++;
      if (delta > 0) longerCount++;
      if (beforeDuration >= DEFAULT_MIN_CUE_DURATION_MS && afterDuration < DEFAULT_MIN_CUE_DURATION_MS) newlyShortCount++;
      minDurationDelta = Math.min(minDurationDelta, delta);
      maxDurationDelta = Math.max(maxDurationDelta, delta);
    } catch (error) {
      invalidCount++;
      if (issues.length < 20) issues.push({ position: position + 1, message: (error as Error).message });
    }
  }
  if (!scopedCount) throw new Error('所选范围中没有字幕。');
  return {
    scale: map.scale, offsetMs: map.offsetMs, spanMs: map.spanMs, unusualScale: map.unusualScale,
    scopedCount, changes, invalidCount, issues, priorOverlapPairs: overlapPairs(valid),
    newOverlapPairs: newCrossPairs(stationary, changes), shorterCount, longerCount, newlyShortCount,
    minDurationDelta: changes.length ? minDurationDelta : 0, maxDurationDelta: changes.length ? maxDurationDelta : 0,
    first, last,
  };
}
