import type { SubtitleCue } from '../models';

export type CueChangeType =
  | 'unchanged' | 'text-changed' | 'time-changed' | 'index-changed' | 'mixed-changed'
  | 'added' | 'removed' | 'unmatched' | 'reordered';
type MatchConfidence = 'exact-id' | 'anchored' | 'heuristic' | 'unmatched';

export interface CueDiffRow {
  key: string;
  before?: SubtitleCue;
  after?: SubtitleCue;
  kind: CueChangeType;
  textChanged: boolean;
  timeChanged: boolean;
  indexChanged: boolean;
  reordered: boolean;
  matchConfidence: MatchConfidence;
}

export interface CueDiffSummary {
  beforeCount: number;
  afterCount: number;
  affected: number;
  unchanged: number;
  added: number;
  removed: number;
  textChanged: number;
  timeChanged: number;
  indexChanged: number;
  reordered: number;
  ambiguous: number;
}

export type SubtitleDiff =
  | { kind: 'aligned'; rows: CueDiffRow[]; summary: CueDiffSummary }
  | { kind: 'fallback'; beforeCount: number; afterCount: number; reason: 'size-limit' };

export interface SubtitleDiffOptions {
  trustIds?: boolean;
  /** Inclusive classification threshold; does not supply evidence for cue matching. */
  timeToleranceMs?: number;
}

const MAX_COMBINED_CUES = 10_000;
const MAX_COMBINED_TEXT_UNITS = 2_000_000;
const LOCAL_WINDOW = 12;

type CueKey = (cue: SubtitleCue) => string | undefined;
interface Pairs {
  afterByBefore: Int32Array;
  beforeByAfter: Int32Array;
  confidence: MatchConfidence[];
}
interface Gap {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}

function timeKey(cue: SubtitleCue): string | undefined {
  if (Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs)) {
    return `${cue.startMs},${cue.endMs}`;
  }
}

function contentKey(cue: SubtitleCue): string | undefined {
  const time = timeKey(cue);
  if (time !== undefined) return `${time}:${cue.text}`;
}

const textKey: CueKey = cue => cue.text.trim() ? cue.text : undefined;
const idKey: CueKey = cue => cue.id || undefined;

function uniquePositions(cues: readonly SubtitleCue[], keyOf: CueKey, paired?: Int32Array) {
  const positions = new Map<string, number>();
  cues.forEach((cue, index) => {
    if (paired && paired[index] >= 0) return;
    const key = keyOf(cue);
    if (key !== undefined) positions.set(key, positions.has(key) ? -1 : index);
  });
  return positions;
}

function setPair(pairs: Pairs, beforeIndex: number, afterIndex: number, confidence: MatchConfidence) {
  pairs.afterByBefore[beforeIndex] = afterIndex;
  pairs.beforeByAfter[afterIndex] = beforeIndex;
  pairs.confidence[beforeIndex] = confidence;
}

function matchUnique(
  before: readonly SubtitleCue[], after: readonly SubtitleCue[], pairs: Pairs,
  keyOf: CueKey, confidence: MatchConfidence,
) {
  const beforeKeys = uniquePositions(before, keyOf, pairs.afterByBefore);
  const afterKeys = uniquePositions(after, keyOf, pairs.beforeByAfter);
  for (const [key, beforeIndex] of beforeKeys) {
    const afterIndex = afterKeys.get(key) ?? -1;
    if (beforeIndex >= 0 && afterIndex >= 0) setPair(pairs, beforeIndex, afterIndex, confidence);
  }
}

