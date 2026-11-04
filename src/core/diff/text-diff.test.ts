import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffCueText } from './text-diff';

describe('cue text diff', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('highlights exactly one changed Chinese character and preserves the rest', () => {
    const result = diffCueText('我觉的这个方案。', '我觉得这个方案。');
    expect(result).toEqual({
      detailed: true,
      before: [{ kind: 'equal', text: '我觉' }, { kind: 'delete', text: '的' }, { kind: 'equal', text: '这个方案。' }],
      after: [{ kind: 'equal', text: '我觉' }, { kind: 'insert', text: '得' }, { kind: 'equal', text: '这个方案。' }],
    });
  });

  it('keeps emoji clusters, decomposed accents and line breaks intact', () => {
    const before = 'Hello\n👩🏽‍💻 e\u0301!';
    const after = 'Hello\n👩🏻‍💻 e\u0300!';
    const result = diffCueText(before, after);
    expect(result.before.filter(part => part.kind === 'delete').map(part => part.text)).toEqual(['👩🏽‍💻', 'e\u0301']);
    expect(result.after.filter(part => part.kind === 'insert').map(part => part.text)).toEqual(['👩🏻‍💻', 'e\u0300']);
    expect(result.before.map(part => part.text).join('')).toBe(before);
    expect(result.after.map(part => part.text).join('')).toBe(after);
  });

  it('keeps unchanged spans within the changed middle and handles empty strings', () => {
    const result = diffCueText('a + b', 'A + B');
    expect(result.before).toContainEqual({ kind: 'equal', text: ' + ' });
    expect(result.after).toContainEqual({ kind: 'equal', text: ' + ' });
    expect(diffCueText('', '换行\n正文')).toMatchObject({ before: [], after: [{ kind: 'insert', text: '换行\n正文' }] });
    expect(diffCueText('abc', 'abc')).toMatchObject({ before: [{ kind: 'equal', text: 'abc' }], after: [{ kind: 'equal', text: 'abc' }] });
  });

  it('uses whole text for oversized comparisons and when grapheme segmentation is unavailable', () => {
    const before = '长'.repeat(5000);
    expect(diffCueText(before, '短')).toEqual({
      detailed: false, before: [{ kind: 'equal', text: before }], after: [{ kind: 'equal', text: '短' }],
    });
    expect(diffCueText('甲'.repeat(300), '乙'.repeat(300)).detailed).toBe(false);

    vi.stubGlobal('Intl', { Segmenter: undefined });
    expect(diffCueText('👩‍💻', '👨‍💻')).toEqual({
      detailed: false, before: [{ kind: 'equal', text: '👩‍💻' }], after: [{ kind: 'equal', text: '👨‍💻' }],
    });
  });
});
