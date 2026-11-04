import { describe, expect, it } from 'vitest';
import { decodeBytes, parseSubtitle } from '../core';
import { createFileProcessor, type ProcessingOptions } from './processing-service';
import type { ImportedFile } from './file-service';
import { executeProcessingRequest } from '../workers/worker-logic';

const options: ProcessingOptions = { outputEncoding: 'utf-8', lineEnding: 'CRLF', fileNamePattern: '{name}_processed' };
const file = (name: string, text: string): ImportedFile => {
  const bytes = new TextEncoder().encode(text);
  return { id: name, name, bytes, size: bytes.length };
};
const examples = [
  {
    name: '原编号.srt',
    text: '  008\r\n00:00:01.234 --> 00:00:02,345\r\n<i title="简体">头发与发现</i>\r\nEnglish 😀\r\n\r\n8\n00:00:04,000 --> 00:00:05,000\n后面\n',
    expected: '  008\r\n00:00:01.234 --> 00:00:02,345\r\n<i title="简体">頭髮與發現</i>\r\nEnglish 😀\r\n\r\n8\n00:00:04,000 --> 00:00:05,000\n後面\n',
  },
  {
    name: '带时间.txt',
    text: '42\n00:00:01,234 --> 00:00:02,345\n头发\n理发\n',
    expected: '42\n00:00:01,234 --> 00:00:02,345\n頭髮\n理髮\n',
  },
  {
    name: '缺号与末行.srt',
    text: '\ufeff00:00:01,123 --> 00:00:02,456\r头发  \r \r0009\r00:00:03,000 --> 00:00:04,000\r理发',
    // The original UTF-8 signature is controlled by the explicit output encoding.
    expected: '00:00:01,123 --> 00:00:02,456\r頭髮  \r \r0009\r00:00:03,000 --> 00:00:04,000\r理髮',
  },
  {
    name: '样式.vtt',
    text: 'WEBVTT 示例头发\r\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\r\n\r\nSTYLE\r\n::cue { color: red; }\r\n\r\nNOTE 头发\r\n注释保留\r\n\r\nfirst-中文\r\n00:01.234 --> 00:02.345 align:start position:20%\r\n<v 说话人>头发</v>\r\n\r\nsecond\r\n00:04.000 --> 00:05.000\r\n后面\r\n',
    expected: 'WEBVTT 示例头发\r\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\r\n\r\nSTYLE\r\n::cue { color: red; }\r\n\r\nNOTE 头发\r\n注释保留\r\n\r\nfirst-中文\r\n00:01.234 --> 00:02.345 align:start position:20%\r\n<v 说话人>頭髮</v>\r\n\r\nsecond\r\n00:04.000 --> 00:05.000\r\n後面\r\n',
  },
  {
    name: '列序.csv',
    text: 'text,end,index,start\r\n"头发,\r\n他说""发现""","00:00:02,345",008,"00:00:01,234"\r\n后面,"00:00:05,000",19,"00:00:04,000"\r\n',
    expected: 'text,end,index,start\r\n"頭髮,\r\n他說""發現""","00:00:02,345",008,"00:00:01,234"\r\n後面,"00:00:05,000",19,"00:00:04,000"\r\n',
  },
  {
    name: '中间正文.csv',
    text: 'INDEX,text,START,end\r\n7,"","00:00:01,234","00:00:02,345"\r\n\r\n08,头发,"00:00:03,000","00:00:04,000"',
    expected: 'INDEX,text,START,end\r\n7,"","00:00:01,234","00:00:02,345"\r\n\r\n08,頭髮,"00:00:03,000","00:00:04,000"',
  },
  {
    name: '格式切换.ass',
    text: '[Script Info]\nTitle: 保留\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.23,0:00:02.34,{\\fn字体}头发\nFormat: End, Layer, Start, Text\nDialogue: 0:00:04.56,2,0:00:03.45,理发',
    expected: '[Script Info]\nTitle: 保留\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.23,0:00:02.34,{\\fn字体}頭髮\nFormat: End, Layer, Start, Text\nDialogue: 0:00:04.56,2,0:00:03.45,理髮',
  },
  {
    name: '区域.vtt',
    text: 'WEBVTT\n\nREGION\nid:区域\nwidth:40%\n\n字幕标识\n00:01.234 --> 00:02.345 region:区域\n<v 说话人>头发</v><00:01.500>发现',
    expected: 'WEBVTT\n\nREGION\nid:区域\nwidth:40%\n\n字幕标识\n00:01.234 --> 00:02.345 region:区域\n<v 说话人>頭髮</v><00:01.500>發現',
  },
  ...(['ass', 'ssa'] as const).map(extension => ({
    name: `样式.${extension}`,
    text: '[Script Info]\r\nTitle: 头发\r\nScriptType: v4.00+\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname\r\nStyle: 简体,微软雅黑\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nComment: 0,0:00:00.00,0:00:01.00,简体,,0,0,0,,头发\r\nDialogue: 2,0:00:01.23,0:00:02.34,简体,说话人,10,20,30,,{\\fn微软雅黑\\an8}头发\\N理发\\h发现\r\n',
    expected: '[Script Info]\r\nTitle: 头发\r\nScriptType: v4.00+\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname\r\nStyle: 简体,微软雅黑\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nComment: 0,0:00:00.00,0:00:01.00,简体,,0,0,0,,头发\r\nDialogue: 2,0:00:01.23,0:00:02.34,简体,说话人,10,20,30,,{\\fn微软雅黑\\an8}頭髮\\N理髮\\h發現\r\n',
  })),
];

