import type { SubtitleCue } from '../../../core/models';
import { hasVisibleText } from '../../../core/text';
import { validateCueTime } from '../../../core/time';

export type TimeEndpoint = 'startMs' | 'endMs';

export function overlaps(a: SubtitleCue, b: SubtitleCue): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function setCueEndpoint(cue: SubtitleCue, endpoint: TimeEndpoint, timeMs: number, cues: readonly SubtitleCue[]) {
  const updated = { ...cue, [endpoint]: timeMs };
  const error = validateCueTime(updated);
  if (error) throw new Error(error);
  const originalValid = !validateCueTime(cue);
  let existing = 0;
  let added = 0;
  for (const other of cues) {
    if (other.id === cue.id || validateCueTime(other)) continue;
    const before = originalValid && overlaps(cue, other);
    if (before) existing++;
    if (!before && overlaps(updated, other)) added++;
  }
  return { updated, existing, added };
}

/** Active first. In a gap, choose the nearest interval boundary, favoring the earlier cue on ties. */
export function nearestCue(sorted: readonly SubtitleCue[], timeMs: number, selected?: SubtitleCue): SubtitleCue | undefined {
  if (selected && !validateCueTime(selected) && selected.startMs <= timeMs && timeMs < selected.endMs) return selected;
  let previous: SubtitleCue | undefined;
  for (const cue of sorted) {
    if (cue.startMs > timeMs) return previous && timeMs - previous.endMs <= cue.startMs - timeMs ? previous : cue;
    if (cue.endMs > timeMs) return cue;
    if (!previous || cue.endMs > previous.endMs) previous = cue;
  }
  return previous;
}

export function assertSplitTime(cue: SubtitleCue, splitMs: number) {
  if (validateCueTime(cue) || !Number.isSafeInteger(splitMs) || splitMs <= cue.startMs || splitMs >= cue.endMs) {
    throw new Error('拆分时间必须严格位于选中字幕的开始与结束之间。');
  }
}

export function suggestSplitText(text: string, caret?: number) {
  const fallback = { left: text, right: '', lineBoundary: false, suggested: false };
  if (caret === undefined || caret <= 0 || caret >= text.length || typeof Intl.Segmenter !== 'function') return fallback;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  if (segments.containing(caret)?.index !== caret) return fallback;
  const left = text.slice(0, caret);
  const right = text.slice(caret);
  if (!hasVisibleText(left) || !hasVisibleText(right)) return fallback;
  // A line break at the cut becomes the boundary between the two cues.
  const before = /(?:\r\n?|\n)$/u;
  const after = /^(?:\r\n?|\n)/u;
  if (before.test(left)) return { left: left.replace(before, ''), right, lineBoundary: true, suggested: true };
  if (after.test(right)) return { left, right: right.replace(after, ''), lineBoundary: true, suggested: true };
  return { left, right, lineBoundary: false, suggested: true };
}
