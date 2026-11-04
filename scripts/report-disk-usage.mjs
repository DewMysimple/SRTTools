import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, controlledPath, exists, walkFiles } from './release-common.mjs';

if (process.argv.length > 2) throw new Error('disk:report takes no path arguments.');
const report = [];
for (const name of [
  'release-output', 'dist', 'src-tauri/target/release', 'src-tauri/target/debug',
  'test-results', 'playwright-report', '.release-work',
]) {
  const directory = path.join(PROJECT_ROOT, name);
  try {
    await controlledPath(PROJECT_ROOT, directory);
    let bytes = 0;
    let count = 0;
    if (await exists(directory)) {
      for (const file of await walkFiles(PROJECT_ROOT, directory)) {
        bytes += (await fs.stat(file)).size;
        count++;
      }
    }
    report.push({ path: name, bytes, MiB: Number((bytes / 1024 / 1024).toFixed(2)), files: count });
  } catch (error) { report.push({ path: name, skipped: error.message }); }
}
console.log(JSON.stringify(report, null, 2));
