import { readLocalValue, writeLocalValue } from './persistence';

export interface HistoryRecord {
  id: string;
  createdAt: string;
  toolName: string;
  inputCount: number;
  successCount: number;
  failedCount: number;
  outputDirectory: string;
  summary: string;
  outputPaths?: string[];
}

const HISTORY_LIMIT = 200;
let pendingWrite: Promise<unknown> = Promise.resolve();

function sanitizeRecord(value: unknown): HistoryRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const strings = ['id', 'createdAt', 'toolName', 'outputDirectory', 'summary'] as const;
  if (!strings.every((key) => typeof raw[key] === 'string')) return null;
  const counts = ['inputCount', 'successCount', 'failedCount'] as const;
  if (!counts.every((key) => Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0)) return null;
  if (!Number.isFinite(Date.parse(raw.createdAt as string))) return null;
  // Pick metadata explicitly: extra properties (including subtitle text) never persist.
  return {
    id: raw.id as string,
    createdAt: raw.createdAt as string,
    toolName: raw.toolName as string,
    inputCount: raw.inputCount as number,
    successCount: raw.successCount as number,
    failedCount: raw.failedCount as number,
    outputDirectory: raw.outputDirectory as string,
    summary: (raw.summary as string).slice(0, 2000),
    ...(Array.isArray(raw.outputPaths)
      ? { outputPaths: raw.outputPaths.filter((path): path is string => typeof path === 'string').slice(0, 1000) }
      : {}),
  };
}

export async function loadHistory(): Promise<HistoryRecord[]> {
  const value = await readLocalValue('history');
  return Array.isArray(value)
    ? value.map(sanitizeRecord).filter((record): record is HistoryRecord => record !== null).slice(0, HISTORY_LIMIT)
    : [];
}

function serializeWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = pendingWrite.then(write, write);
  pendingWrite = next.catch(() => undefined);
  return next;
}

export async function appendHistory(record: HistoryRecord): Promise<HistoryRecord[]> {
  return serializeWrite(async () => {
    const safeRecord = sanitizeRecord(record);
    if (!safeRecord) throw new Error('处理记录格式无效，无法保存。');
    const records = [safeRecord, ...(await loadHistory()).filter((item) => item.id !== safeRecord.id)].slice(0, HISTORY_LIMIT);
    await writeLocalValue('history', records);
    return records;
  });
}

export async function clearHistory(): Promise<void> {
  await serializeWrite(() => writeLocalValue('history', []));
}
