import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { validatePlannedOutputs, type PlannedOutput } from './export-service';

export interface ImportedFile {
  id: string;
  name: string;
  path?: string;
  bytes: Uint8Array;
  size: number;
  error?: string;
  /** Session-only, native-verified source layout. Never persisted in a preset. */
  folderSource?: FolderSource;
  draftSourceToken?: string;
}

export interface FolderSource {
  rootId: string;
  rootName: string;
  relativePath: string;
}

interface NativeImportedFile {
  name: string;
  path: string;
  bytes: number[];
  size: number;
  error?: string;
  folderSource?: FolderSource;
  draftSourceToken?: string;
}

const extensions = new Set(['srt', 'vtt', 'ass', 'ssa', 'txt', 'csv']);
export const SUBTITLE_EXTENSIONS = [...extensions];
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_FILES = 100;

/** Native canonical paths retain their actual Unicode spelling; do not normalize distinct filenames. */
export function nativePathKey(path: string): string {
  // Native file handles already supply the filesystem's actual Unicode spelling.
  // JavaScript Unicode case conversion can expand names (İ → i + combining dot),
  // unlike Windows ordinal comparison, and would silently discard a different file.
  return path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').replace(/\//gu, '\\')
    .replace(/[A-Z]/gu, character => character.toLowerCase());
}

export interface FolderImportSummary {
  selected: boolean;
  visitedEntries: number;
  scannedFiles: number;
  added: number;
  duplicates: number;
  unsupported: number;
  overLimit: number;
  failed: number;
  unreadableDirectories: number;
  skippedLinks: number;
  depthSkipped: number;
  cancelledFiles: number;
  limitStopped: boolean;
  cancelled: boolean;
}

interface FolderImportEvent {
  scanId: string;
  phase: 'scanning' | 'reading' | 'complete';
  summary: FolderImportSummary;
  file?: NativeImportedFile;
}

export async function importFolder(options: {
  recursive: boolean;
  extensions: string[];
  existingFiles: readonly ImportedFile[];
  signal: AbortSignal;
  onFile: (file: ImportedFile) => void;
  onProgress: (summary: FolderImportSummary, phase: FolderImportEvent['phase']) => void;
}): Promise<FolderImportSummary> {
  if (!isDesktop()) throw new Error('添加文件夹仅在 Windows 桌面版可用。');
  if (options.signal.aborted) throw new DOMException('已取消文件夹导入。', 'AbortError');
  const scanId = crypto.randomUUID();
  let complete: (summary: FolderImportSummary) => void = () => undefined;
  const terminal = new Promise<FolderImportSummary>(resolve => { complete = resolve; });
  let finished = false;
  let cancellationError: Error | undefined;
  const cancel = () => {
    void nativeInvoke<void>('cancel_folder_import', { scanId }).catch(error => { cancellationError = readableError(error); });
  };
  const onEvent = new Channel<FolderImportEvent>(event => {
    if (finished || event.scanId !== scanId) return;
    if (event.file) options.onFile(fromNative(event.file));
    options.onProgress(event.summary, event.phase);
    if (event.phase === 'complete') complete(event.summary);
  });
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    const [, summary] = await Promise.all([
      nativeInvoke<void>('select_import_folder', {
        scanId, recursive: options.recursive, extensions: options.extensions,
        existingPaths: options.existingFiles.flatMap(file => file.path ? [file.path] : []),
        existingCount: options.existingFiles.length,
        existingBytes: options.existingFiles.reduce((size, file) => size + file.bytes.byteLength, 0),
        onEvent,
      }),
      // Channel delivery can lag behind the command response. Keep the queue locked until terminal consumption.
      terminal,
    ]);
    if (cancellationError && !summary.cancelled) throw new Error(`取消请求失败，扫描已结束：${cancellationError.message}`);
    return summary;
  } finally {
    finished = true;
    options.signal.removeEventListener('abort', cancel);
    onEvent.onmessage = () => undefined;
  }
}

export function isDesktop(): boolean {
  return isTauri();
}

function readableError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw readableError(error);
  }
}

function fromNative(file: NativeImportedFile): ImportedFile {
  return { ...file, id: crypto.randomUUID(), bytes: Uint8Array.from(file.bytes) };
}

