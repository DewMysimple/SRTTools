import type { ImportedFile } from './file-service';

export interface NamedOutput {
  name: string;
  bytes: Uint8Array;
}

export interface PlannedOutput extends NamedOutput {
  id: string;
  inputRelativePath: string;
  relativePath: string;
  sourcePath?: string;
  renamed: boolean;
}

export type FolderOutputMode = 'flat' | 'preserve';
export const MAX_EXPORT_FILES = 100;
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_RELATIVE_PATH_UNITS = 2048;

const pathKey = (value: string) => value.normalize('NFC').toLocaleUpperCase('en-US');

/** Accept only portable, Windows-safe relative paths. ZIP and native exports share this contract. */
export function validateRelativeOutputPath(value: string): string {
  if (!value || value.length > MAX_RELATIVE_PATH_UNITS || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error('输出相对路径无效或超过 2048 个 UTF-16 单元。');
  }
  const parts = value.split('/');
  if (parts.length > 10 || parts.some(part => !part || part === '.' || part === '..' || safeFileName(part) !== part)) {
    throw new Error('输出路径包含不安全的目录名、路径穿越或过深层级。');
  }
  const extension = parts.at(-1)!.split('.').at(-1)!.toLowerCase();
  if (!['srt', 'vtt', 'ass', 'ssa', 'txt', 'csv', 'json'].includes(extension)) throw new Error('目录输出的扩展名不受支持。');
  return value;
}

function sourceParts(value: string): string[] {
  if (!value || value.startsWith('/') || value.includes('\\') || /[:\p{Cc}]/u.test(value)) {
    throw new Error('源文件相对路径无效。请重新通过添加文件夹导入。');
  }
  const parts = value.split('/');
  if (parts.length > 7 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('源文件相对路径包含不安全片段。');
  return parts;
}

/** Build the exact visible tree before writing. Multiple roots receive stable, visible aliases. */
export function planFolderOutputs(entries: readonly { id: string; input: ImportedFile; output: NamedOutput }[], mode: FolderOutputMode): PlannedOutput[] {
  if (!entries.length) throw new Error('没有可导出的处理结果。');
  if (entries.length > MAX_EXPORT_FILES || new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some(entry => !entry.id || entry.id.length > 200)) throw new Error('目录输出最多 100 个不同结果，请分批导出。');
  if (entries.reduce((sum, entry) => sum + entry.output.bytes.byteLength, 0) > MAX_EXPORT_BYTES) throw new Error('本次导出超过 256 MiB，请分批处理。');
  const roots = new Map<string, string>();
  const usedAliases = new Set<string>();
  for (const { input } of entries) {
    if (!input.folderSource || roots.has(input.folderSource.rootId)) continue;
    if (!input.folderSource.rootId) throw new Error('源目录会话信息无效，请重新添加文件夹。');
    const base = safeFileName(input.folderSource.rootName);
    let alias = base;
    let suffix = 2;
    while (usedAliases.has(pathKey(alias))) { const marker = ` (${suffix++})`; alias = `${truncateName(base, 220 - marker.length)}${marker}`; }
    usedAliases.add(pathKey(alias));
    roots.set(input.folderSource.rootId, alias);
  }
  const usedFiles = new Set<string>();
  const usedDirectories = new Set<string>();
  const directoryAliases = new Map<string, string>();
  return entries.map(({ id, input, output }) => {
    const source = input.folderSource ? sourceParts(input.folderSource.relativePath) : [input.name];
    const rawParents = mode === 'preserve' && input.folderSource ? [
      ...(roots.size > 1 ? [roots.get(input.folderSource.rootId)!] : []), ...source.slice(0, -1),
    ] : [];
    const parents: string[] = [];
    for (const [index, raw] of rawParents.entries()) {
      const safe = safeFileName(raw);
      const sourceKey = `${input.folderSource?.rootId ?? ''}/${rawParents.slice(0, index + 1).join('/')}`;
      const existing = directoryAliases.get(sourceKey);
      if (existing) { parents.push(existing.split('/').at(-1)!); continue; }
      let directory = safe;
      let suffix = 2;
      while (usedFiles.has(pathKey([...parents, directory].join('/'))) || usedDirectories.has(pathKey([...parents, directory].join('/')))) { const marker = ` (${suffix++})`; directory = `${truncateName(safe, 220 - marker.length)}${marker}`; }
      const path = [...parents, directory].join('/');
      directoryAliases.set(sourceKey, path);
      usedDirectories.add(pathKey(path));
      parents.push(directory);
    }
    const safe = safeFileName(output.name);
    const { base, extension } = nameParts(safe);
    let name = safe;
    let suffix = 2;
    while (usedFiles.has(pathKey([...parents, name].join('/'))) || usedDirectories.has(pathKey([...parents, name].join('/')))) {
      const marker = ` (${suffix++})`;
      name = `${truncateName(base, 220 - marker.length - extension.length)}${marker}${extension}`;
    }
    const relativePath = validateRelativeOutputPath([...parents, name].join('/'));
    usedFiles.add(pathKey(relativePath));
    const intendedParents = mode === 'preserve' && input.folderSource ? [
      ...(roots.size > 1 ? [input.folderSource.rootName] : []), ...source.slice(0, -1),
    ] : [];
    const intended = [...intendedParents, output.name].join('/');
    return { ...output, id, inputRelativePath: [...(input.folderSource && roots.size > 1 ? [input.folderSource.rootName] : []), ...source].join('/'), relativePath, sourcePath: input.path, renamed: relativePath !== intended };
  });
}

/** The archive contains precisely the reviewed tree, with no implicit renaming or unsafe entries. */
export async function createPlannedZip(outputs: readonly PlannedOutput[], options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<Uint8Array> {
  validatePlannedOutputs(outputs);
  if (options.signal?.aborted) throw new DOMException('ZIP 导出已取消。', 'AbortError');
  const { default: JSZip } = await import('jszip');
  if (options.signal?.aborted) throw new DOMException('ZIP 导出已取消。', 'AbortError');
  const zip = new JSZip();
  for (const output of outputs) zip.file(output.relativePath, output.bytes, { binary: true, createFolders: false });
  const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let finished = false;
    let lastProgress = -1;
    const cleanup = () => { options.signal?.removeEventListener('abort', abort); chunks.length = 0; };
    const fail = (error: unknown) => { if (finished) return; finished = true; stream.pause(); cleanup(); reject(error); };
    const abort = () => fail(new DOMException('ZIP 导出已取消。', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk, metadata) => {
      if (finished) return;
      try {
        length += chunk.byteLength;
        if (length > MAX_EXPORT_BYTES) throw new Error('ZIP 超过 256 MiB 导出限制，请分批处理。');
        chunks.push(chunk);
        const percent = Math.floor(metadata.percent);
        if (percent !== lastProgress) { lastProgress = percent; options.onProgress?.(percent); }
      } catch (error) { fail(error); }
    }).on('error', fail).on('end', () => {
      if (finished) return;
      try {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        finished = true; cleanup(); resolve(bytes);
      } catch (error) { fail(error); }
    }).resume();
  });
}