/** Gaps are safe to align only when the surrounding reliable pairs agree on order. */
function orderedGaps(pairs: Pairs): Gap[] | null {
  const gaps: Gap[] = [];
  let beforeStart = 0;
  let afterStart = 0;
  for (let beforeEnd = 0; beforeEnd < pairs.afterByBefore.length; beforeEnd++) {
    const afterEnd = pairs.afterByBefore[beforeEnd];
    if (afterEnd < 0) continue;
    if (afterEnd < afterStart) return null;
    if (beforeStart < beforeEnd && afterStart < afterEnd) gaps.push({ beforeStart, beforeEnd, afterStart, afterEnd });
    beforeStart = beforeEnd + 1;
    afterStart = afterEnd + 1;
  }
  if (beforeStart < pairs.afterByBefore.length && afterStart < pairs.beforeByAfter.length) {
    gaps.push({ beforeStart, beforeEnd: pairs.afterByBefore.length, afterStart, afterEnd: pairs.beforeByAfter.length });
  }
  return gaps;
}

/** Each cue can nominate one partner on unique time or unique nonempty text evidence. */
function localCandidates(source: readonly SubtitleCue[], target: readonly SubtitleCue[]) {
  const sourceTimes = uniquePositions(source, timeKey);
  const targetTimes = uniquePositions(target, timeKey);
  const sourceTexts = uniquePositions(source, textKey);
  const targetTexts = uniquePositions(target, textKey);
  return source.map((cue, index) => {
    const time = timeKey(cue);
    const text = textKey(cue);
    const byTime = time !== undefined && sourceTimes.get(time) === index ? targetTimes.get(time) ?? -1 : -1;
    const byText = text !== undefined && sourceTexts.get(text) === index ? targetTexts.get(text) ?? -1 : -1;
    if (byTime >= 0 && byText >= 0 && byTime !== byText) return -1;
    return Math.max(byTime, byText);
  });
}

function matchLocal(before: readonly SubtitleCue[], after: readonly SubtitleCue[], pairs: Pairs, gap: Gap) {
  const beforeLength = gap.beforeEnd - gap.beforeStart;
  const afterLength = gap.afterEnd - gap.afterStart;
  if (beforeLength > LOCAL_WINDOW || afterLength > LOCAL_WINDOW) return;
  const localBefore = before.slice(gap.beforeStart, gap.beforeEnd);
  const localAfter = after.slice(gap.afterStart, gap.afterEnd);
  const forward = localCandidates(localBefore, localAfter);
  const backward = localCandidates(localAfter, localBefore);
  const stride = afterLength + 1;
  const lengths = new Uint8Array((beforeLength + 1) * stride);
  const sharedPairs = new Uint16Array(lengths.length);

  // Bounded LCS over reciprocal candidates. On ties keep only pairs shared by all best
  // alignments, so equally plausible sequences never create a guessed replacement.
  for (let i = beforeLength - 1; i >= 0; i--) {
    for (let j = afterLength - 1; j >= 0; j--) {
      const cell = i * stride + j;
      const skipBefore = cell + stride;
      const skipAfter = cell + 1;
      const bestSkip = Math.max(lengths[skipBefore], lengths[skipAfter]);
      const sameScore = lengths[skipBefore] === lengths[skipAfter];
      lengths[cell] = bestSkip;
      sharedPairs[cell] = sameScore
        ? sharedPairs[skipBefore] & sharedPairs[skipAfter]
        : sharedPairs[lengths[skipBefore] > lengths[skipAfter] ? skipBefore : skipAfter];

      if (forward[i] !== j || backward[j] !== i) continue;
      const diagonal = skipBefore + 1;
      const matchLength = lengths[diagonal] + 1;
      const matchPairs = sharedPairs[diagonal] | (1 << i);
      if (matchLength > bestSkip) {
        lengths[cell] = matchLength;
        sharedPairs[cell] = matchPairs;
      } else if (matchLength === bestSkip) {
        sharedPairs[cell] &= matchPairs;
      }
    }
  }
  forward.forEach((afterIndex, beforeIndex) => {
    if ((sharedPairs[0] & (1 << beforeIndex)) !== 0) {
      setPair(pairs, gap.beforeStart + beforeIndex, gap.afterStart + afterIndex, 'heuristic');
    }
  });
}

