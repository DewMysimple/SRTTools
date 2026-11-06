import type { SubtitleCue } from '../../../core/models';

interface Lane {
  index: number;
  endMs: number;
}

/** Called on committed edits with the cue index's time-sorted list. */
export function layoutCues(sorted: readonly SubtitleCue[]) {
  const lanes = new Map<string, number>();
  const overlapping = new Set<string>();
  const heap: Lane[] = [];
  let latestEnd: SubtitleCue | undefined;

  for (const cue of sorted) {
    if (latestEnd && cue.startMs < latestEnd.endMs) {
      overlapping.add(latestEnd.id);
      overlapping.add(cue.id);
    }
    if (!latestEnd || cue.endMs > latestEnd.endMs) latestEnd = cue;

    // Earliest ending lane is the first one eligible for reuse.
    if (heap.length && heap[0].endMs <= cue.startMs) {
      const lane = heap[0];
      lane.endMs = cue.endMs;
      lanes.set(cue.id, lane.index);
      let position = 0;
      while (position * 2 + 1 < heap.length) {
        const left = position * 2 + 1;
        const right = left + 1;
        const child = right < heap.length && heap[right].endMs < heap[left].endMs ? right : left;
        if (heap[child].endMs >= lane.endMs) break;
        heap[position] = heap[child];
        position = child;
      }
      heap[position] = lane;
    } else {
      const lane = { index: heap.length, endMs: cue.endMs };
      lanes.set(cue.id, lane.index);
      let position = heap.length;
      while (position > 0) {
        const parent = Math.floor((position - 1) / 2);
        if (heap[parent].endMs <= lane.endMs) break;
        heap[position] = heap[parent];
        position = parent;
      }
      heap[position] = lane;
    }
  }
  return { lanes, laneCount: heap.length, overlapping };
}
