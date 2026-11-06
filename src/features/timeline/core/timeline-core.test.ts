import { describe, expect, it } from 'vitest';
import { newDocument, type SubtitleCue } from '../../../core/models';
import {
  fitScale, getTimeTicks, msToX, scrollGeometry, xToMs, zoomAround,
} from './coordinates';
import { CueIndex } from './cue-index';
import { layoutCues } from './interval-layout';
import {
  createSession, deleteCues, insertCue, isDirty, markSaved, redo, restoreOriginal, shiftCues,
  timeChanges, undo, updateCue,
} from './editing-session';

function cue(id: string, startMs: number, endMs: number): SubtitleCue {
  return { id, startMs, endMs, index: 1, text: id };
}

const a = cue('a', 50, 500);
const b = cue('b', 620, 860);
const c = cue('c', 1000, 1200);
const session = () => createSession({ ...newDocument('test.srt', 'srt'), cues: [a, b, c] });

describe('timeline coordinates', () => {
  it('round-trips integer milliseconds including zero, one and multi-hour values', () => {
    for (const time of [0, 1, 3_600_001, 86_400_999]) {
      const viewport = { startMs: 15, pixelsPerSecond: 72.25 };
      expect(xToMs(msToX(time, viewport), viewport)).toBe(time);
    }
    expect(xToMs(0.6, { startMs: 0, pixelsPerSecond: 1000 })).toBe(1);
    expect(Number.isNaN(xToMs(Infinity, { startMs: 0, pixelsPerSecond: 10 }))).toBe(true);
    expect(Number.isNaN(xToMs(1, { startMs: 0, pixelsPerSecond: 0 }))).toBe(true);
    expect(Number.isNaN(xToMs(Number.MAX_VALUE, { startMs: 0, pixelsPerSecond: 10 }))).toBe(true);
  });

  it('fits, anchors zoom, bounds the viewport and compresses extremely long scroll tracks', () => {
    const width = 800;
    const duration = 90_000;
    const fit = fitScale(duration, width);
    expect(msToX(duration, { startMs: 0, pixelsPerSecond: fit })).toBeCloseTo(width);
    const before = { startMs: 10_000, pixelsPerSecond: 50 };
    const after = zoomAround(before, 2, 200, duration, width);
    expect(xToMs(200, before)).toBe(xToMs(200, after));
    expect(zoomAround(after, 0, 200, duration, width)).toEqual(after);
    expect(zoomAround(after, 1e15, 200, duration, width).pixelsPerSecond).toBe(2000);
    expect(fitScale(0, width)).toBe(80);
    const rail = scrollGeometry(Number.MAX_SAFE_INTEGER, 2000, width);
    expect(rail.contentWidth).toBeLessThanOrEqual(4_000_000);
    const finalStart = rail.toTime(rail.contentWidth - width);
    expect(finalStart).toBeGreaterThan(1e15);
    expect(rail.toScroll(finalStart)).toBeCloseTo(rail.contentWidth - width);
    const ticks = getTimeTicks(3_600_100, 3_610_000, 120);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeGreaterThanOrEqual(3_600_100);
    expect(ticks[1] - ticks[0]).toBeGreaterThanOrEqual(750);
  });
});

describe('interval queries and display lanes', () => {
  it('finds both a long-running cue and visible short cues with exclusive ends', () => {
    const long = cue('long', 0, 20000);
    const adjacent = cue('adjacent', 860, 1000);
    const index = new CueIndex([b, adjacent, long, a, cue('invalid', 20, 20)]);
    expect(index.visible(500, 860)).toEqual([long, b]);
    expect(index.active(860)).toEqual([long, adjacent]);
    expect(index.active(1000)).toEqual([long]);
    expect(index.active(20000)).toEqual([]);
    expect(index.visible(100, 100)).toEqual([]);
    expect(new CueIndex([]).visible(0, 100)).toEqual([]);
  });

  it('assigns reusable lanes and flags both sides of overlap without mutating cues', () => {
    const first = cue('first', 10, 100);
    const second = cue('second', 10, 100);
    const chain = cue('chain', 90, 150);
    const adjacent = cue('adjacent', 150, 160);
    const layout = layoutCues(new CueIndex([chain, first, second, adjacent]).sorted);
    expect(layout.laneCount).toBe(3);
    expect(layout.lanes.get('first')).not.toBe(layout.lanes.get('second'));
    expect(layout.overlapping).toEqual(new Set(['first', 'second', 'chain']));
    expect(layout.lanes.get('adjacent')).toBe(0);
    expect([first.startMs, second.endMs, chain.endMs]).toEqual([10, 100, 150]);
    expect(layoutCues([a, b]).laneCount).toBe(1);
  });
});

