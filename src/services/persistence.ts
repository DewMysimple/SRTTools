import { invoke, isTauri } from '@tauri-apps/api/core';

export type StorageKey = 'settings' | 'history';

/** Desktop storage paths are fixed in Rust, never supplied by the renderer. */
export async function readLocalValue(key: StorageKey): Promise<unknown> {
  if (isTauri()) return invoke<unknown>('get_local_value', { key });
  const raw = localStorage.getItem(`subtitle-tools:${key}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
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
