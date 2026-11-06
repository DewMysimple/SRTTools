import { describe, expect, it } from 'vitest';
import { newDocument, type SubtitleCue } from '../../../core/models';
import { serializeSubtitle } from '../../../core/serializer';
import { CueIndex } from './cue-index';
import { createSession, redo, replaceCues, splitCue, undo } from './editing-session';
import { createCalibrationPreview, type CalibrationAnchors } from './precision-calibration';
import { nearestCue, overlaps, setCueEndpoint, suggestSplitText } from './precision-timing';

function cue(id: string, startMs: number, endMs: number, text = '原文 🐱'): SubtitleCue {
  return { id, index: 1, startMs, endMs, text };
}

const offset: CalibrationAnchors = { subtitle1: 1000, video1: 2000, subtitle2: 11000, video2: 12000 };
const drift: CalibrationAnchors = { subtitle1: 0, video1: 0, subtitle2: 10_000, video2: 10_500 };

describe('precision endpoints and navigation', () => {
  it('keeps the other endpoint, preserves existing overlap and reports new pairs separately', () => {
    const target = cue('selected', 1000, 2000);
    const other = [cue('old', 1500, 2500), cue('new', 2600, 2800)];
    const set = setCueEndpoint(target, 'endMs', 2700, [target, ...other]);
    expect(set).toEqual({ updated: { ...target, endMs: 2700 }, existing: 1, added: 1 });
    expect(target.endMs).toBe(2000);
    for (const time of [-1, NaN, Infinity, 2000, 5000]) {
      expect(() => setCueEndpoint(target, 'startMs', time, other)).toThrow();
    }
  });

  it('uses an active selection and otherwise a deterministic nearest boundary in gaps', () => {
    const first = cue('first', 1000, 2500);
    const second = cue('second', 1100, 1500);
    const third = cue('third', 3500, 4100);
    const sorted = new CueIndex([third, second, first]).sorted;
    expect(nearestCue(sorted, 1200)?.id).toBe('first');
    expect(nearestCue(sorted, 1200, second)?.id).toBe('second');
    expect(nearestCue(sorted, 3000)?.id).toBe('first');
    expect(nearestCue(sorted, 3001)?.id).toBe('third');
    expect(nearestCue(sorted, 0)?.id).toBe('first');
    expect(nearestCue(sorted, 6000)?.id).toBe('third');
  });
});

describe('Unicode split transaction', () => {
  it('suggests only valid grapheme breaks and leaves single-character and unknown cuts unchanged', () => {
    const text = '一🐱 é 👩‍👩‍👧‍👦';
    for (const invalid of [0, 2, text.indexOf('́'), text.indexOf('‍'), text.length, undefined]) {
      expect(suggestSplitText(text, invalid)).toEqual({ left: text, right: '', suggested: false, lineBoundary: false });
    }
    expect(suggestSplitText(text, 3)).toEqual({ left: '一🐱', right: ' é 👩‍👩‍👧‍👦', suggested: true, lineBoundary: false });
    expect(suggestSplitText('中\r\n文', 3)).toEqual({ left: '中', right: '文', suggested: true, lineBoundary: true });
    expect(suggestSplitText('中', 1).right).toBe('');
  });

  it('checks both texts, preserves neighboring cues, and commits or undoes the entire split once', () => {
    const target = cue('a', 1000, 2000, '第一行 🐱\nsecond é');
    const nextCue = cue('b', 3000, 4000);
    const doc = { ...newDocument('拆分.srt', 'srt', '\r\n'), cues: [target, nextCue] };
    const base = createSession(doc);
    for (const cut of [1000, 2000, 1000.5]) expect(() => splitCue(base, 'a', cut, '前', '后')).toThrow('严格位于');
    expect(() => splitCue(base, 'a', 1500, '前', ' ')).toThrow('可见正文');
    expect(() => splitCue(base, 'a', 1500, '前\n\n异常', '后')).toThrow('无法无损导出');
    const split = splitCue(base, 'a', 1500, '第一行 🐱', 'second é');
    expect(split.session.past).toHaveLength(1);
    expect(split.session.document.cues).toEqual([
      { ...target, text: '第一行 🐱', endMs: 1500 }, { ...split.right, startMs: 1500, endMs: 2000, text: 'second é' }, nextCue,
    ]);
    expect(split.right.id).not.toBe(target.id);
    expect(serializeSubtitle(split.session.document).text).toContain('第一行 🐱\r\n\r\n2\r\n00:00:01,500');
    const undone = undo(split.session);
    expect(undone.document.cues).toEqual(doc.cues);
    expect(redo(undone).document.cues).toEqual(split.session.document.cues);
    expect(base.revision).toBe(0);
  });
});

