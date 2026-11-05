import * as fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {
  PROJECT_ROOT, MANAGED_BY, RELEASE_NAME, WORKFLOW_SMOKE_CHECKS, controlledPath, exists, fileRecords, makeStage,
  promoteRelease, recordPortableInventory, removeTree, run, sha256, validateStage, verifyRelease, walkFiles,
  withReleaseLock, writeMetadata, zipPortable, sourceFingerprint, assertIdlePaths, releaseResources,
  validateWindowsQaReport,
} from './release-common.mjs';
import { cleanOutputs } from './clean-outputs.mjs';
import { checkVersions } from './check-versions.mjs';

const args = process.argv.slice(2);
const known = ['--allow-dirty', '--check', '--simulate-failure=before-publish'];
if (args.some(argument => !known.includes(argument))) throw new Error('Unknown release argument.');
const root = await fs.realpath(PROJECT_ROOT);
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = (arguments_, options = {}) => run(process.execPath, [npmCli, ...arguments_], { cwd: root, ...options });

async function preflight() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('release:win requires Windows x64.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15) throw new Error('Use Node.js 24.15 or later in the Node 24 LTS line.');
  const branch = await run('git', ['branch', '--show-current'], { capture: true });
  if (!branch) throw new Error('A named Git branch is required.');
  const commit = await run('git', ['rev-parse', 'HEAD'], { capture: true });
  if (await run('git', ['diff', '--name-only', '--diff-filter=U'], { capture: true })) throw new Error('Resolve Git conflicts before building.');
  const status = await run('git', ['status', '--porcelain'], { capture: true });
  if (status && !args.includes('--allow-dirty')) throw new Error('Working tree has changes. Commit them first, or explicitly use --allow-dirty for development acceptance.');
  const metadata = JSON.parse(await run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], { capture: true }));
  const crate = metadata.packages.find(item => item.name === 'subtitle-tools');
  if (!crate) throw new Error('Cargo metadata did not contain the application package.');
  const { version, configuration } = await checkVersions(root, { cargoVersion: crate.version });
  const target = await controlledPath(root, metadata.target_directory);
  if (path.resolve(target).toLowerCase() !== path.join(root, 'src-tauri/target').toLowerCase()) {
    throw new Error('Release scripts require the project-local src-tauri/target. Shared or alternate Cargo target directories are preserved.');
  }
  if (configuration.bundle?.externalBin?.length) throw new Error('This project now declares sidecars. Add their verified runtime inventory before packaging.');
  const resources = await releaseResources(root, configuration.bundle?.resources);
  const binaries = crate.targets.filter(item => item.kind.includes('bin'));
  if (binaries.length !== 1 || binaries[0].name !== 'subtitle-tools') throw new Error('Unexpected executable target; review packaging.');
  await npm(['ls', '--depth=0'], { capture: true });
  const npmVersion = await npm(['--version'], { capture: true });
  const rustVersion = await run('rustc', ['--version'], { capture: true });
  const tauriVersion = await npm(['run', '--silent', 'tauri', '--', '--version'], { capture: true });
  if (!rustVersion.match(/^rustc 1\.(\d+)/u) || Number(rustVersion.match(/^rustc 1\.(\d+)/u)[1]) < 90) throw new Error('Rust 1.90 or later is required.');
  const destination = path.join(root, RELEASE_NAME);
  if (await exists(destination)) await verifyRelease(root, destination);
  await assertIdlePaths([destination]);
  return { version, commit, branch, dirty: Boolean(status), sourceFingerprint: await sourceFingerprint(root),
    node: process.versions.node, npm: npmVersion, rust: rustVersion, tauri: tauriVersion, target, resources };
}

function peImports(bytes) {
  if (bytes.readUInt16LE(0) !== 0x5A4D) throw new Error('Executable is not a Windows PE image.');
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(header) !== 0x4550 || bytes.readUInt16LE(header + 4) !== 0x8664) throw new Error('Executable must be a Windows x64 PE image.');
  const count = bytes.readUInt16LE(header + 6);
  const optional = header + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Unsupported executable optional header.');
  const sections = optional + bytes.readUInt16LE(header + 20);
  const resolveRva = rva => {
    for (let i = 0; i < count; i++) {
      const section = sections + i * 40;
      const start = bytes.readUInt32LE(section + 12);
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= start && rva < start + size) return rva - start + bytes.readUInt32LE(section + 20);
    }
    throw new Error('Invalid PE import address.');
  };
  const importRva = bytes.readUInt32LE(optional + 112 + 8);
  if (!importRva) return [];
  const imports = [];
  for (let descriptor = resolveRva(importRva); bytes.readUInt32LE(descriptor + 12); descriptor += 20) {
    const nameOffset = resolveRva(bytes.readUInt32LE(descriptor + 12));
    const end = bytes.indexOf(0, nameOffset);
    const name = bytes.toString('ascii', nameOffset, end);
    if (end < 0 || !/^[a-z\d_.-]+\.dll$/iu.test(name)) throw new Error('Unexpected native DLL import.');
    imports.push(name);
  }
  return imports;
}

