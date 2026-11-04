import { invoke, isTauri } from '@tauri-apps/api/core';

export const PRESET_STORAGE_KEY = 'tool-presets-v1';
export type StorageKey = 'settings' | 'history' | typeof PRESET_STORAGE_KEY;

export class PresetJsonParseError extends Error {
  constructor() {
    super('本地预设 JSON 损坏，无法读取。');
    this.name = 'PresetJsonParseError';
  }
}

/** Desktop storage paths are fixed in Rust, never supplied by the renderer. */
export async function readLocalValue(key: StorageKey): Promise<unknown> {
  if (isTauri()) return invoke<unknown>('get_local_value', { key });
  const raw = localStorage.getItem(`subtitle-tools:${key}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (key === PRESET_STORAGE_KEY) throw new PresetJsonParseError();
    throw new Error('本地设置文件损坏，无法读取。请清理相应设置后重试。');
  }
}

export async function writeLocalValue(key: StorageKey, value: unknown): Promise<void> {
  if (isTauri()) {
    await invoke('set_local_value', { key, value });
    return;
  }
  try {
    localStorage.setItem(`subtitle-tools:${key}`, JSON.stringify(value));
  } catch {
    throw new Error('无法保存本地设置，存储空间可能已满。');
  }
}