describe('two-point calibration', () => {
  it('applies offset and drift to both endpoints and keeps a single undo entry', () => {
    const original = [cue('a', 1000, 2000), cue('b', 11000, 14000)];
    const moved = createCalibrationPreview(original, offset);
    expect(moved.changes.map(item => [item.after.startMs, item.after.endMs])).toEqual([[2000, 3000], [12000, 15000]]);
    expect(moved.scale).toBe(1);
    const calibrated = createCalibrationPreview(original, drift);
    expect(calibrated.changes.map(item => [item.after.startMs, item.after.endMs])).toEqual([[1050, 2100], [11550, 14700]]);
    const session = createSession({ ...newDocument('锚点.srt', 'srt'), cues: original });
    const changed = replaceCues(session, calibrated.changes.map(({ before, after }) => ({
      ...original.find(item => item.id === before.id)!, startMs: after.startMs, endMs: after.endMs,
    })));
    expect(changed.past).toHaveLength(1);
    expect(changed.document.cues.map(item => [item.id, item.text])).toEqual(original.map(item => [item.id, item.text]));
    const undone = undo(changed);
    expect(undone.document.cues).toEqual(original);
    expect(redo(undone).document.cues).toEqual(changed.document.cues);
  });

  it('refuses identical, too-close, non-positive and invalid anchors', () => {
    for (const [candidate, message] of [
      [{ ...offset, subtitle2: offset.subtitle1 }, '必须不同'],
      [{ ...offset, subtitle2: offset.subtitle1 + 999 }, '至少相隔'],
      [{ ...offset, video2: offset.video1 }, '必须同向'],
      [{ ...offset, video2: 1 }, '必须同向'],
      [{ ...offset, video2: Infinity }, '安全整数'],
    ] as const) {
      expect(() => createCalibrationPreview([cue('a', 1000, 2000)], candidate)).toThrow(message);
    }
    const reverseBoth = { subtitle1: 11000, video1: 12000, subtitle2: 1000, video2: 2000 };
    expect(createCalibrationPreview([cue('a', 1000, 2000)], reverseBoth).changes[0].after.startMs).toBe(2000);
  });

  it('flags negative, overflow and round-to-zero intervals without silently changing them', () => {
    const negative = createCalibrationPreview([cue('a', 500, 2000)], { subtitle1: 1000, video1: 0, subtitle2: 2000, video2: 1000 });
    expect(negative.issues[0].message).toContain('负时间');
    const max = Number.MAX_SAFE_INTEGER;
    const overflow = createCalibrationPreview([cue('a', max - 100, max - 1)], offset);
    expect(overflow.issues[0].message).toContain('安全整数范围');
    const tiny = createCalibrationPreview([cue('a', 1001, 1002)], { subtitle1: 0, video1: 0, subtitle2: 1000, video2: 1 });
    expect(tiny.issues[0].message).toContain('舍入');
    expect(tiny.unusualScale).toBe(true);
    expect([negative.changes, overflow.changes, tiny.changes]).toEqual([[], [], []]);
    const exact = createCalibrationPreview([cue('a', max - 600, max - 599)], {
      subtitle1: max - 1100, video1: max - 1500, subtitle2: max - 100, video2: max - 499,
    });
    expect(exact.changes[0].after.startMs).toBe(max - 999);
  });

  it('keeps old overlaps, counts newly short cues, and matches brute-force scoped pairs', () => {
    const fixtures = Array.from({ length: 60 }, (_, i) => cue(String(i), (i * 197) % 4000, (i * 197) % 4000 + 200 + (i * 169) % 1200));
    const selected = fixtures.filter((_, i) => i % 3 === 0).map(item => item.id);
    const result = createCalibrationPreview(fixtures, offset, selected);
    expect(result.scopedCount).toBe(20);
    const mapped = new Map(result.changes.map(change => [change.before.id, { ...fixtures.find(item => item.id === change.before.id)!, ...change.after }]));
    let old = 0;
    let added = 0;
    fixtures.forEach((a, i) => fixtures.slice(i + 1).forEach(b => {
      if (overlaps(a, b)) old++;
      else if (overlaps(mapped.get(a.id) ?? a, mapped.get(b.id) ?? b)) added++;
    }));
    expect(result.priorOverlapPairs).toBe(old);
    expect(result.newOverlapPairs).toBe(added);
    const shorter = createCalibrationPreview([cue('x', 1000, 1510), cue('y', 1300, 2800)], {
      subtitle1: 0, video1: 0, subtitle2: 1000, video2: 900,
    });
    expect(shorter.priorOverlapPairs).toBe(1);
    expect(shorter.newOverlapPairs).toBe(0);
    expect(shorter.newlyShortCount).toBe(1);
  });

  it('calculates 50,000 intervals without expanding every overlapping pair', () => {
    const cues = Array.from({ length: 50_000 }, (_, i) => cue(String(i), i, i + 100_000));
    const started = performance.now();
    const result = createCalibrationPreview(cues, drift);
    expect(result.changes).toHaveLength(50_000);
    expect(result.priorOverlapPairs).toBe(50_000 * 49_999 / 2);
    expect(result.newOverlapPairs).toBe(0);
    console.info('50,000 timing-only intervals in ' + (performance.now() - started).toFixed(2) + ' ms');
  });
});
