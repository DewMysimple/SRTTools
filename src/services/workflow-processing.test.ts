import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowStep, type WorkflowDefinition, type WorkflowStep, type WorkflowStepProgress } from '../core/workflow';
import { createWorkflowProcessor, MAX_WORKER_DURATION_MS, runWorkerRequest, type ProcessingOptions, type ProcessingRequest, type WorkerReply } from './processing-service';
import type { ImportedFile } from './file-service';
import { executeProcessingRequest } from '../workers/worker-logic';
import * as core from '../core';

const options: ProcessingOptions = { outputEncoding: 'utf-8', lineEnding: 'LF', fileNamePattern: '{name}_processed' };
const source = '4\n00:00:01,000 --> 00:00:03,000\n   \n\n7\n00:00:04,000 --> 00:00:06,000\n  Hello  世界 😀  \nSecond line\n';
const file = (name = 'sample.srt', text = source): ImportedFile => {
  const bytes = new TextEncoder().encode(text);
  return { id: name, name, size: bytes.byteLength, bytes };
};
const step = (operation: WorkflowStep['operation'], params?: Record<string, unknown>): WorkflowStep => {
  const result = createWorkflowStep(operation);
  return { ...result, params: { ...result.params, ...params } };
};
const flow = (steps: WorkflowStep[], lossyMode: WorkflowDefinition['lossyMode'] = 'reject'): WorkflowDefinition => ({ schemaVersion: 1, steps, lossyMode });
const request = (workflow: WorkflowDefinition, input = file()): ProcessingRequest => ({ kind: 'workflow', files: [input], operation: 'workflow', params: {}, options, workflow });

describe('one-read workflow worker integration', () => {
  it('decodes and parses the original once, then produces deterministic final bytes with actual output numbering', () => {
    const workflow = flow([step('remove-empty'), step('replace', { find: 'Hello', replacement: '你好' }), step('shift', { offsetMs: 500 })]);
    const decode = vi.spyOn(core, 'decodeBytes');
    const parse = vi.spyOn(core, 'parseSubtitle');
    const first = executeProcessingRequest(request(workflow));
    expect(first.status).toBe('success');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls.filter(call => call[1] === 'sample.srt')).toHaveLength(1);
    decode.mockRestore(); parse.mockRestore();
    const second = executeProcessingRequest(request(workflow));
    expect(first.outputs[0].bytes).toEqual(second.outputs[0].bytes);
    expect(first.outputs[0].text).toContain('1\n00:00:04,500 --> 00:00:06,500\n  你好');
    expect(first.diagnostics.some(item => item.code === 'IMPLICIT_RENUMBER')).toBe(true);
    expect(first.document?.cues).toHaveLength(2);
    expect(first.outputs[0].document?.cues).toHaveLength(1);
  });

  it('discards intermediate output on step failure and preserves step-specific diagnostics', async () => {
    const workflow = flow([step('replace', { find: 'Hello', replacement: 'Intermediate' }), step('shift', { offsetMs: -3000 }), step('renumber')]);
    const process = createWorkflowProcessor(async (job, signal, onStepProgress) => executeProcessingRequest(job, { signal, onStepProgress }));
    const good = file('later.srt', '1\n00:00:10,000 --> 00:00:12,000\nHello');
    const results = await process([file(), good], workflow, options);
    expect(results.map(task => task.status)).toEqual(['failed', 'success']);
    expect(results[0].outputs).toEqual([]);
    expect(results[0].workflow?.stepSummaries.map(summary => summary.status)).toEqual(['success', 'failed']);
    expect(results[0].diagnostics.some(item => item.stepId === workflow.steps[1].id && item.severity === 'error')).toBe(true);
  });

  it('uses the same path for preview/execution and emits step progress without full intermediate documents', async () => {
    const workflow = flow([step('remove-empty'), step('clean-spaces'), step('shift', { offsetMs: 500 })]);
    const process = createWorkflowProcessor(async (job, signal, onStepProgress) => executeProcessingRequest(job, { signal, onStepProgress }));
    const progress: WorkflowStepProgress[] = [];
    const preview = await process([file()], workflow, options, task => { if (task.workflow?.currentStep) progress.push(task.workflow.currentStep); });
    const execution = await process([file()], workflow, options);
    expect(preview[0].outputs[0].bytes).toEqual(execution[0].outputs[0].bytes);
    expect(progress.map(item => `${item.stepIndex}:${item.status}`)).toEqual(['0:processing', '0:success', '1:processing', '1:success', '2:processing', '2:success']);
    expect(JSON.stringify(progress)).not.toContain('Hello');
  });

  it('snapshots the configuration before asynchronous queue progress can mutate the editor', async () => {
    const workflow = flow([step('shift', { offsetMs: 500 })]);
    const process = createWorkflowProcessor(async job => executeProcessingRequest(job));
    const results = await process([file()], workflow, options, () => { workflow.steps[0].params.offsetMs = 9000; });
    expect(results[0].outputs[0].document?.cues[0].startMs).toBe(1500);
  });

  it('rejects encoding failures and malformed source structures without partial output', () => {
    const workflow = flow([step('clean-spaces')]);
    const gbk = executeProcessingRequest({ ...request(workflow), options: { ...options, outputEncoding: 'gbk' } });
    expect(gbk.status).toBe('failed'); expect(gbk.outputs).toEqual([]);
    const damaged = executeProcessingRequest(request(workflow, file('bad.srt', 'not a subtitle')));
    expect(damaged).toMatchObject({ status: 'failed', errorCode: 'PARSE_ERRORS', outputs: [] });
  });

  it('reports direct cancellation as cancelled rather than failed or successful', () => {
    const controller = new AbortController();
    const task = executeProcessingRequest(request(flow([step('clean-spaces'), step('shift')])), {
      signal: controller.signal, onStepProgress: progress => { if (progress.status === 'success') controller.abort(); },
    });
    expect(task).toMatchObject({ status: 'cancelled', errorCode: 'USER_CANCELLED', outputs: [] });
  });
});

