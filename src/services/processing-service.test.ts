import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBytes, parseSubtitle } from '../core';
import type { ImportedFile } from './file-service';
import { createFileProcessor, runWorkerRequest, type ProcessingOptions, type ProcessingRequest, type WorkerReply } from './processing-service';
import { executeProcessingRequest } from '../workers/worker-logic';

const options: ProcessingOptions = { outputEncoding: 'utf-8', lineEnding: 'CRLF', fileNamePattern: '{name}_processed' };
const sample = '1\n00:00:01,000 --> 00:00:02,000\nHello 世界\nSecond line\n';
const file = (name = 'sample.srt', text = sample): ImportedFile => {
  const bytes = new TextEncoder().encode(text);
  return { id: name, name, bytes, size: bytes.length };
};

describe('file → processing → export integration', () => {
  it('substitutes filename tokens once and preserves dollar signs and braces in the source name', () => {
    const task = executeProcessingRequest({
      kind: 'file', files: [file("字幕 $& $' {index}.srt")], operation: 'renumber', params: {},
      options: { ...options, fileNamePattern: '{name}_{index}' },
    });
    expect(task.outputs[0]?.name).toBe("字幕 $& $' {index}_1.srt");
  });

  it('reports an empty input without making an empty processed subtitle available for export', () => {
    const input = file('empty.srt', '');
    const request: ProcessingRequest = { kind: 'file', files: [input], operation: 'renumber', params: {}, options };
    const failed = executeProcessingRequest(request);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'EMPTY_DOCUMENT', outputs: [] });
    expect(failed.diagnostics.some(diagnostic => diagnostic.code === 'EMPTY_FILE')).toBe(true);
    const report = executeProcessingRequest({ ...request, operation: 'detect' });
    expect(report).toMatchObject({ status: 'success', outputs: [{ name: 'empty_processed.json' }] });
  });

  it('processes a real multiline subtitle and exports round-trippable UTF-16', () => {
    const task = executeProcessingRequest({
      kind: 'file', files: [file()], operation: 'replace', params: { find: 'Hello', replacement: '你好', caseSensitive: true },
      options: { ...options, outputEncoding: 'utf-16be' },
    });
    expect(task.status).toBe('success');
    expect(task.outputs[0].name).toBe('sample_processed.srt');
    const decoded = decodeBytes(task.outputs[0].bytes);
    expect(decoded.encoding).toBe('UTF-16 BE');
    const result = parseSubtitle(decoded.text, task.outputs[0].name);
    expect(result.document.cues[0].text).toBe('你好 世界\nSecond line');
    expect(task.document?.cues[0].text).toBe('Hello 世界\nSecond line');
  });

  it('reports parse damage and blocks output that could lose malformed content', () => {
    const input = file('broken.srt', `${sample}\n2\nnot a timestamp\nDo not silently discard me`);
    const failed = executeProcessingRequest({ kind: 'file', files: [input], operation: 'renumber', params: {}, options });
    expect(failed.status).toBe('failed');
    expect(failed.outputs).toEqual([]);
    expect(failed.errorCode).toBe('PARSE_ERRORS');
    const detected = executeProcessingRequest({ kind: 'file', files: [input], operation: 'detect', params: {}, options });
    expect(detected.status).toBe('success');
    expect(detected.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(detected.outputs[0].name).toBe('broken_processed.json');
    expect(detected.outputs[0].text).not.toContain('Do not silently discard me');
  });

  it('allows invalid-time detection and requires explicit repair before exporting', () => {
    const input = file('invalid.srt', '1\n00:00:03,000 --> 00:00:02,000\nTest');
    const detected = executeProcessingRequest({ kind: 'file', files: [input], operation: 'detect', params: {}, options });
    expect(detected.status).toBe('success');
    expect(detected.diagnostics.some((diagnostic) => diagnostic.code === 'INVALID_CUE_TIME')).toBe(true);
    const repaired = executeProcessingRequest({ kind: 'file', files: [input], operation: 'repair', params: { invalidTime: 'extend', durationMs: 1000 }, options });
    expect(repaired.status).toBe('success');
    expect(repaired.outputs[0].document?.cues[0].endMs).toBe(4000);
    expect(repaired.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(repaired.inputDiagnostics?.some((diagnostic) => diagnostic.code === 'INVALID_CUE_TIME')).toBe(true);
    expect(detected.diagnostics.filter((diagnostic) => diagnostic.code === 'INVALID_CUE_TIME')).toHaveLength(1);
  });

  it('exports metadata rather than subtitle text for the information tool', () => {
    const task = executeProcessingRequest({ kind: 'file', files: [file()], operation: 'info', params: {}, options });
    const report = JSON.parse(task.outputs[0].text) as { cueCount: number; characterCount: number; startMs: number; endMs: number };
    expect(report).toMatchObject({ cueCount: 1, startMs: 1000, endMs: 2000 });
    expect(report.characterCount).toBeGreaterThan(10);
    expect(task.outputs[0].text).not.toContain('Hello 世界');
  });

  it('merges in the selected order while preserving original cue times', () => {
    const first = file('first.srt', '1\n00:00:03,000 --> 00:00:04,000\nFirst');
    const second = file('second.srt', '1\n00:00:01,000 --> 00:00:02,000\nSecond');
    const task = executeProcessingRequest({ kind: 'combined', files: [first, second], operation: 'merge', params: { strategy: 'time' }, options });
    expect(task.status).toBe('success');
    expect(task.outputs[0].document?.cues.map((cue) => cue.text)).toEqual(['Second', 'First']);
    expect(task.outputs[0].document?.cues.map((cue) => cue.startMs)).toEqual([1000, 3000]);
    expect(task.document?.cues.map((cue) => cue.text)).toEqual(['First', 'Second']);
  });

  it('blocks suspected encoding damage in automatic mode and permits an explicit override with a warning', () => {
    const input = file('suspect.srt', sample.replace('Hello', 'Hel\ufffdo'));
    const automatic = executeProcessingRequest({ kind: 'file', files: [input], operation: 'renumber', params: {}, options });
    expect(automatic).toMatchObject({ status: 'failed', errorCode: 'UNCERTAIN_ENCODING' });
    expect(automatic.document?.cues[0].text).toContain('Hel\ufffdo');
    expect(automatic.outputs).toEqual([]);
    const manual = executeProcessingRequest({ kind: 'file', files: [input], operation: 'renumber', params: {}, options: { ...options, encoding: 'utf-8' } });
    expect(manual.status).toBe('success');
    expect(manual.diagnostics.some((diagnostic) => diagnostic.code === 'SUSPECT_ENCODING')).toBe(true);
  });

  it('preserves earlier diagnostics and source names when a combined input fails to read', () => {
    const first = file('first.srt', '5\n00:00:01,000 --> 00:00:02,000\nFirst');
    const second = { ...file('second.srt'), error: '文件读取失败。' };
    const task = executeProcessingRequest({ kind: 'combined', files: [first, second], operation: 'merge', params: {}, options });
    expect(task).toMatchObject({ status: 'failed', errorCode: 'READ_FAILED' });
    expect(task.errorMessage).toContain('second.srt');
    expect(task.diagnostics.some((diagnostic) => diagnostic.message.startsWith('first.srt：'))).toBe(true);
    expect(task.document?.cues[0].text).toBe('First');
  });
});