/** Browser drag/drop shares validation with its file dialog. A bad file does not discard its peers. */
export async function readBrowserFiles(files: Iterable<File>): Promise<ImportedFile[]> {
  const selected = Array.from(files);
  if (selected.length > MAX_IMPORT_FILES) throw new Error('一次最多导入 100 个文件，请分批添加。');
  const result: ImportedFile[] = [];
  let usedBytes = 0;
  for (const file of selected) {
    const entry: ImportedFile = {
      id: crypto.randomUUID(), name: file.name, bytes: new Uint8Array(), size: file.size,
    };
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    try {
      if (!extensions.has(extension)) {
        throw new Error('不支持此文件类型。请选择 SRT、VTT、ASS、SSA、TXT 或 CSV 文件。');
      }
      if (file.size > MAX_IMPORT_BYTES) {
        throw new Error('文件超过 32 MiB。请先拆分文件再导入。');
      }
      if (file.size > MAX_IMPORT_TOTAL_BYTES - usedBytes) {
        throw new Error('本次导入的总内容超过 128 MiB，请分批选择文件。');
      }
      entry.bytes = new Uint8Array(await file.arrayBuffer());
      if (entry.bytes.byteLength > MAX_IMPORT_BYTES) {
        entry.bytes = new Uint8Array();
        throw new Error('读取时文件超过 32 MiB 限制，请拆分后重试。');
      }
      if (entry.bytes.byteLength > MAX_IMPORT_TOTAL_BYTES - usedBytes) {
        throw new Error('读取时总内容超过 128 MiB 限制，请分批选择文件。');
      }
      usedBytes += entry.bytes.byteLength;
    } catch (error) {
      entry.bytes = new Uint8Array();
      entry.error = readableError(error).message;
    }
    result.push(entry);
  }
  return result;
}

export async function pickFiles(scope: 'toolbox' | 'timeline' = 'toolbox'): Promise<ImportedFile[]> {
  if (isDesktop()) {
    return (await nativeInvoke<NativeImportedFile[]>('select_files', scope === 'timeline' ? { singleSrt: true } : undefined)).map(fromNative);
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = scope === 'timeline' ? '.srt' : '.srt,.vtt,.ass,.ssa,.txt,.csv';
    input.multiple = scope === 'toolbox';
    input.hidden = true;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', handleFocus);
      input.remove();
    };
    const finish = (files: ImportedFile[]) => {
      if (settled) return;
      cleanup();
      resolve(files);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(readableError(error));
    };
    // Modern Chromium provides cancel; the focus fallback also covers older preview browsers.
    const handleFocus = () => window.setTimeout(() => {
      if (!input.files?.length) finish([]);
    }, 350);
    input.addEventListener('change', () => { void readBrowserFiles(input.files ?? []).then(finish, fail); }, { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    window.addEventListener('focus', handleFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}

export async function readDroppedFiles(paths: string[]): Promise<ImportedFile[]> {
  if (!isDesktop()) throw new Error('浏览器预览请直接拖入文件，不能通过本地路径读取。');
  return (await nativeInvoke<NativeImportedFile[]>('read_dropped_files', { paths })).map(fromNative);
}

export async function saveOutput(
  name: string,
  bytes: Uint8Array,
  directory?: string,
): Promise<string | null> {
  if (isDesktop()) {
    return nativeInvoke<string | null>('save_output', { name, bytes: Array.from(bytes), directory: directory || null });
  }
  if (!name || /[<>:"/\\|?*]/u.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) {
    throw new Error('导出文件名包含无效字符。');
  }
  // Copy to a plain ArrayBuffer for browsers and strict TypeScript BlobPart compatibility.
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isDesktop()) throw new Error('浏览器预览使用系统下载目录；请在桌面应用中设置输出目录。');
  return nativeInvoke<string | null>('select_directory');
}

export interface PreparedFolderExport {
  exportId: string;
  directory: string;
  entries: Array<{ id: string; relativePath: string; renamed: boolean; error?: string }>;
}

/** The returned token authorizes this immutable plan only, until finishFolderExport or app exit. */
export async function prepareFolderExport(outputs: readonly PlannedOutput[], directory?: string): Promise<PreparedFolderExport | null> {
  if (!isDesktop()) throw new Error('目录输出仅在桌面版可用；浏览器可导出保留层级的 ZIP。');
  validatePlannedOutputs(outputs);
  if (outputs.some(output => !output.sourcePath)) throw new Error('目录输出需要本次已授权的原生输入，请重新导入文件。');
  return nativeInvoke<PreparedFolderExport | null>('prepare_folder_export', {
    exportId: crypto.randomUUID(), directory: directory || null,
    entries: outputs.map(output => ({ id: output.id, relativePath: output.relativePath, sourcePath: output.sourcePath })),
  });
}

export async function writeFolderExport(exportId: string, id: string, bytes: Uint8Array): Promise<{ path: string; relativePath: string }> {
  if (!isDesktop()) throw new Error('目录输出仅在桌面版可用。');
  return nativeInvoke('write_folder_export', { exportId, id, bytes: Array.from(bytes) });
}

/** Cancels an in-flight write at a 64 KiB boundary, preserves completed files, releases all handles. */
export async function finishFolderExport(exportId: string): Promise<void> {
  if (!isDesktop()) return;
  await nativeInvoke<void>('finish_folder_export', { exportId });
}

export async function openOutputDirectory(path: string): Promise<void> {
  if (!isDesktop()) throw new Error('浏览器预览请在浏览器的下载列表中查看文件。');
  await nativeInvoke<void>('open_output_directory', { path });
}

/** This custom event is emitted only after Rust has approved the native dropped paths. */
export async function subscribeFileDrop(
  onFiles: (files: ImportedFile[]) => void,
  onError: (error: Error) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string[]>('subtitle-tools:files-dropped', (event) => {
    void readDroppedFiles(event.payload).then(onFiles).catch((error: unknown) => onError(readableError(error)));
  });
}
