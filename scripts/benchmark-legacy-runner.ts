// Kept independent of v0.4 workflow modules so this entry also builds against a v0.3 core checkout.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeBytes, encodeText, parseSubtitle, processDocument, serializeSubtitle } from '../src/core';
import { benchmarkSubtitleText } from './benchmark-fixtures';

interface BaselineCase { id: string; cueCount: number; fileCount: number; mode: 'single' | 'serial-three' }
interface Stages { decode: number; parse: number; transform: number; serialize: number; encode: number }
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
};

export function createBenchmarkFixture(cueCount: number): Uint8Array {
  return new TextEncoder().encode(benchmarkSubtitleText(cueCount));
}

export function runBaselineCase(spec: BaselineCase, runs = 5, warmups = 1) {
  const input = createBenchmarkFixture(spec.cueCount);
  if (input.byteLength > 32 * 1024 * 1024 || input.byteLength * spec.fileCount > 128 * 1024 * 1024 || spec.fileCount > 100) throw new Error('Benchmark input limit.');
  const steps = spec.mode === 'single' ? [{ operation: 'clean-spaces', params: {} }]
    : [{ operation: 'remove-empty', params: {} }, { operation: 'clean-spaces', params: {} }, { operation: 'shift', params: { offsetMs: 500, policy: 'reject' } }];
  const samples: { totalMs: number; stagesMs: Stages; outputBytes: number; outputSha256: string; heapBefore: number; sampledHeapMax: number; heapAfter: number; rssAfter: number }[] = [];
  for (let iteration = -warmups; iteration < runs; iteration++) {
    globalThis.gc?.();
    const before = process.memoryUsage();
    let maximumHeap = before.heapUsed;
    const sample = () => { maximumHeap = Math.max(maximumHeap, process.memoryUsage().heapUsed); };
    const stagesMs: Stages = { decode: 0, parse: 0, transform: 0, serialize: 0, encode: 0 };
    let totalMs = 0;
    let outputBytes = 0;
    const hash = createHash('sha256');
    for (let index = 0; index < spec.fileCount; index++) {
      let bytes = input;
      const totalStarted = performance.now();
      for (const step of steps) {
        let started = performance.now();
        const decoded = decodeBytes(bytes);
        stagesMs.decode += performance.now() - started; sample();
        started = performance.now();
        const parsed = parseSubtitle(decoded.text, 'generated.srt');
        if (parsed.diagnostics.some(item => item.severity === 'error')) throw new Error('Generated baseline fixture failed validation.');
        stagesMs.parse += performance.now() - started; sample();
        started = performance.now();
        const result = processDocument(parsed.document, step.operation, step.params);
        stagesMs.transform += performance.now() - started; sample();
        started = performance.now();
        const serialized = serializeSubtitle(result.documents[0], 'srt', 'LF');
        stagesMs.serialize += performance.now() - started; sample();
        started = performance.now();
        bytes = encodeText(serialized.text, 'utf-8');
        stagesMs.encode += performance.now() - started; sample();
      }
      totalMs += performance.now() - totalStarted;
      hash.update(bytes); outputBytes += bytes.byteLength;
    }
    const after = process.memoryUsage();
    const outputSha256 = hash.digest('hex');
    if (iteration >= 0) samples.push({ totalMs, stagesMs, outputBytes, outputSha256, heapBefore: before.heapUsed,
      sampledHeapMax: maximumHeap, heapAfter: after.heapUsed, rssAfter: after.rss });
  }
  if (new Set(samples.map(sample => sample.outputSha256)).size !== 1) throw new Error('Nondeterministic baseline output.');
  return { ...spec, inputBytesPerFile: input.byteLength, inputBytes: input.byteLength * spec.fileCount, runs, warmups,
    totalMs: distribution(samples.map(sample => sample.totalMs)),
    stagesMs: Object.fromEntries((['decode', 'parse', 'transform', 'serialize', 'encode'] as const).map(stage => [stage, distribution(samples.map(sample => sample.stagesMs[stage]))])),
    outputBytes: samples[0].outputBytes, outputSha256: samples[0].outputSha256,
    memory: { kind: 'node-stage-boundary-samples-not-true-peak', heapBeforeBytes: distribution(samples.map(sample => sample.heapBefore)),
      sampledHeapMaxBytes: Math.max(...samples.map(sample => sample.sampledHeapMax)), heapAfterBytes: distribution(samples.map(sample => sample.heapAfter)),
      rssAfterBytes: distribution(samples.map(sample => sample.rssAfter)) }, samples };
}
