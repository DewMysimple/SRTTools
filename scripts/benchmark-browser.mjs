import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import { chromium } from '@playwright/test';
import { PROJECT_ROOT, controlledPath, inside, run } from './release-common.mjs';

if (process.argv.length > 2) throw new Error('Browser benchmark takes no path arguments.');
const sourceSha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
const runtimeDirectory = await controlledPath(PROJECT_ROOT, path.join(PROJECT_ROOT, 'src-tauri', 'target', 'benchmark', `browser-${randomUUID()}`));
await fs.mkdir(runtimeDirectory, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1:1435').pathname);
    if (name === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>SRTTools performance measurement</title>'); return; }
    const file = path.resolve(runtimeDirectory, `.${name}`);
    if (!inside(runtimeDirectory, file)) throw new Error('Invalid benchmark resource path.');
    await controlledPath(PROJECT_ROOT, file);
    response.setHeader('Content-Type', 'text/javascript');
    response.setHeader('Cache-Control', 'public, max-age=3600, immutable');
    response.end(await fs.readFile(file));
  } catch { response.statusCode = 404; response.end(); }
});
let browser;
async function cleanupRuntime() {
  const verified = await controlledPath(PROJECT_ROOT, runtimeDirectory);
  if (path.dirname(verified) !== path.join(PROJECT_ROOT, 'src-tauri', 'target', 'benchmark') || !path.basename(verified).startsWith('browser-')) {
    throw new Error('Refusing unsafe browser-benchmark cleanup.');
  }
  await fs.rm(verified, { recursive: true, force: false });
}
try {
  await build({
    configFile: false, root: PROJECT_ROOT, base: './', logLevel: 'error', worker: { format: 'es' },
    build: { target: 'es2022', outDir: runtimeDirectory, emptyOutDir: false, minify: true,
      lib: { entry: path.join(PROJECT_ROOT, 'scripts', 'benchmark-browser-runtime.ts'), formats: ['es'], fileName: () => 'benchmark-runtime.js' } },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(1435, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1435');
  const report = await page.evaluate(async () => {
    const OriginalWorker = globalThis.Worker;
    const lifecycle = { created: 0, terminated: 0, active: 0, maxActive: 0 };
    class CountedWorker extends OriginalWorker {
      constructor(...args) { super(...args); this.benchmarkTerminated = false; lifecycle.created++; lifecycle.active++; lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active); }
      terminate() { if (!this.benchmarkTerminated) { this.benchmarkTerminated = true; lifecycle.terminated++; lifecycle.active--; } return super.terminate(); }
    }
    globalThis.Worker = CountedWorker;
    const { processFiles, processWorkflowFiles, benchmarkSubtitleText } = await import('/benchmark-runtime.js');
    const definition = { schemaVersion: 1, lossyMode: 'reject', steps: [
      { id: '00000000-0000-4000-8000-000000000001', operation: 'remove-empty', enabled: true, params: {} },
      { id: '00000000-0000-4000-8000-000000000002', operation: 'clean-spaces', enabled: true, params: {} },
      { id: '00000000-0000-4000-8000-000000000003', operation: 'shift', enabled: true, params: { offsetMs: 500, policy: 'reject' } },
    ] };
    const options = { outputEncoding: 'utf-8', lineEnding: 'LF', fileNamePattern: '{name}_processed' };
    const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] }; };
    const heap = () => performance.memory?.usedJSHeapSize ?? null;
    const collect = () => { if (typeof globalThis.gc === 'function') globalThis.gc(); };
    const hashOutputs = async tasks => {
      const outputs = tasks.flatMap(task => task.outputs);
      let size = 0; for (const output of outputs) size += output.bytes.byteLength;
      const all = new Uint8Array(size); let offset = 0;
      for (const output of outputs) { all.set(output.bytes, offset); offset += output.bytes.byteLength; }
      const digest = await crypto.subtle.digest('SHA-256', all);
      return { outputBytes: size, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
    };
    const cases = [];
    for (const cueCount of [100, 1000, 10000, 50000]) {
      for (const mode of ['single', 'workflow']) cases.push({ id: `browser-${mode}-${cueCount}`, cueCount, fileCount: 1, mode });
    }
    for (const fileCount of [10, 50, 100]) cases.push({ id: `browser-batch-workflow-${fileCount}`, cueCount: 1000, fileCount, mode: 'workflow' });
    const results = [];
    for (const spec of cases) {
      const bytes = new TextEncoder().encode(benchmarkSubtitleText(spec.cueCount));
      const files = Array.from({ length: spec.fileCount }, (_, index) => ({ id: String(index), name: `generated-${index}.srt`, size: bytes.byteLength, bytes }));
      const samples = [];
      for (let iteration = -1; iteration < 5; iteration++) {
        collect(); const beforeHeap = heap(); const beforeWorkers = lifecycle.created;
        const started = performance.now();
        let lastStep;
        let progressEvents = 0;
        const onProgress = task => { progressEvents++; if (task.workflow?.currentStep) lastStep = task.workflow.currentStep; };
        const tasks = spec.mode === 'single' ? await processFiles(files, 'clean-spaces', {}, options, onProgress)
          : await processWorkflowFiles(files, definition, options, onProgress);
        const elapsedMs = performance.now() - started;
        if (tasks.some(task => task.status !== 'success')) throw new Error(`Browser benchmark failed: ${spec.id}`);
        const output = await hashOutputs(tasks);
        tasks.length = 0;
        collect(); const afterHeap = heap();
        if (lifecycle.active !== 0) throw new Error('Browser benchmark leaked an active worker.');
        if (iteration >= 0) samples.push({ elapsedMs, beforeHeap, afterHeap, workersCreated: lifecycle.created - beforeWorkers,
          progressEvents, lastStepIndex: lastStep?.stepIndex ?? null, ...output });
      }
      if (new Set(samples.map(sample => sample.sha256)).size !== 1) throw new Error(`Browser benchmark produced nondeterministic bytes: ${spec.id}`);
      results.push({ ...spec, inputBytes: bytes.byteLength * files.length, runs: 5, warmups: 1,
        elapsedMs: stats(samples.map(sample => sample.elapsedMs)), outputBytes: samples[0].outputBytes, sha256: samples[0].sha256,
        retainedHeapDeltaBytes: samples.every(sample => sample.beforeHeap !== null && sample.afterHeap !== null)
          ? stats(samples.map(sample => sample.afterHeap - sample.beforeHeap)) : null,
        samples });
    }

    const longBytes = new TextEncoder().encode(benchmarkSubtitleText(50000));
    const longFiles = Array.from({ length: 10 }, (_, index) => ({ id: `cancel-${index}`, name: `cancel-${index}.srt`, size: longBytes.byteLength, bytes: longBytes }));
    if (longBytes.byteLength * longFiles.length > 128 * 1024 * 1024) throw new Error('Cancellation fixture exceeded queue limits.');
    const cancellation = [];
    for (let iteration = -1; iteration < 5; iteration++) {
      const controller = new AbortController(); let requestedAt;
      const started = performance.now();
      const tasks = await processWorkflowFiles(longFiles, definition, options, task => {
        if (requestedAt === undefined && task.workflow?.currentStep?.status === 'processing') { requestedAt = performance.now(); controller.abort(); }
      }, controller.signal);
      const finished = performance.now();
      if (tasks.some(task => task.status !== 'cancelled' || task.outputs.length)) throw new Error('Cancelled workflow returned successful or partial output.');
      if (lifecycle.active !== 0) throw new Error('Cancellation left an active worker.');
      if (iteration >= 0) cancellation.push({ requestLatencyMs: requestedAt - started, responseMs: finished - requestedAt, cancelledFiles: tasks.length });
    }

    const valid = new TextEncoder().encode(benchmarkSubtitleText(1000));
    const damaged = new TextEncoder().encode('not a subtitle');
    const isolated = await processWorkflowFiles([
      { id: 'before', name: 'before.srt', size: valid.byteLength, bytes: valid },
      { id: 'bad', name: 'bad.srt', size: damaged.byteLength, bytes: damaged },
      { id: 'after', name: 'after.srt', size: valid.byteLength, bytes: valid },
    ], definition, options);
    if (isolated.map(task => task.status).join(',') !== 'success,failed,success') throw new Error('Browser batch isolation failed.');
    return {
      browserUserAgent: navigator.userAgent, gcExposed: typeof globalThis.gc === 'function',
      results, cancellation: { runs: 5, warmups: 1, inputCueCountPerFile: 50000, fileCount: 10,
        inputBytes: longBytes.byteLength * 10, responseMs: stats(cancellation.map(sample => sample.responseMs)), samples: cancellation },
      failureIsolation: isolated.map(task => ({ status: task.status, errorCode: task.errorCode ?? null, outputCount: task.outputs.length })),
      workerLifecycle: lifecycle,
      method: 'Production ES2022 Vite bundle of the actual application scheduler and Web Workers, served from a controlled temporary same-origin static server. Monotonic end-to-end elapsed time includes worker startup, structured cloning and progress delivery. Hashing is excluded. Main-page heap samples exclude worker heaps and are not a true peak. Input fixtures are generated in memory.',
    };
  });
  const reportPath = await controlledPath(PROJECT_ROOT, path.join(PROJECT_ROOT, 'docs', 'PERFORMANCE_v0.4.0_browser.json'));
  await fs.writeFile(reportPath, JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(), sourceSha, browserVersion: browser.version(), ...report }, null, 2) + '\n');
  for (const result of report.results) console.log(`${result.id}: ${result.elapsedMs.median.toFixed(2)} ms (${result.elapsedMs.min.toFixed(2)}–${result.elapsedMs.max.toFixed(2)})`);
  console.log(`Cancellation median: ${report.cancellation.responseMs.median.toFixed(2)} ms; workers ${report.workerLifecycle.created}/${report.workerLifecycle.terminated}, active ${report.workerLifecycle.active}`);
  console.log(path.relative(PROJECT_ROOT, reportPath));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await cleanupRuntime();
}
