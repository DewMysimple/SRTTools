import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeBytes, encodeText, parseSubtitle, processDocument, serializeSubtitle } from '../src/core';
import { executeWorkflow, type WorkflowDefinition } from '../src/core/workflow';
import { executeProcessingRequest } from '../src/workers/worker-logic';
import { benchmarkSubtitleText } from './benchmark-fixtures';

export interface BenchmarkCase {
  id: string;
  cueCount: number;
  fileCount: number;
  mode: 'single' | 'serial-three' | 'workflow-three' | 'single-wrap' | 'source-chinese';
  encoding?: 'utf-8' | 'utf-16le' | 'gb18030';
  variant?: 'srt' | 'ass' | 'long-line';
}

interface StageTimes {
  decode: number;
  parse: number;
  transform: number;
  serialize: number;
  encode: number;
}

function fixture(cueCount: number, encoding = 'utf-8', variant: BenchmarkCase['variant'] = 'srt'): Uint8Array {
  return encodeText(benchmarkSubtitleText(cueCount, variant), encoding);
}

export function createBenchmarkFixture(cueCount: number): Uint8Array {
  return fixture(cueCount);
}

/** The baseline deliberately reproduces separate export/import between each tool. */
function serialTools(input: Uint8Array, spec: BenchmarkCase, stages: StageTimes, sample: () => void): Uint8Array {
  const operations = spec.mode === 'single-wrap' ? [{ operation: 'wrap', params: { maxChars: 24 } }] : spec.mode === 'single'
    ? [{ operation: 'clean-spaces', params: {} }]
    : [{ operation: 'remove-empty', params: {} }, { operation: 'clean-spaces', params: {} }, { operation: 'shift', params: { offsetMs: 500, policy: 'reject' } }];
  let bytes = input;
  for (const step of operations) {
    let started = performance.now();
    const decoded = decodeBytes(bytes, spec.encoding);
    stages.decode += performance.now() - started;
    sample();
    started = performance.now();
    const parsed = parseSubtitle(decoded.text, 'generated.srt');
    if (parsed.diagnostics.some(item => item.severity === 'error')) throw new Error('Generated benchmark subtitle failed validation.');
    stages.parse += performance.now() - started;
    sample();
    started = performance.now();
    const result = processDocument(parsed.document, step.operation, step.params);
    stages.transform += performance.now() - started;
    sample();
    started = performance.now();
    const serialized = serializeSubtitle(result.documents[0], 'srt', 'LF');
    stages.serialize += performance.now() - started;
    sample();
    started = performance.now();
    bytes = encodeText(serialized.text, spec.encoding ?? 'utf-8');
    stages.encode += performance.now() - started;
    sample();
  }
  return bytes;
}

const threeSteps: WorkflowDefinition = {
  schemaVersion: 1, lossyMode: 'reject', steps: [
    { id: '00000000-0000-4000-8000-000000000001', operation: 'remove-empty', enabled: true, params: {} },
    { id: '00000000-0000-4000-8000-000000000002', operation: 'clean-spaces', enabled: true, params: {} },
    { id: '00000000-0000-4000-8000-000000000003', operation: 'shift', enabled: true, params: { offsetMs: 500, policy: 'reject' } },
  ],
};

function workflowTools(input: Uint8Array, spec: BenchmarkCase, stages: StageTimes, sample: () => void): Uint8Array {
  let started = performance.now();
  const decoded = decodeBytes(input, spec.encoding);
  stages.decode += performance.now() - started; sample();
  started = performance.now();
  const parsed = parseSubtitle(decoded.text, 'generated.srt');
  if (parsed.diagnostics.some(item => item.severity === 'error')) throw new Error('Generated workflow fixture failed validation.');
  stages.parse += performance.now() - started; sample();
  started = performance.now();
  const result = executeWorkflow(parsed.document, threeSteps);
  stages.transform += performance.now() - started; sample();
  started = performance.now();
  const serialized = serializeSubtitle(result.document, 'srt', 'LF');
  stages.serialize += performance.now() - started; sample();
  started = performance.now();
  const bytes = encodeText(serialized.text, spec.encoding ?? 'utf-8');
  stages.encode += performance.now() - started; sample();
  return bytes;
}

