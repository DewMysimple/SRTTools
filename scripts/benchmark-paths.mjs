import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './release-common.mjs';

export const benchmarkVersion = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

export function benchmarkPath(kind) {
  const historical = kind === 'baseline' || kind === 'pre_optimization' || ['0.3.0', '0.4.0'].includes(benchmarkVersion);
  const directory = historical ? 'docs' : 'src-tauri/target/benchmark';
  const version = historical ? '0.4.0' : benchmarkVersion;
  const filename = kind === 'report' ? `PERFORMANCE_v${version}.md` : `PERFORMANCE_v${version}_${kind}.json`;
  return path.join(PROJECT_ROOT, directory, filename);
}
