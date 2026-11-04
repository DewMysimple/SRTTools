import { invoke, isTauri } from '@tauri-apps/api/core';
import { MAX_PRESET_IMPORT_BYTES } from './preset-exchange';

/** Independent JSON chooser: does not add the file or its path to the subtitle queue/grants. */
export async function readPresetImportFile(): Promise<Uint8Array | null> {
  if (!isTauri()) throw new Error('请使用预设 JSON 文件选择按钮。');
  try {
    const bytes = await invoke<number[] | null>('read_preset_import_file');
    if (bytes === null) return null;
    if (bytes.length > MAX_PRESET_IMPORT_BYTES) throw new Error('预设 JSON 最多 1 MiB。');
    return Uint8Array.from(bytes);
  } catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}

export async function readBrowserPresetFile(file: File): Promise<Uint8Array> {
  if (!/\.json$/iu.test(file.name)) throw new Error('请选择 JSON 预设文件；此入口不导入字幕。');
  if (file.size > MAX_PRESET_IMPORT_BYTES) throw new Error('预设 JSON 最多 1 MiB，请分批导入。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_PRESET_IMPORT_BYTES) throw new Error('读取时预设 JSON 超过 1 MiB，未修改存储。');
  return bytes;
}
