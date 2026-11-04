import type { ParseDiagnostic, SubtitleDocument } from '../core';
import type { ImportedFile } from './file-service';

export interface ProcessingOptions {
  encoding?: string;
  lineEnding: 'LF' | 'CRLF';
  outputEncoding: string;
  fileNamePattern: string;
  /** Stable positions in the original queue, including when only failed items are retried. */
  fileIndexes?: Record<string, number>;
}

export type TaskStatus = 'queued' | 'processing' | 'success' | 'failed' | 'cancelled';

export interface ProcessedOutput {
  name: string;
  bytes: Uint8Array;
  text: string;
  document?: SubtitleDocument;
}

export interface ProcessedTask {
  id: string;
  inputName: string;
  inputSize: number;
  status: TaskStatus;
  document?: SubtitleDocument;
  /** Independent input snapshots for visual comparison only; never persisted in reports or history. */
  comparison?: { before: SubtitleDocument; after: SubtitleDocument; toleranceMs: number };
  comparisonUnavailable?: 'input-errors' | 'uncertain-encoding';
  diagnostics: ParseDiagnostic[];
  inputDiagnostics?: ParseDiagnostic[];
  outputs: ProcessedOutput[];
  summary: string;
  errorMessage?: string;
  errorCode?: string;
}

export interface ProcessingRequest {
  kind: 'file' | 'combined';
  files: ImportedFile[];
  operation: string;
  params: Record<string, unknown>;
  options: ProcessingOptions;
}

export interface WorkerReply {
  requestId: string;
  result?: ProcessedTask;
  error?: string;
}

type RequestRunner = (request: ProcessingRequest, signal?: AbortSignal) => Promise<ProcessedTask>;

export function initialTask(file: ImportedFile): ProcessedTask {
  return {
    id: file.id, inputName: file.name, inputSize: file.size, status: 'queued',
    diagnostics: [], outputs: [], summary: '等待处理',
  };
}

function abortError(): DOMException {
  return new DOMException('处理已取消。', 'AbortError');
}

export function runWorkerRequest(request: ProcessingRequest, signal?: AbortSignal): Promise<ProcessedTask> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/subtitle.worker.ts', import.meta.url), { type: 'module' });
    const requestId = globalThis.crypto.randomUUID();
    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? '字幕处理失败，请重试。'));
    };
    worker.onerror = () => { cleanup(); reject(new Error('字幕处理进程意外退出，请重试。')); };
    worker.onmessageerror = () => { cleanup(); reject(new Error('无法接收字幕处理结果，请重试。')); };
    // Structured cloning keeps the input bytes available for retries and encoding changes.
    try { worker.postMessage({ requestId, request }); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Sequential processing isolates failures and bounds the number of live workers to one. */
export function createFileProcessor(runRequest: RequestRunner = runWorkerRequest) {
  return async function processFiles(
    files: readonly ImportedFile[], operation: string, params: Record<string, unknown>, options: ProcessingOptions,
    onProgress?: (task: ProcessedTask) => void, signal?: AbortSignal,
  ): Promise<ProcessedTask[]> {
    const tasks = files.map(initialTask);
    const jobOptions = options.fileIndexes ? options : {
      ...options, fileIndexes: Object.fromEntries(files.map((file, index) => [file.id, index + 1])),
    };
    tasks.forEach((task) => onProgress?.(task));
    for (let index = 0; index < files.length; index++) {
      const initial = tasks[index];
      if (signal?.aborted) {
        tasks[index] = { ...initial, status: 'cancelled', summary: '已取消，未导出文件' };
        onProgress?.(tasks[index]);
        continue;
      }
      onProgress?.({ ...initial, status: 'processing', summary: '正在处理' });
      try {
        tasks[index] = await runRequest({ kind: 'file', files: [files[index]], operation, params, options: jobOptions }, signal);
      } catch (error) {
        const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
        tasks[index] = {
          ...initial,
          status: cancelled ? 'cancelled' : 'failed',
          summary: cancelled ? '已取消，未导出文件' : '处理失败',
          ...(cancelled ? {} : { errorMessage: error instanceof Error ? error.message : '处理失败，请重试。' }),
        };
      }
      onProgress?.(tasks[index]);
    }
    return tasks;
  };
}

export const processFiles = createFileProcessor();

export async function processCombinedFiles(
  files: ImportedFile[], operation: 'merge' | 'bilingual' | 'compare', params: Record<string, unknown>,
  options: ProcessingOptions, signal?: AbortSignal,
): Promise<ProcessedTask> {
  if (files.length < 2) throw new Error('请至少选择两个字幕文件。');
  return runWorkerRequest({ kind: 'combined', files, operation, params, options }, signal);
}
