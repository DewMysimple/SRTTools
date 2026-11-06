import { expect, it } from 'vitest';
import { decodeBytes, encodeText } from '../../core/encoding';
import { parseSubtitle } from '../../core/parser';
import type { ProcessingRequest } from '../../services/processing-service';
import { executeProcessingRequest } from '../../workers/worker-logic';
import { buildTimelineOutput } from './timeline-document-service';

const text = '1\r\n00:00:00,000 --> 01:00:02,345\r\n中文 😀\r\n第二行\r\n';

function readFixture(encoding: string, options: { fileName?: string; text?: string; inputEncoding?: string } = {}) {
  const bytes = encodeText(options.text ?? text, encoding);
  const request: ProcessingRequest = {
    kind: 'timeline', operation: '', params: {},
    files: [{ id: 'fixture', name: options.fileName ?? '中文 #.srt', bytes, size: bytes.length }],
    options: { encoding: options.inputEncoding, outputEncoding: 'UTF-8', lineEnding: 'LF', fileNamePattern: '{name}' },
  };
  return executeProcessingRequest(request);
}

it.each(['UTF-8', 'UTF-8 BOM', 'UTF-16 LE', 'UTF-16 BE', 'GB18030'])('round-trips %s with exact line endings and Unicode', encoding => {
  const task = readFixture(encoding, { inputEncoding: encoding === 'GB18030' ? encoding : undefined });
  expect(task.status).toBe('success');
  const document = task.document!;
  expect(document.encoding).toBe(encoding);
  expect(document.lineEnding).toBe('CRLF');
  const saved = buildTimelineOutput(document);
  expect(saved.name).toBe('中文 #_timed.srt');
  expect(saved.bytes).toEqual(encodeText(text, encoding));
  const parsed = parseSubtitle(decodeBytes(saved.bytes, encoding).text, saved.name);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.document.cues[0]).toMatchObject({ startMs: 0, endMs: 3_602_345, text: '中文 😀\n第二行' });
});

it('retains parsed cue diagnostics and rejects implicit format conversion and invalid or lossy export', () => {
  expect(readFixture('UTF-8', { fileName: 'styles.ass' }).errorCode).toBe('UNSUPPORTED_FORMAT');
  const damaged = readFixture('UTF-8', { text: '前言\r\n' + text });
  expect(damaged.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ORPHAN_CONTENT', severity: 'error' })]));
  const invalidTime = readFixture('UTF-8', { text: text.replace('01:00:02,345', '00:00:00,000') }).document!;
  expect(() => buildTimelineOutput(invalidTime)).toThrow('结束时间必须晚于开始时间');
  const document = readFixture('UTF-8').document!;
  expect(() => buildTimelineOutput(document, 'GBK')).toThrow('GBK');
  document.cues[0].text = '有空行\n\n后面';
  expect(() => buildTimelineOutput(document)).toThrow('无法无损导出');
});
