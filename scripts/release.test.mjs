import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MANAGED_BY, controlledPath, fileRecords, makeStage, promoteRelease, removeTree,
  sha256, sourceFingerprint, run, validateStage, verifyRelease, walkFiles, withReleaseLock, writeMetadata, zipPortable, assertIdlePaths,
} from './release-common.mjs';
import { cleanOutputs, planCleanup } from './clean-outputs.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'srttools-release-test-')));
  t.after(async () => { await removeTree(path.dirname(root), root); });
  return root;
}

async function release(root, directory, text = 'executable') {
  await fs.mkdir(path.join(directory, 'SRTTools'), { recursive: true });
  await fs.writeFile(path.join(directory, 'SRTTools/subtitle-tools.exe'), text);
  await fs.writeFile(path.join(directory, 'SRTTools-Setup.exe'), 'installer-' + text);
  await zipPortable(root, path.join(directory, 'SRTTools'), path.join(directory, 'SRTTools.zip'));
  const files = await fileRecords(root, directory, await walkFiles(root, directory));
  const info = {
    managedBy: MANAGED_BY, schemaVersion: 1, product: 'SRTTools', version: '0.2.0',
    commit: 'a'.repeat(40), builtAt: '2026-11-04T00:00:00.000Z', files,
    smoke: { status: 'PASS', executableSha256: await sha256(path.join(directory, 'SRTTools/subtitle-tools.exe')),
      checks: { startup: true, import: true, process: true, export: true },
      originalPreserved: true, shutdown: true, storeRestored: true, cleanupComplete: true },
  };
  await writeMetadata(directory, info);
  return info;
}

test('manifest, ZIP image and checksum verification detect unknown or changed files', async t => {
  const root = await fixture(t);
  const directory = path.join(root, 'release-output');
  await release(root, directory);
  await verifyRelease(root, directory);
  await fs.writeFile(path.join(directory, 'my-notes.txt'), 'manual');
  await assert.rejects(verifyRelease(root, directory), /Unknown/u);
  await fs.unlink(path.join(directory, 'my-notes.txt'));
  await fs.mkdir(path.join(directory, 'SRTTools/manual-folder'));
  await assert.rejects(verifyRelease(root, directory), /Unknown directory/u);
  await fs.rmdir(path.join(directory, 'SRTTools/manual-folder'));
  await fs.writeFile(path.join(directory, 'SRTTools/subtitle-tools.exe'), 'tampered');
  await assert.rejects(verifyRelease(root, directory), /mismatch/u);
});

test('success replaces one fixed release and failed candidate leaves the last success intact', async t => {
  const root = await fixture(t);
  const final = path.join(root, 'release-output');
  await release(root, final, 'first');
  const stage = await makeStage(root);
  const candidate = path.join(stage, 'candidate');
  await release(root, candidate, 'second');
  await promoteRelease(root, candidate, stage);
  assert.equal(await fs.readFile(path.join(final, 'SRTTools/subtitle-tools.exe'), 'utf8'), 'second');
  assert.deepEqual(await fs.readdir(stage), ['.stage.json']);
  await release(root, candidate, 'broken');
  await fs.writeFile(path.join(candidate, 'SRTTools.zip'), 'invalid');
  await assert.rejects(promoteRelease(root, candidate, stage));
  assert.equal(await fs.readFile(path.join(final, 'SRTTools/subtitle-tools.exe'), 'utf8'), 'second');
  await assert.rejects(validateStage(root, stage, { allowCurrentProcess: true }), /mismatch/u);
});

test('unknown hand-written release files prevent replacement and are preserved', async t => {
  const root = await fixture(t);
  const final = path.join(root, 'release-output');
  await release(root, final);
  await fs.writeFile(path.join(final, 'keep-me.txt'), 'manual data');
  const stage = await makeStage(root);
  await release(root, path.join(stage, 'candidate'));
  await assert.rejects(promoteRelease(root, path.join(stage, 'candidate'), stage), /Unknown/u);
  assert.equal(await fs.readFile(path.join(final, 'keep-me.txt'), 'utf8'), 'manual data');
});

