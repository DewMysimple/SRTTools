import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { PROJECT_ROOT, controlledPath, run, sha256 } from './release-common.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--(phase|output|runs|warmups)=(.+)$/u.exec(argument);
  if (!match) throw new Error(`Unrecognized benchmark argument: ${argument}`);
  return [match[1], match[2]];
}));
const phase = options.phase ?? 'current';
if (!['baseline', 'current'].includes(phase)) throw new Error('Benchmark phase must be baseline or current.');
const runs = Number(options.runs ?? 5);
const warmups = Number(options.warmups ?? 1);
if (!Number.isInteger(runs) || runs < 5 || runs > 30 || !Number.isInteger(warmups) || warmups < 1 || warmups > 10) {
  throw new Error('Benchmark requires 5–30 measured runs and 1–10 warmups.');
}
const reportPath = await controlledPath(PROJECT_ROOT, path.resolve(PROJECT_ROOT, options.output ?? `docs/PERFORMANCE_v0.4.0_${phase}.json`));
if (!reportPath.startsWith(path.join(PROJECT_ROOT, 'docs') + path.sep) || !reportPath.endsWith('.json')) {
  throw new Error('Benchmark reports must be JSON files under the project docs directory.');
}
const runtimeDirectory = await controlledPath(PROJECT_ROOT, path.join(PROJECT_ROOT, 'src-tauri', 'target', 'benchmark', `run-${randomUUID()}`));
const packageInfo = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
if (phase === 'baseline' && packageInfo.version !== '0.3.0') throw new Error('Refusing to overwrite the v0.3.0 baseline from a different application version. Use an isolated v0.3.0 core checkout and copy the benchmark scripts there to reproduce it.');
const coreBefore = await run('git', ['diff', '--name-only', 'HEAD', '--', 'src/core', 'src/workers', 'src/services/processing-service.ts', 'src/app/tool-registry.ts'], { capture: true });
if (phase === 'baseline' && coreBefore.trim()) throw new Error('Baseline requires unchanged v0.3.0 core/worker/registry files.');
await fs.mkdir(runtimeDirectory, { recursive: true });
async function cleanupRuntime() {
  // This is a unique, agent-created compile directory. Verify it again before recursive cleanup.
  const verified = await controlledPath(PROJECT_ROOT, runtimeDirectory);
  if (path.dirname(verified) !== path.join(PROJECT_ROOT, 'src-tauri', 'target', 'benchmark') || !path.basename(verified).startsWith('run-')) {
    throw new Error('Refusing unsafe benchmark temporary-directory cleanup.');
  }
  await fs.rm(verified, { recursive: true, force: false });
}
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
};

