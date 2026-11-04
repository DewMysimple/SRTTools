import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_ROOT, MANAGED_BY, RELEASE_NAME, WORK_NAME, controlledPath, exists, processIsAlive,
  removeTree, run, validateStage, verifyRelease, walkFiles, withReleaseLock, assertIdlePaths,
} from './release-common.mjs';

async function bytesIn(root, target) {
  const stat = await fs.lstat(await controlledPath(root, target));
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const file of await walkFiles(root, target)) total += (await fs.stat(file)).size;
  return total;
}

export async function planCleanup(root, { skipStage, releaseCache = false, confirmReleaseCache = false } = {}) {
  root = await fs.realpath(root);
  const targets = [];
  const skipped = [];
  const target = async (file, kind) => targets.push({ path: file, kind, bytes: await bytesIn(root, file) });
  const nsis = await controlledPath(root, path.join(root, 'src-tauri/target/release/bundle/nsis'));
  if (await exists(nsis)) {
    for (const entry of await fs.readdir(nsis, { withFileTypes: true })) {
      const file = path.join(nsis, entry.name);
      if (entry.isFile() && /^Subtitle Tools_\d+\.\d+\.\d+(?:-[\w.-]+)?_x64-setup\.exe$/u.test(entry.name)) {
        await target(file, 'installer');
      } else skipped.push({ path: file, reason: 'Unknown or linked output; preserved.' });
    }
  }
  const work = await controlledPath(root, path.join(root, WORK_NAME));
  if (await exists(work)) {
    for (const entry of await fs.readdir(work, { withFileTypes: true })) {
      const file = path.join(work, entry.name);
      if (file === skipStage) continue;
      try {
        if (entry.name === 'release.lock' && entry.isFile()) {
          const lock = JSON.parse(await fs.readFile(await controlledPath(root, file), 'utf8'));
          if (lock.managedBy !== MANAGED_BY || processIsAlive(lock.pid)) continue;
          await target(file, 'stale-lock');
        } else if (entry.name === 'last-failure.json' && entry.isFile()) {
          const report = JSON.parse(await fs.readFile(await controlledPath(root, file), 'utf8'));
          if (report.managedBy === MANAGED_BY && report.status === 'FAIL') await target(file, 'report');
          else skipped.push({ path: file, reason: 'Unknown failure report; preserved.' });
        } else if (entry.isDirectory()) {
          await validateStage(root, file);
          await target(file, 'stage');
        } else skipped.push({ path: file, reason: 'Unknown output; preserved.' });
      } catch (error) { skipped.push({ path: file, reason: error.message }); }
    }
  }
  if (releaseCache) {
    if (!confirmReleaseCache) throw new Error('Release-cache cleanup requires --confirm-release-cache. Next release will compile again.');
    const metadata = JSON.parse(await run('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: root, capture: true }));
    const expected = path.join(root, 'src-tauri/target');
    const actual = await controlledPath(root, metadata.target_directory);
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Shared or alternate Cargo target directories are preserved.');
    const release = await controlledPath(root, path.join(actual, 'release'));
    if (await exists(release)) {
      const allowed = new Set([
        '.fingerprint', 'build', 'bundle', 'deps', 'examples', 'incremental', 'nsis',
        '.cargo-artifact-lock', '.cargo-build-lock', '.cargo-lock',
        'subtitle-tools.exe', 'subtitle-tools.d', 'subtitle_tools.pdb',
        'subtitle_tools_lib.dll', 'subtitle_tools_lib.dll.lib', 'subtitle_tools_lib.pdb',
        'subtitle_tools_lib.lib', 'libsubtitle_tools_lib.rlib', 'libsubtitle_tools_lib.a',
      ]);
      if ((await fs.readdir(release)).some(name => !allowed.has(name))) throw new Error('Unknown file in release cache; cache cleanup skipped.');
      await walkFiles(root, release);
      // This explicit mode owns exactly the verified local Cargo release tree.
      return { targets: [{ path: release, kind: 'release-cache', bytes: await bytesIn(root, release) }], skipped };
    }
  }
  return { targets, skipped };
}

export async function cleanOutputs(root, { apply = false, ...options } = {}) {
  const plan = await planCleanup(root, options);
  console.log(JSON.stringify({ apply, ...plan }, null, 2));
  if (!apply) return plan;
  // No intermediate installer is removed until the last successful user release is verified.
  await verifyRelease(root, path.join(root, RELEASE_NAME));
  const failures = [];
  for (const target of plan.targets) {
    try {
      await controlledPath(root, target.path);
      if (target.kind === 'release-cache') await assertIdlePaths([target.path], { includeBuildTools: true });
      if (target.kind === 'stage') await validateStage(root, target.path);
      if (target.kind === 'stage' || target.kind === 'release-cache') await removeTree(root, target.path);
      else await fs.unlink(target.path);
    } catch (error) {
      failures.push({ path: target.path, reason: error.message });
    }
  }
  if (failures.length) console.warn(JSON.stringify({ preservedDuringCleanup: failures }, null, 2));
  return { ...plan, failures };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(argument => !['--apply', '--release-cache', '--confirm-release-cache'].includes(argument))) throw new Error('Unknown cleanup argument.');
  const options = {
    apply: args.includes('--apply'), releaseCache: args.includes('--release-cache'),
    confirmReleaseCache: args.includes('--confirm-release-cache'),
  };
  const result = options.apply
    ? await withReleaseLock(PROJECT_ROOT, () => cleanOutputs(PROJECT_ROOT, options))
    : await cleanOutputs(PROJECT_ROOT, options);
  if (result.failures?.length) process.exitCode = 1;
}