describe('sequential batch isolation and cancellation', () => {
  it('uses original queue indices in filenames, including when retrying a subset', async () => {
    const inputs = [file('a.srt'), file('b.srt'), file('c.srt')];
    const processFiles = createFileProcessor(async (request) => executeProcessingRequest(request));
    const batchOptions = { ...options, fileNamePattern: 'subtitle_{index}' };
    const tasks = await processFiles(inputs, 'renumber', {}, batchOptions);
    expect(tasks.map((task) => task.outputs[0].name)).toEqual(['subtitle_1.srt', 'subtitle_2.srt', 'subtitle_3.srt']);
    const retryOptions = { ...batchOptions, fileIndexes: Object.fromEntries(inputs.map((input, index) => [input.id, index + 1])) };
    const retried = await processFiles([inputs[2]], 'renumber', {}, retryOptions);
    expect(retried[0].outputs[0].name).toBe('subtitle_3.srt');
  });

  it('preserves import failures as failed tasks instead of treating empty bytes as a valid file', async () => {
    const processFiles = createFileProcessor(async (request) => executeProcessingRequest(request));
    const unavailable = { ...file('unreadable.srt'), bytes: new Uint8Array(), error: '文件读取失败：文件已被删除。' };
    const tasks = await processFiles([unavailable, file('ok.srt')], 'renumber', {}, options);
    expect(tasks[0]).toMatchObject({ status: 'failed', errorCode: 'READ_FAILED', errorMessage: unavailable.error });
    expect(tasks[0].outputs).toEqual([]);
    expect(tasks[1].status).toBe('success');
  });

  it('a failed file does not prevent later files from succeeding', async () => {
    const states: string[] = [];
    const processFiles = createFileProcessor(async (request) => executeProcessingRequest(request));
    const tasks = await processFiles([
      file('good.srt'), file('bad.srt', 'unparseable text'), file('after.srt'),
    ], 'renumber', {}, options, (task) => states.push(`${task.inputName}:${task.status}`));
    expect(tasks.map((task) => task.status)).toEqual(['success', 'failed', 'success']);
    expect(states).toContain('bad.srt:failed');
    expect(states.at(-1)).toBe('after.srt:success');
  });

  it('cancels queued items after the current result without writing files', async () => {
    const controller = new AbortController();
    let requests = 0;
    const processFiles = createFileProcessor(async (request) => {
      requests++;
      const result = executeProcessingRequest(request);
      controller.abort();
      return result;
    });
    const tasks = await processFiles([file('a.srt'), file('b.srt'), file('c.srt')], 'renumber', {}, options, undefined, controller.signal);
    expect(requests).toBe(1);
    expect(tasks.map((task) => task.status)).toEqual(['success', 'cancelled', 'cancelled']);
    expect(tasks[1].outputs).toEqual([]);
  });

  it('isolates unexpected worker crashes and continues with the next file', async () => {
    const processFiles = createFileProcessor(async (request) => {
      if (request.files[0].name === 'crash.srt') throw new Error('Worker terminated');
      return executeProcessingRequest(request);
    });
    const tasks = await processFiles([file('crash.srt'), file('ok.srt')], 'renumber', {}, options);
    expect(tasks[0]).toMatchObject({ status: 'failed', errorMessage: 'Worker terminated' });
    expect(tasks[1].status).toBe('success');
  });
});

