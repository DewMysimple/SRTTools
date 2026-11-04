import { invoke } from '@tauri-apps/api/core';
import type { ImportedFile } from './file-service';

export interface ExplorerStatus { available: boolean; enabled: boolean; conflict: boolean; otherInstallation: boolean }
interface ExternalBatch {
  files: { name: string; path: string; bytes: number[]; size: number }[];
  rejected: number;
  duplicates: number;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}
export const getExplorerIntegration = () => call<ExplorerStatus>('get_explorer_integration');
export const setExplorerIntegration = (enabled: boolean) => call<ExplorerStatus>('set_explorer_integration', { enabled });
export async function onExternalImport(callback: () => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen('subtitle-tools:external-import-pending', callback);
}
export async function takeExternalImports(existing: readonly ImportedFile[]) {
  const result = await call<ExternalBatch>('take_external_imports', {
    existingPaths: existing.flatMap(file => file.path ? [file.path] : []), existingCount: existing.length,
    existingBytes: existing.reduce((total, file) => total + file.bytes.byteLength, 0),
  });
  return { ...result, files: result.files.map(file => ({ ...file, id: crypto.randomUUID(), bytes: Uint8Array.from(file.bytes) })) };
}
