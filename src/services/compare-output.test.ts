import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareDocuments, decodeBytes, encodeText, formatTimestamp, type SubtitleCue } from '../core';
import { buildSubtitleDiff } from '../core/diff/subtitle-diff';
import { executeProcessingRequest } from '../workers/worker-logic';
import type { ImportedFile } from './file-service';
import type { ProcessedTask, ProcessingOptions } from './processing-service';

const options: ProcessingOptions = { outputEncoding: 'utf-8', lineEnding: 'CRLF', fileNamePattern: '{name}_processed' };
const cue = (index: number, text = `独立字幕 ${index}`): SubtitleCue => ({
  id: `cue-${index}`, index, startMs: index * 1000, endMs: index * 1000 + 500, text,
});
function file(name: string, cues: readonly SubtitleCue[]): ImportedFile {
  const text = cues.map(item => `${item.index}\n${formatTimestamp(item.startMs)} --> ${formatTimestamp(item.endMs)}\n${item.text}\n`).join('\n');
  const bytes = new TextEncoder().encode(text);
  return { id: name, name, bytes, size: bytes.byteLength };
}
function compare(before: readonly SubtitleCue[], after: readonly SubtitleCue[], toleranceMs = 0, outputOptions = options) {
  return executeProcessingRequest({
    kind: 'combined', operation: 'compare', files: [file('before.srt', before), file('after.srt', after)],
    params: { toleranceMs }, options: outputOptions,
  });
}
function comparison(task: ProcessedTask) {
  expect(task.status).toBe('success');
  if (!task.comparison) throw new Error('Expected in-memory comparison documents');
  return task.comparison;
}
function expectSharedSummary(task: ProcessedTask) {
  const { before, after, toleranceMs } = comparison(task);
  const logical = buildSubtitleDiff(before.cues, after.cues, { trustIds: false, timeToleranceMs: toleranceMs });
  const report = JSON.parse(task.outputs[0].text);
  const metadata = logical.kind === 'aligned' ? { kind: logical.kind, summary: logical.summary } : logical;
  expect(report.visualComparison).toEqual({ mode: 'logical', timeToleranceMs: toleranceMs, ...metadata });
  expect(decodeBytes(task.outputs[0].bytes).text).toBe(task.outputs[0].text);
  expect(report.summary).toBe(task.summary);
  expect(report.diagnostics).toEqual(task.diagnostics);
  return report.visualComparison;
}

afterEach(() => vi.restoreAllMocks());