export function validatePlannedOutputs(outputs: readonly PlannedOutput[]): void {
  if (!outputs.length || outputs.length > MAX_EXPORT_FILES) throw new Error('请选择 1 至 100 个结果。');
  if (outputs.reduce((sum, output) => sum + output.bytes.byteLength, 0) > MAX_EXPORT_BYTES) throw new Error('本次导出超过 256 MiB，请分批处理。');
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const output of outputs) {
    const path = pathKey(validateRelativeOutputPath(output.relativePath));
    if (!output.id || ids.has(output.id) || paths.has(path)) throw new Error('输出计划包含重复项目或大小写冲突。');
    for (const existing of paths) if (existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) throw new Error('输出计划包含文件与目录冲突。');
    paths.add(path); ids.add(output.id);
  }
}

function truncateName(text: string, maxUnits: number): string {
  let result = '';
  for (const character of text) {
    if (result.length + character.length > maxUnits) break;
    result += character;
  }
  return result;
}

function nameParts(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot < 12
    ? { base: name.slice(0, dot), extension: name.slice(dot) }
    : { base: name, extension: '' };
}

export function safeFileName(name: string): string {
  const wellFormed = [...name].map(character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff ? '_' : character).join('');
  let safe = wellFormed.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/u, '').trim();
  if (!safe || safe === '.' || safe === '..') safe = 'subtitle';
  if (/^(con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(safe)) safe = `_${safe}`;
  if (safe.length > 220) {
    const { base, extension } = nameParts(safe);
    safe = truncateName(base, 220 - extension.length) + extension;
  }
  return safe;
}

/** ZIP entries are unique on case-insensitive Windows filesystems too. */
export function uniqueOutputNames<T extends NamedOutput>(outputs: readonly T[]): T[] {
  const used = new Set<string>();
  return outputs.map((output) => {
    const safe = safeFileName(output.name);
    const { base, extension } = nameParts(safe);
    let candidate = safe;
    let suffix = 2;
    while (used.has(candidate.normalize('NFC').toLocaleLowerCase('en-US'))) {
      const marker = ` (${suffix++})`;
      candidate = `${truncateName(base, 220 - marker.length - extension.length)}${marker}${extension}`;
    }
    used.add(candidate.normalize('NFC').toLocaleLowerCase('en-US'));
    return { ...output, name: candidate };
  });
}

export async function createZip(outputs: readonly NamedOutput[]): Promise<Uint8Array> {
  if (outputs.length === 0) throw new Error('没有可导出的处理结果。');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const output of uniqueOutputNames(outputs)) {
    zip.file(output.name, output.bytes, { binary: true, createFolders: false });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