describe('workflow format-layout boundaries', () => {
  const ass = '[Script Info]\r\nTitle: 原始测试\r\n[V4+ Styles]\r\nStyle: Preserve,微软雅黑,42\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.00,0:00:03.00,Preserve,,0,0,0,,{\\pos(12,34)}软件发展\\N测试\r\n';

  it.each(['ass', 'ssa'])('preserves source headers, styles, escapes and line endings in pure Chinese %s workflows', extension => {
    const task = executeProcessingRequest(request(flow([step('chinese')]), file(`styled.${extension}`, ass)));
    expect(task.status).toBe('success');
    expect(task.outputs[0].text).toBe(ass.replace('软件发展', '軟件發展').replace('\\N测试', '\\N測試'));
    expect(task.outputs[0].name).toBe(`styled_processed.${extension}`);
    expect(task.diagnostics.some(item => item.code === 'LOSSY_ASS')).toBe(false);
  });

  it('preserves VTT cue settings and CSV quoting for pure Chinese workflows', () => {
    const vtt = 'WEBVTT\n\ncue-A\n00:01.000 --> 00:03.000 position:40% align:start\n软件发展\n';
    const converted = executeProcessingRequest(request(flow([step('chinese')]), file('web.vtt', vtt)));
    expect(converted.status).toBe('success');
    expect(converted.outputs[0].text).toBe(vtt.replace('软件发展', '軟件發展'));
    const csv = 'index,start,end,text\r\n9,00:00:01.000,00:00:03.000,"软件,发展"\r\n';
    const table = executeProcessingRequest(request(flow([step('chinese')]), file('quoted.csv', csv)));
    expect(table.status).toBe('success');
    expect(table.outputs[0].text).toBe(csv.replace('软件,发展', '軟件,發展'));
  });

  it('rejects mixed protected-format flows by default and explicitly normalizes to SRT when permitted', () => {
    const steps = [step('chinese'), step('shift', { offsetMs: 500 })];
    const rejected = executeProcessingRequest(request(flow(steps), file('styled.ass', ass)));
    expect(rejected).toMatchObject({ status: 'failed', errorCode: 'INCOMPATIBLE_WORKFLOW', outputs: [] });
    const normalized = executeProcessingRequest(request(flow(steps, 'normalize'), file('styled.ass', ass)));
    expect(normalized.status).toBe('success');
    expect(normalized.outputs[0].name).toBe('styled_processed.srt');
    expect(normalized.outputs[0].text).toContain('00:00:01,500 --> 00:00:03,500');
    expect(normalized.outputs[0].text).not.toContain('pos(');
    expect(normalized.diagnostics.some(item => item.code === 'LOSSY_WORKFLOW')).toBe(true);
  });
});

describe('worker progress protocol and watchdog cleanup', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
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

  it('delivers step updates without terminating the worker before its final result', async () => {
    ControlledWorker.instances = []; vi.stubGlobal('Worker', ControlledWorker);
    const job = request(flow([step('clean-spaces')]));
    const updates: WorkflowStepProgress[] = [];
    const pending = runWorkerRequest(job, undefined, progress => updates.push(progress));
    const worker = ControlledWorker.instances[0];
    const progress: WorkflowStepProgress = { stepId: job.workflow!.steps[0].id, operation: 'clean-spaces', stepIndex: 0, totalSteps: 1, status: 'processing' };
    worker.onmessage?.({ data: { requestId: worker.sent!.requestId, progress } } as MessageEvent<WorkerReply>);
    expect(updates).toEqual([progress]); expect(worker.terminations).toBe(0);
    worker.onmessage?.({ data: { requestId: worker.sent!.requestId, result: executeProcessingRequest(job) } } as MessageEvent<WorkerReply>);
    expect((await pending).status).toBe('success'); expect(worker.terminations).toBe(1);
  });

  it('terminates timed-out workers and returns a diagnosable failure', async () => {
    vi.useFakeTimers(); ControlledWorker.instances = []; vi.stubGlobal('Worker', ControlledWorker);
    const pending = runWorkerRequest(request(flow([step('clean-spaces')])));
    const rejection = expect(pending).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(MAX_WORKER_DURATION_MS);
    await rejection;
    expect(ControlledWorker.instances[0].terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