describe('worker lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  class ControlledWorker {
    static instances: ControlledWorker[] = [];
    onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    sent?: { requestId: string; request: ProcessingRequest };
    terminations = 0;
    constructor() { ControlledWorker.instances.push(this); }
    postMessage(message: { requestId: string; request: ProcessingRequest }) { this.sent = message; }
    terminate() { this.terminations++; }
  }

  it('terminates an in-flight worker on abort and does not create a worker for an already aborted job', async () => {
    ControlledWorker.instances = [];
    vi.stubGlobal('Worker', ControlledWorker);
    const controller = new AbortController();
    const request: ProcessingRequest = { kind: 'file', files: [file()], operation: 'renumber', params: {}, options };
    const pending = runWorkerRequest(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances[0].terminations).toBe(1);
    await expect(runWorkerRequest(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances).toHaveLength(1);
  });

  it('terminates completed workers, ignores unrelated replies, and removes the abort listener', async () => {
    ControlledWorker.instances = [];
    vi.stubGlobal('Worker', ControlledWorker);
    const controller = new AbortController();
    const request: ProcessingRequest = { kind: 'file', files: [file()], operation: 'renumber', params: {}, options };
    const pending = runWorkerRequest(request, controller.signal);
    const worker = ControlledWorker.instances[0];
    const result = executeProcessingRequest(request);
    worker.onmessage?.({ data: { requestId: 'unrelated', result } } as MessageEvent<WorkerReply>);
    expect(worker.terminations).toBe(0);
    worker.onmessage?.({ data: { requestId: worker.sent!.requestId, result } } as MessageEvent<WorkerReply>);
    expect(await pending).toMatchObject({ status: 'success' });
    controller.abort();
    expect(worker.terminations).toBe(1);
  });
});

