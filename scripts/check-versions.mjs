import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tomlTables(text, header) {
  const tables = [];
  let table;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trimStart().startsWith('[')) {
      table = line.replace(/\s*#.*$/u, '').trim() === header ? [] : undefined;
      if (table) tables.push(table);
    } else if (table) table.push(line);
  }
  return tables.map(lines => lines.join('\n'));
}

function tomlString(table, key) {
  const values = [...table.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*(?:#.*)?$`, 'gmu'))];
  if (values.length !== 1) throw new Error(`Version check requires exactly one TOML ${key} value.`);
  return values[0][1];
}

/** Read-only and dependency-free, so the same contract runs in CI and Windows release preflight. */
export async function checkVersions(root = projectRoot, { cargoVersion } = {}) {
  const [pkg, lock, configuration, cargo, cargoLock] = await Promise.all([
    ...['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'].map(async name =>
      JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))),
    ...['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'].map(name => fs.readFile(path.join(root, name), 'utf8')),
  ]);
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(pkg.version)) {
    throw new Error('package.json must declare an explicit application version.');
  }
  const packages = tomlTables(cargo, '[package]');
  if (packages.length !== 1 || tomlString(packages[0], 'name') !== pkg.name) {
    throw new Error('Cargo application package must match package.json.');
  }
  const locked = tomlTables(cargoLock, '[[package]]').filter(table => tomlString(table, 'name') === pkg.name);
  if (locked.length !== 1) throw new Error('Cargo.lock must contain exactly one application package.');
  const rows = [
    { file: 'package.json', version: pkg.version },
    { file: 'package-lock.json', version: lock.version },
    { file: 'package-lock.json packages[""]', version: lock.packages?.['']?.version },
    { file: 'src-tauri/tauri.conf.json', version: configuration.version },
    { file: 'src-tauri/Cargo.toml', version: tomlString(packages[0], 'version') },
    { file: 'src-tauri/Cargo.lock application', version: tomlString(locked[0], 'version') },
    ...(cargoVersion === undefined ? [] : [{ file: 'cargo metadata --locked', version: cargoVersion }]),
  ];
  const drift = rows.filter(row => row.version !== pkg.version);
  if (drift.length) throw new Error(`Application version drift: ${drift.map(row => `${row.file}=${String(row.version)}`).join(', ')}; expected ${pkg.version}.`);
  return { status: 'PASS', version: pkg.version, rows, configuration };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('check:versions takes no arguments.');
  const { status, version, rows } = await checkVersions();
  console.log(JSON.stringify({ status, version, rows }, null, 2));
}