test('a failed promotion plus failed rollback keeps the unique previous release protected', async t => {
  const root = await fixture(t);
  const final = path.join(root, 'release-output');
  const original = await release(root, final, 'last-good');
  const stage = await makeStage(root);
  const candidate = path.join(stage, 'candidate');
  await release(root, candidate, 'new');
  const previous = path.join(stage, 'previous');
  const rename = async (source, destination) => {
    if (source === candidate || source === previous) throw new Error('simulated rename lock');
    await fs.rename(source, destination);
  };
  await assert.rejects(promoteRelease(root, candidate, stage, { rename, assertIdle: async () => {} }), /needs recovery/u);
  assert.equal((await verifyRelease(root, previous)).files[0].sha256, original.files[0].sha256);
  await assert.rejects(validateStage(root, stage, { allowCurrentProcess: true }), /requires recovery/u);
  const markerPath = path.join(stage, '.stage.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  marker.pid = 999_999_999;
  await fs.writeFile(markerPath, JSON.stringify(marker));
  const plan = await planCleanup(root);
  assert.equal(plan.targets.length, 0);
  assert.match(plan.skipped[0].reason, /requires recovery/u);
  await assert.rejects(cleanOutputs(root, { apply: true }));
  await verifyRelease(root, previous);
});

test('nested manual notes prevent staging cleanup', async t => {
  const root = await fixture(t);
  const stage = await makeStage(root);
  const candidate = path.join(stage, 'candidate');
  await release(root, candidate);
  await fs.writeFile(path.join(candidate, 'SRTTools/notes.txt'), 'manual');
  await assert.rejects(validateStage(root, stage, { allowCurrentProcess: true }), /Unknown/u);
  assert.equal(await fs.readFile(path.join(candidate, 'SRTTools/notes.txt'), 'utf8'), 'manual');
});

test('path guards reject traversal and junctions without deleting external data', async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  await fs.writeFile(path.join(other, 'user.txt'), 'preserve');
  await assert.rejects(controlledPath(root, root), /Unsafe/u);
  await assert.rejects(controlledPath(root, path.join(root, '../outside')), /Unsafe/u);
  const link = path.join(root, 'linked');
  await fs.symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(controlledPath(root, path.join(link, 'user.txt')), /junction/u);
    await assert.rejects(removeTree(root, link), /junction/u);
    assert.equal(await fs.readFile(path.join(other, 'user.txt'), 'utf8'), 'preserve');
  } finally { await fs.unlink(link); }
});

test('only a known orphaned lock can be recovered and a live lock remains intact', async t => {
  const root = await fixture(t);
  const work = path.join(root, '.release-work');
  await fs.mkdir(work);
  const lock = path.join(work, 'release.lock');
  await fs.writeFile(lock, JSON.stringify({ managedBy: MANAGED_BY, pid: 999_999_999 }));
  assert.equal(await withReleaseLock(root, async () => 'recovered'), 'recovered');
  await assert.rejects(fs.access(lock));
  const active = JSON.stringify({ managedBy: MANAGED_BY, pid: process.pid });
  await fs.writeFile(lock, active);
  await assert.rejects(withReleaseLock(root, async () => assert.fail('must not acquire a live lock')), /active/u);
  assert.equal(await fs.readFile(lock, 'utf8'), active);
  await fs.writeFile(lock, 'manual lock file');
  await assert.rejects(withReleaseLock(root, async () => assert.fail('must not acquire an unknown lock')));
  assert.equal(await fs.readFile(lock, 'utf8'), 'manual lock file');
});

test('source fingerprint catches edited dirty files while allowing documentation handoff', async t => {
  const root = await fixture(t);
  await run('git', ['init', '--quiet'], { cwd: root, capture: true });
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'src/main.ts'), 'first source');
  await fs.writeFile(path.join(root, 'docs/TESTING.md'), 'first evidence');
  const first = await sourceFingerprint(root);
  await fs.writeFile(path.join(root, 'docs/TESTING.md'), 'updated evidence');
  assert.equal(await sourceFingerprint(root), first);
  await fs.writeFile(path.join(root, 'src/main.ts'), 'changed while still untracked');
  assert.notEqual(await sourceFingerprint(root), first);
});

test('Windows process guard refuses a directory with a running executable', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(assertIdlePaths([path.dirname(process.execPath)]), /exited 3/u);
});

test('cleanup is dry-run by default, preserves unknown outputs and is idempotent', async t => {
  const root = await fixture(t);
  await release(root, path.join(root, 'release-output'));
  const directory = path.join(root, 'src-tauri/target/release/bundle/nsis');
  await fs.mkdir(directory, { recursive: true });
  const old = path.join(directory, 'Subtitle Tools_0.1.0_x64-setup.exe');
  const unknown = path.join(directory, 'important.exe');
  await fs.writeFile(old, 'old installer');
  await fs.writeFile(unknown, 'user data');
  const plan = await cleanOutputs(root);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.equal(await fs.readFile(old, 'utf8'), 'old installer');
  await cleanOutputs(root, { apply: true });
  assert.equal(await fs.readFile(unknown, 'utf8'), 'user data');
  assert.equal((await planCleanup(root)).targets.length, 0);
  await cleanOutputs(root, { apply: true });
  await assert.rejects(planCleanup(root, { releaseCache: true }), /confirm-release-cache/u);
});

test('failed release verification protects intermediates, and live/unknown stages are preserved', async t => {
  const root = await fixture(t);
  const final = path.join(root, 'release-output');
  await release(root, final);
  const stage = await makeStage(root);
  await assert.rejects(validateStage(root, stage), /in use/u);
  await fs.writeFile(path.join(stage, 'unknown.txt'), 'manual');
  await assert.rejects(validateStage(root, stage, { allowCurrentProcess: true }), /Unknown/u);
  const nsis = path.join(root, 'src-tauri/target/release/bundle/nsis');
  await fs.mkdir(nsis, { recursive: true });
  const installer = path.join(nsis, 'Subtitle Tools_0.1.0_x64-setup.exe');
  await fs.writeFile(installer, 'preserve');
  await fs.writeFile(path.join(final, 'SRTTools.zip'), 'broken');
  await assert.rejects(cleanOutputs(root, { apply: true }));
  assert.equal(await fs.readFile(installer, 'utf8'), 'preserve');
});