async function measureFixtureIo(runner) {
  const results = [];
  for (const cueCount of [100, 1000, 10000, 50000]) {
    const input = runner.createBenchmarkFixture(cueCount);
    const inputPath = await controlledPath(PROJECT_ROOT, path.join(runtimeDirectory, `io-${cueCount}-input.srt`));
    await fs.writeFile(inputPath, input, { flag: 'wx' });
    const samples = [];
    for (let iteration = -warmups; iteration < runs; iteration++) {
      let started = performance.now();
      const read = await fs.readFile(inputPath);
      const readMs = performance.now() - started;
      const temporary = await controlledPath(PROJECT_ROOT, path.join(runtimeDirectory, `io-${cueCount}-${iteration}.tmp`));
      const target = await controlledPath(PROJECT_ROOT, path.join(runtimeDirectory, `io-${cueCount}-${iteration}-output.srt`));
      started = performance.now();
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(read); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
      const writeAndSyncMs = performance.now() - started;
      if (iteration >= 0) samples.push({ readMs, writeAndSyncMs });
      await fs.unlink(target);
    }
    await fs.unlink(inputPath);
    results.push({ cueCount, inputBytes: input.byteLength, warmups, runs,
      readMs: distribution(samples.map(sample => sample.readMs)), writeAndSyncMs: distribution(samples.map(sample => sample.writeAndSyncMs)), samples });
  }
  return results;
}
try {
  await build({
    configFile: false, logLevel: 'error', root: PROJECT_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(PROJECT_ROOT, 'scripts', phase === 'baseline' ? 'benchmark-legacy-runner.ts' : 'benchmark-runner.ts'), target: 'node24',
      outDir: runtimeDirectory, emptyOutDir: false, minify: false,
      rollupOptions: { output: { entryFileNames: 'benchmark-runtime.mjs' } },
    },
  });
  const runner = await import(pathToFileURL(path.join(runtimeDirectory, 'benchmark-runtime.mjs')).href);
  const runtimeBundleSha256 = await sha256(path.join(runtimeDirectory, 'benchmark-runtime.mjs'));
  const sourceSha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
  const cases = [];
  for (const cueCount of [100, 1000, 10000, 50000]) {
    for (const mode of ['single', 'serial-three']) cases.push({ id: `${mode}-${cueCount}`, cueCount, fileCount: 1, mode });
  }
  for (const fileCount of [10, 50, 100]) cases.push({ id: `batch-serial-three-${fileCount}`, cueCount: 1000, fileCount, mode: 'serial-three' });
  if (phase === 'current') {
    for (const cueCount of [100, 1000, 10000, 50000]) cases.push({ id: `workflow-three-${cueCount}`, cueCount, fileCount: 1, mode: 'workflow-three' });
    for (const fileCount of [10, 50, 100]) cases.push({ id: `batch-workflow-three-${fileCount}`, cueCount: 1000, fileCount, mode: 'workflow-three' });
    cases.push(
      { id: 'workflow-utf16le-1000', cueCount: 1000, fileCount: 1, mode: 'workflow-three', encoding: 'utf-16le' },
      { id: 'workflow-gb18030-1000', cueCount: 1000, fileCount: 1, mode: 'workflow-three', encoding: 'gb18030' },
      { id: 'workflow-ass-chinese-1000', cueCount: 1000, fileCount: 1, mode: 'source-chinese', variant: 'ass' },
      { id: 'single-wrap-long-line', cueCount: 1, fileCount: 1, mode: 'single-wrap', variant: 'long-line' },
    );
  }
  const results = [];
  for (const spec of cases) {
    const result = runner.runBaselineCase(spec, runs, warmups);
    results.push(result);
    console.log(`${spec.id}: ${result.totalMs.median.toFixed(2)} ms median (${result.totalMs.min.toFixed(2)}–${result.totalMs.max.toFixed(2)})`);
  }
  for (const result of results.filter(result => result.mode === 'workflow-three' && !result.encoding)) {
    const serial = results.find(candidate => candidate.mode === 'serial-three' && candidate.cueCount === result.cueCount && candidate.fileCount === result.fileCount);
    if (!serial || result.outputSha256 !== serial.outputSha256) throw new Error(`Workflow output differs from serial semantics: ${result.id}`);
  }
  const ioMeasurements = phase === 'current' ? await measureFixtureIo(runner) : [];
  const report = {
    schemaVersion: 1, phase, measuredAt: new Date().toISOString(), sourceSha, appVersion: packageInfo.version, runtimeBundleSha256,
    sourceCoreModified: Boolean(coreBefore.trim()),
    environment: {
      platform: os.platform(), release: os.release(), version: os.version(), architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
      node: process.version, rust: (await run('rustc', ['--version'], { capture: true })).trim(),
      buildMode: 'Vite SSR bundle, unminified, Node runtime', gcExposed: typeof globalThis.gc === 'function',
    },
    method: {
      fixture: 'Deterministic generated SRT with simplified/traditional Chinese, emoji, HTML tags, spaces and multiline bodies; every 23rd cue is whitespace-only.',
      single: ['clean-spaces'], serialThree: ['remove-empty', 'clean-spaces', 'shift(+500ms,reject)'],
      workflowThree: 'Same operation semantics, one decode/parse and one final serialize/encode.',
      complexCases: 'UTF-16LE, strict GB18030 and source-preserving Chinese ASS; source-Chinese stage breakdown is NOT_MEASURED (total measured).',
      timing: 'Each tool decodes, parses, transforms, serializes (including existing final-output parse verification), and encodes. Stage-boundary memory sampling is included; output hashing is excluded.',
      inputReads: phase === 'baseline' ? 'In-memory generated bytes; filesystem read/write latency NOT_MEASURED.'
        : 'Engine cases use in-memory bytes. ioMeasurements separately samples warm-cache Node filesystem reads and temp-write+fsync+rename inside the controlled benchmark directory; this is not a measurement of Rust IPC, filesystem permission dialogs or cold storage.',
      workerLifecycle: 'Node pure-engine sequential baseline; actual browser Worker startup/cancellation NOT_MEASURED in this report.',
      memory: 'Stage-boundary heap/RSS samples, not a reliable true peak; GC runs before each sample when --expose-gc is used.',
      retainedFixtureDiskBytes: 0, temporaryBundle: 'src-tauri/target/benchmark/run-<uuid>, generated IO fixtures and bundles deleted after completion',
    },
    results,
    ioMeasurements,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${path.relative(PROJECT_ROOT, reportPath)}`);
} finally {
  await cleanupRuntime();
}
