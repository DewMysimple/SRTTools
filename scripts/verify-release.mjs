import path from 'node:path';
import { PROJECT_ROOT, RELEASE_NAME, run, sourceFingerprint, verifyRelease } from './release-common.mjs';
import { checkVersions } from './check-versions.mjs';

if (process.argv.length > 2) throw new Error('release:verify takes no path arguments.');
const directory = path.join(PROJECT_ROOT, RELEASE_NAME);
const info = await verifyRelease(PROJECT_ROOT, directory);
await run('git', ['cat-file', '-e', `${info.commit}^{commit}`], { capture: true });
const { version } = await checkVersions(PROJECT_ROOT);
if (version !== info.version || await sourceFingerprint(PROJECT_ROOT) !== info.sourceFingerprint) {
  throw new Error('Current source or version differs from this release. Build a new verified release.');
}
console.log(JSON.stringify({
  status: 'PASS', directory, version: info.version, commit: info.commit, dirty: info.dirty,
  files: info.files, smoke: info.smoke,
}, null, 2));
