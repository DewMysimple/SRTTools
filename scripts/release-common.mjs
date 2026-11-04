import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANAGED_BY = 'srttools-release-v1';
export const RELEASE_NAME = 'release-output';
export const WORK_NAME = '.release-work';
export const PAYLOAD_NAMES = ['SRTTools.zip', 'SRTTools-Setup.exe'];
const HEADER_NAMES = ['SHA256SUMS.txt', 'build-info.json'];

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Every existing component below the repository is checked before an operation. */
export async function controlledPath(root, target) {
  root = await fs.realpath(root);
  target = path.resolve(target);
  if (!inside(root, target) || target === root) throw new Error(`Unsafe release path: ${target}`);
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let entry;
    try { entry = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (entry.isSymbolicLink()) throw new Error(`Symlink or junction is not allowed: ${current}`);
    const actual = await fs.realpath(current);
    if (!inside(root, actual)) throw new Error(`Release path escaped the repository: ${current}`);
  }
  return target;
}

export async function walkFiles(root, directory) {
  await controlledPath(root, directory);
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = await controlledPath(root, path.join(current, entry.name));
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      else throw new Error(`Unsupported release entry: ${fullPath}`);
    }
  }
  await visit(directory);
  return files.sort();
}

export async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex').toUpperCase();
}

export function relativeName(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export async function sourceFingerprint(root) {
  const listing = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, capture: true });
  const digest = createHash('sha256');
  for (const name of [...new Set(listing.split('\0').filter(Boolean))].sort()) {
    if (['docs/', 'wiki_memory/', 'prompt/'].some(prefix => name.startsWith(prefix))
      || ['README.md', 'AGENTS.md'].includes(name)) continue;
    const file = await controlledPath(root, path.join(root, name));
    digest.update(name + '\0');
    digest.update(await fs.readFile(file));
    digest.update('\0');
  }
  return digest.digest('hex').toUpperCase();
}

