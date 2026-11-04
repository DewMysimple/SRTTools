import { invoke, isTauri } from '@tauri-apps/api/core';

export const PRESET_STORAGE_KEY = 'tool-presets-v1';
export const WORKFLOW_STORAGE_KEY = 'workflow-presets-v1';
export const PRESET_TRANSACTION_KEY = 'subtitle-tools:preset-transaction-v1';
export type StorageKey = 'settings' | 'history' | typeof PRESET_STORAGE_KEY | typeof WORKFLOW_STORAGE_KEY;

export interface PresetValues { tools: unknown; workflows: unknown }

function isPresetKey(key: StorageKey): boolean {
  return key === PRESET_STORAGE_KEY || key === WORKFLOW_STORAGE_KEY;
}

function browserKey(key: StorageKey): string { return `subtitle-tools:${key}`; }

function restoreBrowserValue(key: StorageKey, raw: string | null): void {
  if (raw === null) localStorage.removeItem(browserKey(key));
  else localStorage.setItem(browserKey(key), raw);
}

/** A journal means the previous two values are still committed, including their exact bytes. */
function recoverBrowserPresetTransaction(): void {
  const raw = localStorage.getItem(PRESET_TRANSACTION_KEY);
  if (raw === null) return;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error('预设事务恢复记录损坏，原数据已保留，请先备份。'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('预设事务恢复记录无效，原数据已保留。');
  const journal = value as Record<string, unknown>;
  if (Object.keys(journal).sort().join(',') !== 'schemaVersion,tools,workflows' || journal.schemaVersion !== 1
    || !(journal.tools === null || typeof journal.tools === 'string')
    || !(journal.workflows === null || typeof journal.workflows === 'string')) {
    throw new Error('预设事务恢复版本不受支持，原数据已保留。');
  }
  restoreBrowserValue(PRESET_STORAGE_KEY, journal.tools);
  restoreBrowserValue(WORKFLOW_STORAGE_KEY, journal.workflows);
  localStorage.removeItem(PRESET_TRANSACTION_KEY);
}

export class PresetJsonParseError extends Error {
  constructor() {
    super('本地预设 JSON 损坏，无法读取。');
    this.name = 'PresetJsonParseError';
  }
}

/** Desktop storage paths are fixed in Rust, never supplied by the renderer. */
export async function readLocalValue(key: StorageKey): Promise<unknown> {
  if (isTauri()) return invoke<unknown>('get_local_value', { key });
  if (isPresetKey(key)) recoverBrowserPresetTransaction();
  const raw = localStorage.getItem(browserKey(key));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (isPresetKey(key)) throw new PresetJsonParseError();
    throw new Error('本地设置文件损坏，无法读取。请清理相应设置后重试。');
  }
}

export async function writeLocalValue(key: StorageKey, value: unknown): Promise<void> {
  if (isTauri()) {
    await invoke('set_local_value', { key, value });
    return;
  }
  try {
    if (isPresetKey(key)) recoverBrowserPresetTransaction();
    localStorage.setItem(browserKey(key), JSON.stringify(value));
  } catch {
    throw new Error('无法保存本地设置，存储空间可能已满。');
  }
}

/** A coherent pair, never settings/history and never a renderer-supplied filesystem path. */
export async function readPresetValues(): Promise<PresetValues> {
  if (isTauri()) return invoke<PresetValues>('get_preset_values');
  recoverBrowserPresetTransaction();
  return { tools: await readLocalValue(PRESET_STORAGE_KEY), workflows: await readLocalValue(WORKFLOW_STORAGE_KEY) };
}

export async function writePresetValues(expected: PresetValues, next: PresetValues): Promise<void> {
  if (isTauri()) {
    await invoke('set_preset_values', { expected, next });
    return;
  }
  recoverBrowserPresetTransaction();
  const current = await readPresetValues();
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('预设在预览后已改变，请重新预览导入。');
  const tools = JSON.stringify(next.tools);
  const workflows = JSON.stringify(next.workflows);
  if (new TextEncoder().encode(tools).length > 256 * 1024 || new TextEncoder().encode(workflows).length > 512 * 1024) {
    throw new Error('预设事务超过容量限制，原数据已保留。');
  }
  const journal = JSON.stringify({
    schemaVersion: 1,
    tools: localStorage.getItem(browserKey(PRESET_STORAGE_KEY)),
    workflows: localStorage.getItem(browserKey(WORKFLOW_STORAGE_KEY)),
  });
  try {
    localStorage.setItem(PRESET_TRANSACTION_KEY, journal);
    if (next.tools === null) localStorage.removeItem(browserKey(PRESET_STORAGE_KEY));
    else localStorage.setItem(browserKey(PRESET_STORAGE_KEY), tools);
    if (next.workflows === null) localStorage.removeItem(browserKey(WORKFLOW_STORAGE_KEY));
    else localStorage.setItem(browserKey(WORKFLOW_STORAGE_KEY), workflows);
    localStorage.removeItem(PRESET_TRANSACTION_KEY);
  } catch {
    try { recoverBrowserPresetTransaction(); } catch { /* Reads remain blocked until the old snapshot can be restored. */ }
    throw new Error('无法完成预设导入，原有配置已保留或将在下次读取时恢复。');
  }
}
