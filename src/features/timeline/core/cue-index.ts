import type { SubtitleCue } from '../../../core/models';
import { validateCueTime } from '../../../core/time';

/** Balanced interval index. Subtrees whose maximum end has passed are skipped. */
export class CueIndex {
  readonly sorted: SubtitleCue[];
  readonly endMs: number;
  private readonly maxEnds: Float64Array;

  constructor(cues: readonly SubtitleCue[]) {
    this.sorted = cues.filter(cue => !validateCueTime(cue)).sort((a, b) => a.startMs - b.startMs);
    this.maxEnds = new Float64Array(Math.max(2, this.sorted.length * 4));
    this.endMs = this.sorted.length ? this.build(1, 0, this.sorted.length) : 0;
  }

  private build(node: number, lo: number, hi: number): number {
    if (hi - lo === 1) return this.maxEnds[node] = this.sorted[lo].endMs;
    const mid = Math.floor((lo + hi) / 2);
    return this.maxEnds[node] = Math.max(this.build(node * 2, lo, mid), this.build(node * 2 + 1, mid, hi));
  }

  private query(fromMs: number, throughMs: number, includeStartAtEnd: boolean): SubtitleCue[] {
    const result: SubtitleCue[] = [];
    if (!this.sorted.length || !Number.isFinite(fromMs) || !Number.isFinite(throughMs)) return result;
    const visit = (node: number, lo: number, hi: number) => {
      const firstStart = this.sorted[lo].startMs;
      if (this.maxEnds[node] <= fromMs || firstStart > throughMs || (!includeStartAtEnd && firstStart === throughMs)) return;
      if (hi - lo === 1) {
        result.push(this.sorted[lo]);
        return;
      }
      const mid = Math.floor((lo + hi) / 2);
      visit(node * 2, lo, mid);
      visit(node * 2 + 1, mid, hi);
    };
    visit(1, 0, this.sorted.length);
    return result;
  }

  visible(fromMs: number, beforeMs: number): SubtitleCue[] {
    return fromMs < beforeMs ? this.query(fromMs, beforeMs, false) : [];
  }

  active(timeMs: number): SubtitleCue[] {
    return this.query(timeMs, timeMs, true);
  }
}