async function copyRuntime(target, destination) {
  const output = path.join(target, 'release');
  const pending = ['subtitle-tools.exe'];
  const copied = new Set();
  const imports = new Set();
  while (pending.length) {
    const name = pending.shift();
    if (copied.has(name.toLowerCase())) continue;
    const source = await controlledPath(root, path.join(output, name));
    const bytes = await fs.readFile(source);
    const dependencies = peImports(bytes);
    await fs.copyFile(source, path.join(destination, name), fs.constants.COPYFILE_EXCL);
    copied.add(name.toLowerCase());
    for (const dll of dependencies) {
      imports.add(dll);
      const available = (await fs.readdir(output)).find(candidate => candidate.toLowerCase() === dll.toLowerCase());
      if (available) pending.push(available);
    }
  }
  return [...imports].sort();
}

async function unpack(root, zipPath, directory) {
  const zip = await JSZip.loadAsync(await fs.readFile(zipPath), { checkCRC32: true });
  for (const entry of Object.values(zip.files)) {
    if (!entry.name.startsWith('SRTTools/') || entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error('Unsafe ZIP entry.');
    const target = await controlledPath(root, path.join(directory, entry.name));
    if (entry.dir) await fs.mkdir(target, { recursive: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await entry.async('nodebuffer'), { flag: 'wx' });
    }
  }
}

const baseline = await preflight();
if (args.includes('--check')) {
  console.log(JSON.stringify({ status: 'PASS', ...baseline }, null, 2));
} else {
  await withReleaseLock(root, async () => {
    const stage = await makeStage(root);
    try {
      const candidate = path.join(stage, 'candidate');
      const portable = path.join(candidate, 'SRTTools');
      await fs.mkdir(portable, { recursive: true });
      const checks = [];
      for (const command of ['lint', 'typecheck', 'test:release', 'test', 'build']) {
        const started = Date.now();
        await npm(['run', command]);
        checks.push({ command: `npm run ${command}`, status: 'PASS', elapsedMs: Date.now() - started });
      }
      for (const command of [
        ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'],
        ['clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings'],
      ]) {
        const started = Date.now();
        await run('cargo', command);
        checks.push({ command: `cargo ${command.join(' ')}`, status: 'PASS', elapsedMs: Date.now() - started });
      }
      {
        const command = ['-NoLogo', '-NoProfile', '-File', 'scripts/check-windows-scripts.ps1'];
        const started = Date.now();
        await run('pwsh', command);
        checks.push({ command: `pwsh ${command.join(' ')}`, status: 'PASS', elapsedMs: Date.now() - started });
      }
      for (const kind of ['safety', 'state']) {
        const script = kind === 'safety' ? 'windows-qa-safety.test.ps1' : 'windows-state-protection.test.ps1';
        const reportPath = await controlledPath(root, path.join(baseline.target, `${path.basename(stage)}-qa-${kind}.json`));
        if (await exists(reportPath)) throw new Error('A private QA report path already exists; existing evidence was preserved.');
        const command = ['-NoLogo', '-NoProfile', '-File', `scripts/${script}`];
        const started = Date.now();
        await run('pwsh', [...command, '-ReportPath', reportPath]);
        const result = validateWindowsQaReport(JSON.parse(await fs.readFile(reportPath, 'utf8')), kind);
        checks.push({ command: `pwsh ${command.join(' ')}`, status: 'PASS', elapsedMs: Date.now() - started, ...result });
        await fs.unlink(await controlledPath(root, reportPath));
      }
      await npm(['run', 'test:e2e', '--', '--output', path.join(stage, 'test-results')], {
        env: { PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(stage, 'playwright-report') },
      });
      checks.push({ command: 'npm run test:e2e', status: 'PASS' });
      const started = Date.now();
      await npm(['run', 'tauri', '--', 'build']);
      checks.push({ command: 'npm run tauri -- build', status: 'PASS', elapsedMs: Date.now() - started });
      const nativeImports = await copyRuntime(baseline.target, portable);
      for (const resource of baseline.resources) {
        await fs.copyFile(resource.source, path.join(portable, resource.name), fs.constants.COPYFILE_EXCL);
      }
      const installer = await controlledPath(root, path.join(baseline.target, 'release/bundle/nsis', `Subtitle Tools_${baseline.version}_x64-setup.exe`));
      await fs.copyFile(installer, path.join(candidate, 'SRTTools-Setup.exe'), fs.constants.COPYFILE_EXCL);
      await zipPortable(root, portable, path.join(candidate, 'SRTTools.zip'));
      const files = await fileRecords(root, candidate, await walkFiles(root, candidate));
      const info = {
        schemaVersion: 1, managedBy: MANAGED_BY, product: 'SRTTools', ...baseline, target: undefined, resources: undefined,
        builtAt: new Date().toISOString(), platform: 'win32', architecture: 'x64',
        prerequisites: ['Windows x64', 'Microsoft Edge WebView2 Runtime'],
        nativeImports, checks, files, smoke: { status: 'NOT_RUN' },
      };
      await writeMetadata(candidate, info);
      await verifyRelease(root, candidate, { requireSmoke: false });
      await recordPortableInventory(stage, files);
      const unpacked = path.join(stage, 'unpacked');
      await fs.mkdir(unpacked);
      await unpack(root, path.join(candidate, 'SRTTools.zip'), unpacked);
      const extracted = await fileRecords(root, unpacked, await walkFiles(root, unpacked));
      const expected = files.filter(file => file.path.startsWith('SRTTools/'));
      if (JSON.stringify(extracted) !== JSON.stringify(expected)) throw new Error('Extracted ZIP inventory/hash mismatch.');
      const report = path.join(stage, 'portable-smoke.json');
      await run('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts/windows-smoke.ps1'),
        '-ExePath', path.join(unpacked, 'SRTTools/subtitle-tools.exe'), '-ReportPath', report,
        '-ExpectedVersion', baseline.version, '-Scenario', 'workflow']);
      const smoke = JSON.parse(await fs.readFile(report, 'utf8'));
      info.smoke = {
        status: smoke.status, executableSha256: smoke.executableSha256?.toUpperCase(),
        checks: smoke.checks, checkedAt: smoke.checkedAt,
        scenario: smoke.scenario,
        workflowChecks: Object.fromEntries(WORKFLOW_SMOKE_CHECKS.map(key => [key, smoke.workflowChecks?.[key]])),
        originalPreserved: smoke.originalPreserved, shutdown: smoke.shutdown, storeRestored: smoke.storeRestored,
        cleanupComplete: smoke.cleanupComplete,
      };
      await writeMetadata(candidate, info);
      await verifyRelease(root, candidate);
      if (args.includes('--simulate-failure=before-publish')) throw new Error('Requested build failure before publishing. Last successful release was preserved.');
      const now = await preflight();
      if (now.commit !== baseline.commit || now.sourceFingerprint !== baseline.sourceFingerprint) throw new Error('Source state changed during release. Candidate was not published.');
      const destination = await promoteRelease(root, candidate, stage);
      console.log(`Verified latest release: ${destination}`);
      console.log(`Setup SHA-256: ${await sha256(path.join(destination, 'SRTTools-Setup.exe'))}`);
      await cleanOutputs(root, { apply: true, skipStage: stage });
    } catch (error) {
      const report = path.join(stage, 'portable-smoke.json');
      const native = await exists(report) ? JSON.parse(await fs.readFile(report, 'utf8')) : null;
      await fs.writeFile(path.join(root, '.release-work/last-failure.json'), JSON.stringify({
        managedBy: MANAGED_BY, status: 'FAIL', recordedAt: new Date().toISOString(),
        commit: baseline.commit, version: baseline.version,
        failureStage: native?.failureStage ?? 'build-or-publish',
        failureKind: native?.failureKind ?? error.name,
        failureReason: native?.failureReason,
        checks: native?.checks,
        scenario: native?.scenario,
        workflowChecks: native?.workflowChecks
          && Object.fromEntries(WORKFLOW_SMOKE_CHECKS.map(key => [key, native.workflowChecks[key]])),
      }, null, 2) + '\n');
      throw error;
    } finally {
      try {
        await validateStage(root, stage, { allowCurrentProcess: true });
        await removeTree(root, stage);
      } catch (error) {
        console.warn(`Staging preserved for inspection/recovery: ${stage}\n${error.message}`);
        process.exitCode = 1;
      }
    }
  });
}