/** Mark matched cues whose relative order against any other matched cue changed. */
function reorderedRows(afterByBefore: Int32Array): Uint8Array {
  const reordered = new Uint8Array(afterByBefore.length);
  let highest = -1;
  for (let i = 0; i < afterByBefore.length; i++) {
    const index = afterByBefore[i];
    if (index < 0) continue;
    if (index < highest) reordered[i] = 1;
    highest = Math.max(highest, index);
  }
  let lowest = Infinity;
  for (let i = afterByBefore.length - 1; i >= 0; i--) {
    const index = afterByBefore[i];
    if (index < 0) continue;
    if (index > lowest) reordered[i] = 1;
    lowest = Math.min(lowest, index);
  }
  return reordered;
}

function flagSharedEvidence(
  cues: readonly SubtitleCue[], paired: Int32Array, flagged: Uint8Array,
  otherKeys: ReadonlyMap<string, number>, keyOf: CueKey,
) {
  cues.forEach((cue, index) => {
    if (paired[index] >= 0 || flagged[index]) return;
    const key = keyOf(cue);
    if (key !== undefined && otherKeys.has(key)) flagged[index] = 1;
  });
}

function ambiguity(left: readonly SubtitleCue[], right: readonly SubtitleCue[], pairs: Pairs, trustIds: boolean) {
  const before = new Uint8Array(pairs.afterByBefore.length);
  const after = new Uint8Array(pairs.beforeByAfter.length);
  if (!pairs.afterByBefore.includes(-1) || !pairs.beforeByAfter.includes(-1)) return { before, after };
  const gaps = orderedGaps(pairs);
  if (!gaps) {
    // Without agreed gap boundaries there is no safe way to distinguish unmatched
    // removals and additions from unresolved partners across a reorder.
    before.fill(1);
    after.fill(1);
    return { before, after };
  }
  for (const gap of gaps) {
    before.fill(1, gap.beforeStart, gap.beforeEnd);
    after.fill(1, gap.afterStart, gap.afterEnd);
  }
  // A possible partner can have crossed an anchor or lost a tie in the local
  // sequence alignment. Do not claim definite addition/removal in those cases.
  const keys = trustIds ? [timeKey, textKey, idKey] : [timeKey, textKey];
  for (const keyOf of keys) {
    const leftKeys = uniquePositions(left, keyOf, pairs.afterByBefore);
    const rightKeys = uniquePositions(right, keyOf, pairs.beforeByAfter);
    flagSharedEvidence(left, pairs.afterByBefore, before, rightKeys, keyOf);
    flagSharedEvidence(right, pairs.beforeByAfter, after, leftKeys, keyOf);
  }
  return { before, after };
}

function pairedRow(
  key: string, before: SubtitleCue, after: SubtitleCue, matchConfidence: MatchConfidence, reordered: boolean,
  timeToleranceMs: number,
): CueDiffRow {
  const textChanged = before.text !== after.text;
  const timeChanged = timeChangedBeyondTolerance(before.startMs, after.startMs, timeToleranceMs)
    || timeChangedBeyondTolerance(before.endMs, after.endMs, timeToleranceMs);
  const indexChanged = before.index !== after.index;
  const changes = Number(textChanged) + Number(timeChanged) + Number(indexChanged);
  let kind: CueChangeType;
  if (changes > 1) kind = 'mixed-changed';
  else if (textChanged) kind = 'text-changed';
  else if (timeChanged) kind = 'time-changed';
  else if (indexChanged) kind = 'index-changed';
  else kind = reordered ? 'reordered' : 'unchanged';
  return { key, before, after, kind, textChanged, timeChanged, indexChanged, reordered, matchConfidence };
}

function timeChangedBeyondTolerance(before: number, after: number, toleranceMs: number): boolean {
  return Number.isFinite(before) && Number.isFinite(after)
    ? Math.abs(before - after) > toleranceMs
    : before !== after;
}

function singleRow(key: string, cue: SubtitleCue, side: 'before' | 'after', ambiguous: boolean): CueDiffRow {
  return {
    key, [side]: cue, kind: ambiguous ? 'unmatched' : side === 'before' ? 'removed' : 'added',
    textChanged: false, timeChanged: false, indexChanged: false, reordered: false, matchConfidence: 'unmatched',
  };
}

