import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../models';
import { buildSubtitleDiff } from './subtitle-diff';

const cue = (index: number, text = `第 ${index} 条`): SubtitleCue => ({
  id: `cue-${index}`, index, startMs: index * 1000, endMs: index * 1000 + 500, text,
});

function compare(before: readonly SubtitleCue[], after: readonly SubtitleCue[], trustIds = true) {
  const result = buildSubtitleDiff(before, after, { trustIds });
  if (result.kind !== 'aligned') throw new Error('Expected an aligned comparison');
  return result;
}

describe('subtitle diff alignment', () => {
  it('keeps immutable identical cues unchanged', () => {
    const input = Object.freeze([Object.freeze(cue(1)), Object.freeze(cue(2))]);
    const result = compare(input, input);
    expect(result.summary).toMatchObject({ beforeCount: 2, afterCount: 2, affected: 0, unchanged: 2 });
    expect(result.rows.map(row => row.kind)).toEqual(['unchanged', 'unchanged']);
  });

  it('classifies independent changes and counts an affected row only once', () => {
    const before = [cue(1, '我觉的'), cue(2), cue(3), cue(4)];
    const after = [
      { ...before[0], text: '我觉得' },
      { ...before[1], endMs: 2700 },
      { ...before[2], index: 11 },
      { ...before[3], text: '另一条', startMs: 4100, index: 12 },
    ];
    const result = compare(before, after);
    expect(result.rows.map(row => row.kind)).toEqual(['text-changed', 'time-changed', 'index-changed', 'mixed-changed']);
    expect(result.summary).toMatchObject({ affected: 4, textChanged: 2, timeChanged: 2, indexChanged: 2 });
  });

  it('keeps a middle deletion and insertion separate from their neighbors', () => {
    const before = [cue(1), cue(2), cue(3), cue(4)];
    const added = { ...cue(5), index: 3 };
    const result = compare(before, [before[0], before[2], added, before[3]]);
    expect(result.rows.map(row => [row.before?.id, row.after?.id])).toEqual([
      ['cue-1', 'cue-1'], ['cue-2', undefined], ['cue-3', 'cue-3'],
      [undefined, 'cue-5'], ['cue-4', 'cue-4'],
    ]);
    expect(result.summary).toMatchObject({ added: 1, removed: 1, affected: 2, unchanged: 3, reordered: 0 });
  });

  it('represents empty outputs as deletions without pretending any rows matched', () => {
    const result = compare([cue(1), cue(2)], [], false);
    expect(result.rows.map(row => row.kind)).toEqual(['removed', 'removed']);
    expect(result.summary).toMatchObject({ beforeCount: 2, afterCount: 0, affected: 2, removed: 2 });
  });

  it('rejects coincident IDs unless provenance was confirmed', () => {
    const before = [cue(1, '原句')];
    const after = [{ ...cue(1, '另一句'), startMs: 4000, endMs: 4200 }];
    const result = compare(before, after, false);
    expect(result.rows.map(row => row.kind)).toEqual(['unmatched', 'unmatched']);
    expect(result.summary).toMatchObject({ affected: 2, ambiguous: 2, textChanged: 0, timeChanged: 0 });
  });

  it('uses unique time and text anchors when IDs were rebuilt, then aligns reliable local candidates', () => {
    const before = [cue(1), cue(2, '修改前'), cue(3), cue(4)];
    const after = [
      { ...before[0], id: 'a' },
      { ...cue(8, '插入一条'), id: 'insert' },
      { ...before[1], id: 'b', text: '修改后' },
      { ...before[3], id: 'd' },
    ];
    const result = compare(before, after, false);
    expect(result.rows.map(row => [row.before?.id, row.after?.id, row.matchConfidence])).toEqual([
      ['cue-1', 'a', 'anchored'], [undefined, 'insert', 'unmatched'], ['cue-2', 'b', 'heuristic'],
      ['cue-3', undefined, 'unmatched'], ['cue-4', 'd', 'anchored'],
    ]);
    expect(result.summary).toMatchObject({ textChanged: 1, added: 1, removed: 1, ambiguous: 0 });
  });

  it('does not guess which exact repeated cue survived a deletion', () => {
    const duplicate = { ...cue(2, '重复'), id: 'duplicate' };
    const before = [cue(1), { ...duplicate, index: 2 }, { ...duplicate, index: 3 }, cue(4)];
    const after = [{ ...cue(1), id: 'one' }, duplicate, { ...cue(4), id: 'four' }];
    const result = compare(before, after);
    expect(result.summary).toMatchObject({ unchanged: 2, ambiguous: 3, added: 0, removed: 0 });
    expect(result.rows.filter(row => row.kind === 'unmatched').every(row => !row.before || !row.after)).toBe(true);
  });

  it('matches repeated text at distinct times and leaves an ambiguous crossed local alignment unpaired', () => {
    const repeatBefore = [cue(1, '重复'), cue(2, '重复')];
    const repeatAfter = repeatBefore.map((item, index) => ({ ...item, id: `after-${index}` }));
    expect(compare(repeatBefore, repeatAfter, false).summary.unchanged).toBe(2);

    const before = [cue(1), cue(2, '甲'), cue(3, '乙'), cue(4)];
    const after = [
      before[0],
      { ...cue(8, '乙'), id: 'c' },
      { ...cue(9, '甲'), id: 'b' },
      before[3],
    ];
    expect(compare(before, after, false).summary).toMatchObject({ ambiguous: 4, textChanged: 0, reordered: 0 });
  });

  it('reports an actual reorder in output order without inventing text or time changes', () => {
    const before = [cue(1), cue(2, '同句'), cue(3, '同句'), cue(4)];
    const result = compare(before, [before[0], before[2], before[1], before[3]]);
    expect(result.rows.map(row => row.before?.id)).toEqual(['cue-1', 'cue-3', 'cue-2', 'cue-4']);
    expect(result.rows.map(row => row.kind)).toEqual(['unchanged', 'reordered', 'reordered', 'unchanged']);
    expect(result.summary).toMatchObject({ affected: 2, reordered: 2, textChanged: 0, timeChanged: 0 });
  });

  it('keeps plausible partners ambiguous across an unchanged anchor instead of inventing additions or removals', () => {
    const before = [cue(1, '可能重排'), cue(2)];
    const after = [
      { ...before[1], id: 'new-anchor' },
      { ...before[0], id: 'new-candidate', startMs: 3000, endMs: 3500 },
    ];
    const result = compare(before, after, false);
    expect(result.summary).toMatchObject({ unchanged: 1, ambiguous: 2, added: 0, removed: 0 });
  });

  it('keeps 41 aligned rows for 39 outputs, including deletions at page boundaries', () => {
    const before = Array.from({ length: 41 }, (_, i) => cue(i + 1));
    const after = before.filter(item => item.index !== 20 && item.index !== 40);
    const result = compare(before, after);
    expect(result.rows).toHaveLength(41);
    expect(result.rows[19]).toMatchObject({ before: before[19], kind: 'removed' });
    expect(result.rows[20]).toMatchObject({ before: before[20], after: before[20] });
    expect(result.rows[39]).toMatchObject({ before: before[39], kind: 'removed' });
    expect(result.rows[40]).toMatchObject({ before: before[40], after: before[40] });
    expect(result.rows.filter(row => row.kind !== 'unchanged')).toHaveLength(2);
  });

  it('aligns a large synthetic input and falls back for oversized cue or text budgets', () => {
    const before = Array.from({ length: 4000 }, (_, i) => cue(i + 1));
    const after = before.map(item => ({ ...item, text: `${item.text}。` }));
    expect(compare(before, after).summary).toMatchObject({ affected: 4000, textChanged: 4000 });
    const oversized = Array.from({ length: 6000 }, (_, i) => cue(i + 1));
    expect(buildSubtitleDiff(oversized, oversized)).toMatchObject({ kind: 'fallback', beforeCount: 6000, afterCount: 6000, reason: 'size-limit' });
    const verbose = [cue(1, '字'.repeat(2_000_001))];
    expect(buildSubtitleDiff(verbose, [])).toMatchObject({ kind: 'fallback', beforeCount: 1, afterCount: 0, reason: 'size-limit' });
  });
});