export async function fileRecords(root, directory, files) {
  const records = [];
  for (const file of files) {
    await controlledPath(root, file);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty release file: ${file}`);
    records.push({ path: relativeName(directory, file), bytes: stat.size, sha256: await sha256(file) });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function writeMetadata(directory, info) {
  await fs.writeFile(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', { flag: 'w' });
  const manifestHash = await sha256(path.join(directory, 'build-info.json'));
  const sums = [...info.files, { path: 'build-info.json', sha256: manifestHash }]
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
    .map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n';
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), sums);
}

export async function zipPortable(root, directory, zipPath) {
  const zip = new JSZip();
  const files = await walkFiles(root, directory);
  for (const file of files) {
    zip.file(`SRTTools/${relativeName(directory, file)}`, await fs.readFile(file), { createFolders: true });
  }
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export async function verifyRelease(root, directory, { requireSmoke = true } = {}) {
  await controlledPath(root, directory);
  const info = JSON.parse(await fs.readFile(path.join(directory, 'build-info.json'), 'utf8'));
  if (info.managedBy !== MANAGED_BY || info.schemaVersion !== 1 || info.product !== 'SRTTools'
    || !Array.isArray(info.files) || !/^[0-9a-f]{40,64}$/u.test(info.commit)
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(info.version)
    || !Number.isFinite(Date.parse(info.builtAt))) {
    throw new Error('Invalid or unrecognized release manifest. Existing files were preserved.');
  }
  const expectedNames = [...PAYLOAD_NAMES, ...HEADER_NAMES, 'SRTTools'];
  const top = (await fs.readdir(directory)).sort();
  if (JSON.stringify(top) !== JSON.stringify(expectedNames.sort())) {
    throw new Error('Unknown or missing files in release-output. Existing files were preserved.');
  }
  const allowed = new Set([...HEADER_NAMES]);
  for (const entry of info.files) {
    if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\')
      || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith('/')
      || entry.path.split('/').includes('..')
      || !(PAYLOAD_NAMES.includes(entry.path) || entry.path.startsWith('SRTTools/'))
      || allowed.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || !/^[0-9A-F]{64}$/u.test(entry.sha256)) throw new Error('Invalid release file record.');
    allowed.add(entry.path);
  }
  for (const name of [...PAYLOAD_NAMES, 'SRTTools/subtitle-tools.exe']) {
    if (!allowed.has(name)) throw new Error(`Release manifest is missing ${name}`);
  }
  const actualFiles = await walkFiles(root, directory);
  if (actualFiles.length !== allowed.size || actualFiles.some(file => !allowed.has(relativeName(directory, file)))) {
    throw new Error('Unknown or missing release files. Existing files were preserved.');
  }
  const allowedDirectories = new Set(['SRTTools']);
  for (const name of allowed) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      allowedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  async function verifyDirectories(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (!allowedDirectories.has(relativeName(directory, child))) throw new Error('Unknown directory in release-output.');
      await verifyDirectories(child);
    }
  }
  await verifyDirectories(directory);
  for (const entry of info.files) {
    const file = await controlledPath(root, path.join(directory, ...entry.path.split('/')));
    if ((await fs.stat(file)).size !== entry.bytes || await sha256(file) !== entry.sha256) {
      throw new Error(`Release hash or size mismatch: ${entry.path}`);
    }
  }
  const expectedSums = [...info.files, { path: 'build-info.json', sha256: await sha256(path.join(directory, 'build-info.json')) }]
    .sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n';
  if (await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8') !== expectedSums) {
    throw new Error('SHA256SUMS.txt does not match the release manifest.');
  }
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(directory, 'SRTTools.zip')), { checkCRC32: true });
  const portable = info.files.filter(file => file.path.startsWith('SRTTools/'));
  const zipFiles = Object.values(zip.files).filter(entry => !entry.dir);
  if (zipFiles.length !== portable.length) throw new Error('ZIP file count does not match SRTTools/.');
  for (const entry of Object.values(zip.files)) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name || !entry.name.startsWith('SRTTools/')) {
      throw new Error('Unsafe or unexpected ZIP entry.');
    }
    if (entry.dir && !allowedDirectories.has(entry.name.replace(/\/$/u, ''))) throw new Error('Unexpected directory in ZIP.');
  }
  for (const record of portable) {
    const entry = zip.file(record.path);
    if (!entry || createHash('sha256').update(await entry.async('nodebuffer')).digest('hex').toUpperCase() !== record.sha256) {
      throw new Error(`ZIP content mismatch: ${record.path}`);
    }
  }
  const executable = portable.find(file => file.path === 'SRTTools/subtitle-tools.exe');
  if (requireSmoke && (info.smoke?.status !== 'PASS' || info.smoke.executableSha256 !== executable.sha256
    || !['startup', 'import', 'process', 'export'].every(key => info.smoke.checks?.[key] === true)
    || !['originalPreserved', 'shutdown', 'storeRestored', 'cleanupComplete'].every(key => info.smoke[key] === true))) {
    throw new Error('This release has no passing native import/process/export smoke evidence.');
  }
  return info;
}

/** Only call after validating ownership and content inventory for this exact tree. */
export async function removeTree(root, directory) {
  await controlledPath(root, directory);
  const files = await walkFiles(root, directory);
  for (const file of files) {
    await controlledPath(root, file);
    await fs.unlink(file);
  }
  async function removeDirectories(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) throw new Error(`Unexpected entry appeared during cleanup: ${current}`);
      await removeDirectories(await controlledPath(root, path.join(current, entry.name)));
    }
    await fs.rmdir(current);
  }
  await removeDirectories(directory);
}

export async function assertIdlePaths(paths, { includeBuildTools = false } = {}) {
  if (process.platform !== 'win32') return;
  const script = `
    $ErrorActionPreference = 'Stop'
    $targets = ConvertFrom-Json $env:SRTTOOLS_IDLE_PATHS
    $checkBuild = $env:SRTTOOLS_CHECK_BUILD -eq '1'
    $busy = @(Get-CimInstance Win32_Process | Where-Object {
      $processEntry = $_
      $underTarget = $false
      foreach ($target in $targets) {
        if ($processEntry.ExecutablePath -and ($processEntry.ExecutablePath -eq $target -or
          $processEntry.ExecutablePath.StartsWith($target.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase))) {
          $underTarget = $true
        }
      }
      $underTarget -or ($checkBuild -and $processEntry.Name -in @('cargo.exe','rustc.exe','link.exe','cl.exe','clang-cl.exe','lld-link.exe'))
    } | Select-Object ProcessId, Name)
    if ($busy.Count -gt 0) { ConvertTo-Json -Compress -InputObject $busy; exit 3 }
  `;
  await run('pwsh', ['-NoProfile', '-Command', script], {
    capture: true, env: { SRTTOOLS_IDLE_PATHS: JSON.stringify(paths), SRTTOOLS_CHECK_BUILD: includeBuildTools ? '1' : '0' },
  });
}

export async function promoteRelease(root, candidate, stage, { rename = fs.rename, assertIdle = assertIdlePaths } = {}) {
  const destination = await controlledPath(root, path.join(root, RELEASE_NAME));
  await verifyRelease(root, candidate);
  const hadPrevious = await exists(destination);
  if (hadPrevious) await verifyRelease(root, destination);
  const previous = await controlledPath(root, path.join(stage, 'previous'));
  await assertIdle([destination]);
  if (hadPrevious) await rename(destination, previous);
  try {
    await rename(candidate, destination);
    await verifyRelease(root, destination);
  } catch (error) {
    try {
      if (await exists(destination)) await rename(destination, candidate);
      if (hadPrevious) await rename(previous, destination);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Release rollback needs recovery. Previous files are preserved in ${previous}`, { cause: rollbackError });
    }
    throw error;
  }
  if (hadPrevious) await removeTree(root, previous);
  return destination;
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function makeStage(root) {
  const base = await controlledPath(root, path.join(root, WORK_NAME));
  await fs.mkdir(base, { recursive: true });
  const directory = path.join(base, `staging-${randomUUID()}`);
  await fs.mkdir(directory);
  const marker = { managedBy: MANAGED_BY, root: await fs.realpath(root), pid: process.pid };
  await fs.writeFile(path.join(directory, '.stage.json'), JSON.stringify(marker));
  return directory;
}