describe('Chinese conversion through the real worker entry', () => {
  it.each(examples)('rewrites only the source bodies of $name', ({ name, text, expected }) => {
    const input = file(name, text);
    const snapshot = Uint8Array.from(input.bytes);
    const task = executeProcessingRequest({ kind: 'file', files: [input], operation: 'chinese', params: { direction: 's2t' }, options });
    expect(task.status, task.errorMessage).toBe('success');
    expect(task.outputs).toHaveLength(1);
    const [output] = task.outputs;
    expect(output.text).toBe(expected);
    expect(decodeBytes(output.bytes).text).toBe(expected);
    expect(input.bytes).toEqual(snapshot);
    const parsed = parseSubtitle(expected, name).document;
    expect(output.document?.cues).toEqual(parsed.cues.map((cue, index) => ({ ...cue, id: task.document!.cues[index].id })));
    expect(output.document?.cues.map(cue => [cue.index, cue.startMs, cue.endMs]))
      .toEqual(task.document?.cues.map(cue => [cue.index, cue.startMs, cue.endMs]));
    expect(output.document?.format).toBe(name.split('.').at(-1));
    expect(task.diagnostics.filter(diagnostic => diagnostic.code === 'LOSSY_ASS' || diagnostic.code === 'LOSSY_VTT')).toEqual([]);
  });

  it('supports the explicit reverse direction and keeps an empty cue or English-only body', () => {
    const source = '7\n00:00:01,000 --> 00:00:02,000\n頭髮與發現\n\n9\n00:00:03,000 --> 00:00:04,000\n\n11\n00:00:05,000 --> 00:00:06,000\nEnglish 😀\n';
    const task = executeProcessingRequest({ kind: 'file', files: [file('reverse.srt', source)], operation: 'chinese', params: { direction: 't2s' }, options });
    expect(task.status, task.errorMessage).toBe('success');
    expect(task.outputs[0].text).toBe(source.replace('頭髮與發現', '头发与发现'));
  });

  it('isolates invalid markup and structural damage and continues a later batch file', async () => {
    const processor = createFileProcessor(async request => executeProcessingRequest(request));
    const tasks = await processor([
      file('markup.srt', '1\n00:00:01,000 --> 00:00:02,000\n<i title="坏标记>头发\n'),
      file('damaged.srt', '字幕没有时间'),
      file('good.srt', '8\n00:00:01,000 --> 00:00:02,000\n头发\n'),
    ], 'chinese', { direction: 's2t' }, options);
    expect(tasks.map(task => task.status)).toEqual(['failed', 'failed', 'success']);
    expect(tasks[0].errorMessage).toContain('第 1 条');
    expect(tasks[0].outputs).toEqual([]);
    expect(tasks[1].outputs).toEqual([]);
    expect(tasks[2].outputs[0].text).toContain('頭髮');
  });

  it('keeps the original encoding-confirmation gate', () => {
    const input = file('suspect.srt', '1\n00:00:01,000 --> 00:00:02,000\n头发�\n');
    const task = executeProcessingRequest({ kind: 'file', files: [input], operation: 'chinese', params: { direction: 's2t' }, options });
    expect(task).toMatchObject({ status: 'failed', errorCode: 'UNCERTAIN_ENCODING', outputs: [] });
  });

  it('captures layout only on request and preserves literal leading U+FEFF in source offsets', () => {
    const text = '\ufeff8\r\n00:00:01,000 --> 00:00:02,000\r\n头发';
    expect(parseSubtitle(text, 'source.srt').bodySpans).toBeUndefined();
    const parsed = parseSubtitle(text, 'source.srt', { captureBodies: true });
    expect(parsed.bodySpans?.map(span => text.slice(span.start, span.end))).toEqual(['头发']);
  });
});