describe('timeline editing transactions', () => {
  it('stages many drag previews but records one atomic multi-move', () => {
    const initial = session();
    for (let dx = 1; dx < 200; dx++) expect(timeChanges([a, b], 'move', dx)[0].startMs).toBe(a.startMs + dx);
    expect(initial.past).toEqual([]);
    const moved = shiftCues(initial, ['a', 'b'], 200);
    expect(moved.past).toHaveLength(1);
    expect(moved.past[0]).toHaveLength(2);
    expect(moved.document.cues).toEqual([{ ...a, startMs: 250, endMs: 700 }, { ...b, startMs: 820, endMs: 1060 }, c]);
    expect(undo(moved).document.cues).toEqual([a, b, c]);
    expect(redo(undo(moved)).document.cues).toEqual(moved.document.cues);
    expect(() => shiftCues(initial, ['a', 'b'], -51)).toThrow('小于 0');
    expect(shiftCues(initial, ['a', 'b'], -50).document.cues[0].startMs).toBe(0);
    for (const bad of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => shiftCues(initial, ['a'], bad)).toThrow();
    }
    expect(initial.document.cues).toEqual([a, b, c]);
    expect(initial.past).toEqual([]);
  });

  it('trims one edge, rejects crossing and stores exact text and time edits', () => {
    const initial = session();
    expect(timeChanges([a], 'trim-start', 449)[0]).toEqual({ ...a, startMs: 499 });
    expect(timeChanges([a], 'trim-end', -449)[0]).toEqual({ ...a, endMs: 51 });
    expect(() => timeChanges([a], 'trim-end', -450)).toThrow('晚于');
    expect(() => timeChanges([a], 'trim-start', 450)).toThrow('晚于');
    expect(() => updateCue(initial, a.id, { startMs: 550 })).toThrow('晚于');
    const edited = updateCue(initial, a.id, { startMs: 73, endMs: 450, text: '中文\n🙂' });
    expect(edited.document.cues[0]).toEqual({ ...a, startMs: 73, endMs: 450, text: '中文\n🙂' });
    expect(undo(edited).document.cues[0]).toBe(a);
    expect(redo(undo(edited)).document.cues[0].text).toBe('中文\n🙂');
  });

  it('restores insert and noncontiguous deletes with stable IDs and clears redo on edit', () => {
    const initial = session();
    const added = insertCue(initial, 200);
    const inserted = added.document.cues.at(-1)!;
    expect(inserted.startMs).toBe(1200);
    expect(inserted.id).not.toBe(a.id);
    expect(undo(added).document.cues).toEqual([a, b, c]);
    const deleted = deleteCues(added, [a.id, c.id]);
    expect(deleted.document.cues.map(item => item.id)).toEqual([b.id, inserted.id]);
    const restored = undo(deleted);
    expect(restored.document.cues).toEqual([a, b, c, inserted]);
    expect(redo(restored).document.cues).toEqual([b, inserted]);
    expect(updateCue(restored, b.id, { text: '修改' }).future).toEqual([]);
    expect(deleteCues(initial, [])).toBe(initial);
  });

  it('compares content to the last saved baseline, retains the original, and bounds history', () => {
    const initial = session();
    const edited = updateCue(initial, a.id, { text: '修改' });
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(undo(edited))).toBe(false);
    const saved = markSaved(edited);
    expect(isDirty(saved)).toBe(false);
    expect(isDirty(undo(saved))).toBe(true);
    expect(isDirty(redo(undo(saved)))).toBe(false);
    expect(isDirty(updateCue(undo(saved), a.id, { text: '修改' }))).toBe(false);
    expect(isDirty(restoreOriginal(saved))).toBe(true);
    expect(restoreOriginal(saved).document).toBe(initial.document);
    let evolving = initial;
    for (let index = 0; index < 150; index++) evolving = shiftCues(evolving, ['a'], 1);
    expect(evolving.past).toHaveLength(100);
  });
});