function sourceChinese(input: Uint8Array, spec: BenchmarkCase): Uint8Array {
  const task = executeProcessingRequest({
    kind: 'workflow', operation: 'workflow', params: {},
    files: [{ id: 'generated', name: `generated.${spec.variant === 'ass' ? 'ass' : 'srt'}`, size: input.byteLength, bytes: input }],
    options: { encoding: spec.encoding, outputEncoding: spec.encoding ?? 'utf-8', lineEnding: 'LF', fileNamePattern: '{name}_processed' },
    workflow: { schemaVersion: 1, lossyMode: 'reject', steps: [{ id: '00000000-0000-4000-8000-000000000004', operation: 'chinese', enabled: true, params: { direction: 's2t' } }] },
  });
  if (task.status !== 'success') throw new Error(task.errorMessage ?? 'Source-layout benchmark failed.');
  return task.outputs[0].bytes;
}

export function runBaselineCase(spec: BenchmarkCase, runs = 5, warmups = 1) {
  const input = fixture(spec.cueCount, spec.encoding, spec.variant);
  if (input.byteLength > 32 * 1024 * 1024 || input.byteLength * spec.fileCount > 128 * 1024 * 1024 || spec.fileCount > 100) {
    throw new Error('Benchmark fixture would exceed the application input limits.');
  }
  const samples: {
    totalMs: number; stagesMs: StageTimes; outputBytes: number; outputSha256: string;
    heapBefore: number; sampledHeapMax: number; heapAfter: number; rssAfter: number;
  }[] = [];
  for (let run = -warmups; run < runs; run++) {
    globalThis.gc?.();
    const memoryBefore = process.memoryUsage();
    let sampledHeapMax = memoryBefore.heapUsed;
    const sample = () => { sampledHeapMax = Math.max(sampledHeapMax, process.memoryUsage().heapUsed); };
    const stages: StageTimes = { decode: 0, parse: 0, transform: 0, serialize: 0, encode: 0 };
    let outputBytes = 0;
    const hash = createHash('sha256');
    let totalMs = 0;
    for (let index = 0; index < spec.fileCount; index++) {
      const started = performance.now();
      const output = spec.mode === 'workflow-three' ? workflowTools(input, spec, stages, sample)
        : spec.mode === 'source-chinese' ? sourceChinese(input, spec) : serialTools(input, spec, stages, sample);
      totalMs += performance.now() - started;
      outputBytes += output.byteLength;
      // Hashing is correctness evidence; it is excluded from processing timings.
      hash.update(output);
    }
    const outputSha256 = hash.digest('hex');
    const memoryAfter = process.memoryUsage();
    if (run >= 0) samples.push({
      totalMs, stagesMs: stages, outputBytes, outputSha256,
      heapBefore: memoryBefore.heapUsed, sampledHeapMax,
      heapAfter: memoryAfter.heapUsed, rssAfter: memoryAfter.rss,
    });
  }
  if (new Set(samples.map(sample => sample.outputSha256)).size !== 1) throw new Error('Benchmark output was nondeterministic.');
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
  };
  return {
    ...spec, inputBytesPerFile: input.byteLength, inputBytes: input.byteLength * spec.fileCount,
    runs, warmups, totalMs: distribution(samples.map(sample => sample.totalMs)),
    stagesMs: spec.mode === 'source-chinese' ? null : Object.fromEntries((['decode', 'parse', 'transform', 'serialize', 'encode'] as const)
      .map(stage => [stage, distribution(samples.map(sample => sample.stagesMs[stage]))])),
    outputBytes: samples[0].outputBytes, outputSha256: samples[0].outputSha256,
    memory: {
      kind: 'node-stage-boundary-samples-not-true-peak',
      heapBeforeBytes: distribution(samples.map(sample => sample.heapBefore)),
      sampledHeapMaxBytes: Math.max(...samples.map(sample => sample.sampledHeapMax)),
      heapAfterBytes: distribution(samples.map(sample => sample.heapAfter)),
      rssAfterBytes: distribution(samples.map(sample => sample.rssAfter)),
    },
    samples,
  };
}