function buildRows(before: readonly SubtitleCue[], after: readonly SubtitleCue[], pairs: Pairs, trustIds: boolean, timeToleranceMs: number) {
  const uncertain = ambiguity(before, after, pairs, trustIds);
  const reordered = reorderedRows(pairs.afterByBefore);
  const removedBeforeNextPair = new Map<number, CueDiffRow[]>();
  let pending: CueDiffRow[] = [];
  before.forEach((cue, index) => {
    const partner = pairs.afterByBefore[index];
    if (partner < 0) {
      pending.push(singleRow(`before-${index}`, cue, 'before', uncertain.before[index] === 1));
    } else if (pending.length > 0) {
      removedBeforeNextPair.set(partner, pending);
      pending = [];
    }
  });

  const rows: CueDiffRow[] = [];
  after.forEach((cue, index) => {
    const removals = removedBeforeNextPair.get(index);
    if (removals) rows.push(...removals);
    const partner = pairs.beforeByAfter[index];
    rows.push(partner < 0
      ? singleRow(`after-${index}`, cue, 'after', uncertain.after[index] === 1)
      : pairedRow(`before-${partner}`, before[partner], cue, pairs.confidence[partner], reordered[partner] === 1, timeToleranceMs));
  });
  rows.push(...pending);
  return rows;
}

function summarize(rows: readonly CueDiffRow[], beforeCount: number, afterCount: number): CueDiffSummary {
  const summary: CueDiffSummary = {
    beforeCount, afterCount, affected: 0, unchanged: 0, added: 0, removed: 0,
    textChanged: 0, timeChanged: 0, indexChanged: 0, reordered: 0, ambiguous: 0,
  };
  for (const row of rows) {
    if (row.kind === 'unchanged') summary.unchanged++;
    if (row.kind === 'added') summary.added++;
    if (row.kind === 'removed') summary.removed++;
    if (row.kind === 'unmatched') summary.ambiguous++;
    if (row.textChanged) summary.textChanged++;
    if (row.timeChanged) summary.timeChanged++;
    if (row.indexChanged) summary.indexChanged++;
    if (row.reordered) summary.reordered++;
  }
  summary.affected = rows.length - summary.unchanged;
  return summary;
}

function exceedsBudget(before: readonly SubtitleCue[], after: readonly SubtitleCue[]): boolean {
  if (before.length + after.length > MAX_COMBINED_CUES) return true;
  let textUnits = 0;
  for (const cues of [before, after]) {
    for (const cue of cues) {
      textUnits += cue.text.length;
      if (textUnits > MAX_COMBINED_TEXT_UNITS) return true;
    }
  }
  return false;
}

/** Compare immutable cue snapshots. Enable ID matching only with confirmed shared provenance. */
export function buildSubtitleDiff(
  before: readonly SubtitleCue[], after: readonly SubtitleCue[], { trustIds = false, timeToleranceMs = 0 }: SubtitleDiffOptions = {},
): SubtitleDiff {
  if (!Number.isSafeInteger(timeToleranceMs) || timeToleranceMs < 0) {
    throw new RangeError('时间容差必须是非负整数毫秒。');
  }
  if (exceedsBudget(before, after)) {
    return { kind: 'fallback', beforeCount: before.length, afterCount: after.length, reason: 'size-limit' };
  }
  const pairs: Pairs = {
    afterByBefore: new Int32Array(before.length).fill(-1),
    beforeByAfter: new Int32Array(after.length).fill(-1),
    confidence: [],
  };
  if (trustIds) matchUnique(before, after, pairs, idKey, 'exact-id');
  matchUnique(before, after, pairs, contentKey, 'anchored');
  const gaps = orderedGaps(pairs);
  if (gaps) for (const gap of gaps) matchLocal(before, after, pairs, gap);
  const rows = buildRows(before, after, pairs, trustIds, timeToleranceMs);
  return { kind: 'aligned', rows, summary: summarize(rows, before.length, after.length) };
}