describe('independent subtitle comparison output', () => {
  it('retains two original documents in memory and exports only a shared logical summary', () => {
    const original = [cue(1, '私人完整正文 😀 e\u0301'), cue(2, '另一句私人正文')];
    const task = compare(original, original, 25, { ...options, outputEncoding: 'utf-16le' });
    const memory = comparison(task);
    expect(memory.before).not.toBe(memory.after);
    expect(memory.before.cues.map(item => item.text)).toEqual(original.map(item => item.text));
    expect(memory.after.cues.map(item => item.text)).toEqual(original.map(item => item.text));
    expect(memory.toleranceMs).toBe(25);
    expect(task.outputs[0].document).toBeUndefined();
    expect(expectSharedSummary(task)).toMatchObject({ kind: 'aligned', summary: { unchanged: 2, affected: 0 } });
    expect(task.diagnostics).toEqual([]);
    for (const text of original.map(item => item.text)) expect(task.outputs[0].text).not.toContain(text);
    expect(task.outputs[0].text).not.toMatch(/"(?:cues|rows|text|before|after)"/u);
  });

  it('never trusts colliding parser IDs from independent files', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const task = compare([cue(1, '原文私密句')], [{ ...cue(1, '另一来源私密句'), startMs: 8000, endMs: 8500 }]);
    const memory = comparison(task);
    expect(memory.before.cues[0].id).toBe(memory.after.cues[0].id);
    expect(expectSharedSummary(task)).toMatchObject({ summary: { ambiguous: 2, textChanged: 0, timeChanged: 0 } });
    expect(task.diagnostics.map(item => item.code)).toEqual(['TEXT_DIFFERENT', 'TIME_DIFFERENT']);
  });

  it('reports logical insertion and deletion separately while preserving positional diagnostics', () => {
    const before = [cue(1), cue(2), cue(3), cue(4)];
    const after = [before[0], before[2], cue(8, '新增私密正文'), before[3]];
    const task = compare(before, after);
    const memory = comparison(task);
    expect(task.diagnostics.filter(item => /^(TEXT_DIFFERENT|TIME_DIFFERENT|MISSING_CUE)$/u.test(item.code)))
      .toEqual(compareDocuments(memory.before, memory.after));
    expect(task.diagnostics.some(item => item.code === 'NONCONTINUOUS_INDEX')).toBe(true);
    expect(task.summary).toBe(`对比完成，共 ${task.diagnostics.length} 条问题或差异`);
    expect(expectSharedSummary(task)).toMatchObject({ summary: { added: 1, removed: 1, unchanged: 3, ambiguous: 0 } });
    expect(task.outputs[0].text).not.toContain('新增私密正文');
  });

  it('recognizes reordered and renumbered cues without false text or time changes', () => {
    const before = [cue(1, '同句'), cue(2, '同句'), cue(3, '保留')];
    const after = [{ ...before[1], index: 9 }, before[0], before[2]];
    expect(expectSharedSummary(compare(before, after))).toMatchObject({
      summary: { reordered: 2, indexChanged: 1, textChanged: 0, timeChanged: 0 },
    });
    const duplicate = cue(1, '完全重复');
    expect(expectSharedSummary(compare([duplicate, { ...duplicate, index: 2 }], [duplicate]))).toMatchObject({
      summary: { ambiguous: 3, added: 0, removed: 0 },
    });
  });

  it('uses the same inclusive tolerance for the logical report and original positional comparison', () => {
    const before = [cue(1, 'emoji 👨‍👩‍👧‍👦 e\u0301'), cue(2)];
    const after = before.map((item, index) => ({ ...item, startMs: item.startMs + 50, endMs: item.endMs + 50 + index }));
    const task = compare(before, after, 50);
    expect(expectSharedSummary(task)).toMatchObject({ timeToleranceMs: 50, summary: { timeChanged: 1, unchanged: 1 } });
    expect(task.diagnostics.map(item => item.code)).toEqual(['TIME_DIFFERENT']);
    expect(expectSharedSummary(compare(before, after))).toMatchObject({ summary: { timeChanged: 2 } });
  });

  it('keeps the legacy diagnostic report but withholds logical comparison when either source has parsing errors', () => {
    const valid = file('valid.srt', [cue(1, '不能被声称已删除的私人正文')]);
    const bytes = new TextEncoder().encode('损坏输入没有时间结构');
    const malformed = { id: 'malformed', name: 'malformed.srt', bytes, size: bytes.length };
    for (const files of [[valid, malformed], [malformed, valid]]) {
      const task = executeProcessingRequest({ kind: 'combined', operation: 'compare', files, params: { toleranceMs: 10 }, options });
      expect(task.status).toBe('success');
      expect(task.comparison).toBeUndefined();
      expect(task.comparisonUnavailable).toBe('input-errors');
      expect(task.diagnostics.some(item => item.severity === 'error')).toBe(true);
      const report = JSON.parse(task.outputs[0].text);
      expect(report.visualComparison).toEqual({ mode: 'logical', timeToleranceMs: 10, kind: 'unavailable', reason: 'input-errors' });
      expect(report.diagnostics).toEqual(task.diagnostics);
      expect(report.summary).toBe(`对比完成，共 ${task.diagnostics.length} 条问题或差异`);
      expect(task.outputs[0].text).not.toContain('不能被声称已删除的私人正文');
    }
  });

  it('withholds guessed or suspect decoding until the user explicitly chooses an input encoding', () => {
    const original = file('guess.srt', [cue(1, '手动确认编码后可对比 😀')]);
    const bytes = encodeText(new TextDecoder().decode(original.bytes), 'utf-16le').slice(2);
    const guessed = { ...original, bytes, size: bytes.length };
    const suspected = file('suspect.srt', [cue(1, '已有替代字符 \ufffd')]);
    for (const [input, encoding] of [[guessed, 'utf-16le'], [suspected, 'utf-8']] as const) {
      const request = {
        kind: 'combined' as const, operation: 'compare', files: [input, { ...input, id: 'second', name: 'second.srt' }],
        params: { toleranceMs: 5 }, options,
      };
      const automatic = executeProcessingRequest(request);
      expect(automatic.status).toBe('success');
      expect(automatic.comparison).toBeUndefined();
      expect(automatic.comparisonUnavailable).toBe('uncertain-encoding');
      expect(JSON.parse(automatic.outputs[0].text).visualComparison).toEqual({
        mode: 'logical', timeToleranceMs: 5, kind: 'unavailable', reason: 'uncertain-encoding',
      });
      const manual = executeProcessingRequest({ ...request, options: { ...options, encoding } });
      expect(manual.comparisonUnavailable).toBeUndefined();
      expect(expectSharedSummary(manual)).toMatchObject({ kind: 'aligned', summary: { unchanged: 1 } });
    }
  });

  it('permits a genuinely empty source to show a real deletion without blocking warning-only inputs', () => {
    const task = compare([cue(1)], []);
    expect(task.comparisonUnavailable).toBeUndefined();
    expect(expectSharedSummary(task)).toMatchObject({ summary: { removed: 1, added: 0, ambiguous: 0 } });
  });

  it('keeps 5,000-cue text-budget fallback metadata free of subtitle bodies', () => {
    const cues = Array.from({ length: 5000 }, (_, index) => cue(index + 1, `${index}: ${'正文'.repeat(110)}`));
    const task = compare(cues, cues);
    expect(expectSharedSummary(task)).toEqual({
      mode: 'logical', timeToleranceMs: 0, kind: 'fallback', beforeCount: 5000, afterCount: 5000, reason: 'size-limit',
    });
    expect(task.outputs[0].text.length).toBeLessThan(2000);
    expect(task.outputs[0].text).not.toContain('正文');
    expect(task.diagnostics).toEqual([]);
    const smallText = Array.from({ length: 5001 }, (_, index) => cue(index + 1));
    expect(expectSharedSummary(compare(smallText, smallText))).toMatchObject({ kind: 'fallback', beforeCount: 5001 });
  });
});
