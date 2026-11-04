import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { decodeBytes } from '../core';
import { executeProcessingRequest } from '../workers/worker-logic';
import { createFileProcessor, type ProcessingOptions } from './processing-service';
import { createZip } from './export-service';
import type { ImportedFile } from './file-service';

const options: ProcessingOptions = { outputEncoding: 'gbk', lineEnding: 'CRLF', fileNamePattern: '{name}_processed' };
function input(name: string, text = '中文'): ImportedFile {
  const bytes = new TextEncoder().encode(`7\n00:00:01,234 --> 00:00:02,345\n${text}\n`);
  return { id: name, name, bytes, size: bytes.length };
}

describe('legacy bytes through worker and ZIP', () => {
  it.each(['gbk', 'gb18030'])('uses identical %s bytes for single-file and batch ZIP outputs', async outputEncoding => {
    const files = [input('中文.srt'), input('同名.srt')];
    const snapshots = files.map(file => Uint8Array.from(file.bytes));
    const processor = createFileProcessor(async request => executeProcessingRequest(request));
    const tasks = await processor(files, 'encoding', {}, { ...options, outputEncoding });
    expect(tasks.map(task => task.status)).toEqual(['success', 'success']);
    const outputs = tasks.flatMap(task => task.outputs);
    const zip = await JSZip.loadAsync(await createZip(outputs));
    for (const output of outputs) {
      expect(await zip.file(output.name)!.async('uint8array')).toEqual(output.bytes);
      expect(output.bytes.slice(-6)).toEqual(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 13, 10]));
      expect(decodeBytes(output.bytes, outputEncoding).text).toBe(output.text);
    }
    expect(files.map(file => file.bytes)).toEqual(snapshots);
  });

  it('reports the cue and scalar for GBK failures, then processes the next file', async () => {
    const file = input('emoji.srt', '正常\n😀');
    const processor = createFileProcessor(async request => executeProcessingRequest(request));
    const tasks = await processor([file, input('next.srt')], 'encoding', {}, options);
    expect(tasks.map(task => task.status)).toEqual(['failed', 'success']);
    expect(tasks[0].errorMessage).toContain('第 1 条');
    expect(tasks[0].errorMessage).toContain('😀');
    expect(tasks[0].errorMessage).toContain('U+1F600');
    expect(tasks[0].errorMessage).toContain('GB18030');
    expect(tasks[0].outputs).toEqual([]);
  });

  it('retains cue context for pure TXT output and supported spelling aliases', () => {
    const task = executeProcessingRequest({
      kind: 'file', files: [input('extract.srt', '😀')], operation: 'extract', params: {},
      options: { ...options, outputEncoding: 'GB_K' },
    });
    expect(task).toMatchObject({ status: 'failed', outputs: [] });
    expect(task.errorMessage).toContain('第 7 条字幕');
    expect(task.errorMessage).toContain('U+1F600');
  });

  it('locates strict encoding errors in preserved Chinese bodies and raw ASS controls', () => {
    const chinese = executeProcessingRequest({ kind: 'file', files: [input('中文.srt', '头发 😀')], operation: 'chinese', params: { direction: 's2t' }, options });
    expect(chinese).toMatchObject({ status: 'failed', outputs: [] });
    expect(chinese.errorMessage).toContain('第 7 条');
    expect(chinese.errorMessage).toContain('😀');
    const ass = input('style.ass');
    ass.bytes = new TextEncoder().encode('[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,{\\fn😀}头发');
    const styled = executeProcessingRequest({ kind: 'file', files: [ass], operation: 'chinese', params: { direction: 's2t' }, options });
    expect(styled.errorMessage).toContain('第 1 条');
    expect(styled.errorMessage).toContain('😀');
    expect(styled.outputs).toEqual([]);
  });

  it('refuses unrepresentable output headers and comparison report metadata as a whole', () => {
    const ass = input('header.ass');
    ass.bytes = new TextEncoder().encode('[Script Info]\nTitle: 😀\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,头发');
    const header = executeProcessingRequest({ kind: 'file', files: [ass], operation: 'chinese', params: { direction: 's2t' }, options });
    expect(header.errorMessage).toContain('输出头部或报告元数据');
    expect(header.errorMessage).toContain('😀');
    expect(header.outputs).toEqual([]);
    const report = executeProcessingRequest({ kind: 'combined', files: [input('第一份😀.srt'), input('第二份.srt')], operation: 'compare', params: {}, options });
    expect(report).toMatchObject({ status: 'failed', outputs: [] });
    expect(report.errorMessage).toContain('输出头部或报告元数据');
    expect(report.errorMessage).toContain('😀');
  });
});