export async function recordPortableInventory(stage, files) {
  const markerPath = path.join(stage, '.stage.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  marker.portableFiles = files.filter(file => file.path.startsWith('SRTTools/'));
  await fs.writeFile(markerPath, JSON.stringify(marker));
}

export async function validateStage(root, directory, { allowCurrentProcess = false } = {}) {
  await controlledPath(root, directory);
  if (path.dirname(directory) !== path.join(root, WORK_NAME) || !/^staging-[\da-f-]{36}$/u.test(path.basename(directory))) {
    throw new Error('Not a managed staging directory.');
  }
  const marker = JSON.parse(await fs.readFile(path.join(directory, '.stage.json'), 'utf8'));
  if (marker.managedBy !== MANAGED_BY || marker.root !== await fs.realpath(root)) throw new Error('Unknown staging ownership.');
  if (processIsAlive(marker.pid) && !(allowCurrentProcess && marker.pid === process.pid)) throw new Error('Staging is in use.');
  const allowed = ['.stage.json', 'candidate', 'unpacked', 'previous', 'portable-smoke.json', 'test-results', 'playwright-report'];
  if ((await fs.readdir(directory)).some(name => !allowed.includes(name))) throw new Error('Unknown file in staging; cleanup skipped.');
  if (await exists(path.join(directory, 'previous'))) {
    // A failed rollback or interrupted promotion can leave the only good copy here.
    // Even an invalid previous manifest requires manual recovery, never deletion.
    throw new Error(`Previous release requires recovery and was preserved: ${path.join(directory, 'previous')}`);
  }
  const candidate = path.join(directory, 'candidate');
  let manifest = Array.isArray(marker.portableFiles) ? { files: marker.portableFiles } : undefined;
  if (await exists(path.join(candidate, 'build-info.json'))) {
    manifest = await verifyRelease(root, candidate, { requireSmoke: false });
  } else if (await exists(candidate)) {
    const knownIncomplete = /^(?:SRTTools\/(?:subtitle-tools\.exe|[a-z\d_.-]+\.dll)|SRTTools\.zip|SRTTools-Setup\.exe)$/iu;
    for (const file of await walkFiles(root, candidate)) {
      if (!knownIncomplete.test(relativeName(candidate, file))) throw new Error('Unknown file in incomplete candidate; cleanup skipped.');
    }
  }
  const unpacked = path.join(directory, 'unpacked');
  if (await exists(unpacked)) {
    if (!manifest) throw new Error('Unpacked files have no candidate manifest; preserved.');
    const records = await fileRecords(root, unpacked, await walkFiles(root, unpacked));
    if (JSON.stringify(records) !== JSON.stringify(manifest.files.filter(file => file.path.startsWith('SRTTools/')))) {
      throw new Error('Unknown or changed unpacked files; cleanup skipped.');
    }
  }
  for (const reportDirectory of ['test-results', 'playwright-report']) {
    const location = path.join(directory, reportDirectory);
    if (!await exists(location)) continue;
    for (const file of await walkFiles(root, location)) {
      if (!/(?:\.png|\.zip|\.webm|\.html|\.js|\.css|\.json|error-context\.md)$/u.test(file)) {
        throw new Error('Unknown file among test reports; cleanup skipped.');
      }
    }
  }
  await walkFiles(root, directory);
}

export async function withReleaseLock(root, operation) {
  const base = await controlledPath(root, path.join(root, WORK_NAME));
  await fs.mkdir(base, { recursive: true });
  const lockPath = await controlledPath(root, path.join(base, 'release.lock'));
  const openLock = () => fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  let handle;
  try { handle = await openLock(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Only one stale-lock takeover can run at a time. A normal acquirer can
    // win after the stale file is removed, in which case openLock fails safely.
    const recoveryPath = await controlledPath(root, path.join(base, 'release-recovery.lock'));
    const recovery = await fs.open(recoveryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await recovery.writeFile(JSON.stringify({ managedBy: MANAGED_BY, pid: process.pid }));
      const stale = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (stale.managedBy !== MANAGED_BY || !Number.isSafeInteger(stale.pid) || stale.pid < 1 || processIsAlive(stale.pid)) {
        throw new Error('Release lock is active or has unknown ownership. Existing lock was preserved.', { cause: error });
      }
      await fs.unlink(lockPath);
      handle = await openLock();
    } finally {
      await recovery.close();
      await fs.unlink(recoveryPath);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ managedBy: MANAGED_BY, pid: process.pid }));
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath);
  }
}

export function run(command, args, { cwd = PROJECT_ROOT, env = {}, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    let errors = '';
    if (capture) {
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}.${capture ? `\n${(output + errors).slice(0, 4000)}` : ''}`));
    });
  });
}
