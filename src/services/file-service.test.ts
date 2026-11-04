import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, desktop, listen } = vi.hoisted(() => ({ invoke: vi.fn(), desktop: { value: false }, listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => desktop.value }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, pickFiles, readBrowserFiles, readDroppedFiles, saveOutput, pickDirectory, subscribeFileDrop, prepareFolderExport, writeFolderExport, finishFolderExport } from './file-service';
import { planFolderOutputs } from './export-service';

function file(name: string, content: string, size = content.length): File {
  const bytes = new TextEncoder().encode(content);
  return { name, size, arrayBuffer: async () => bytes.buffer } as File;
}

beforeEach(() => {
  desktop.value = false;
  invoke.mockReset();
  listen.mockReset();
});

describe('file service import boundary', () => {
  it('isolates unsupported and oversized files while keeping valid files', async () => {
    const result = await readBrowserFiles([
      file('one.srt', 'valid'),
      file('unsafe.exe', 'script'),
      file('large.srt', '', MAX_IMPORT_BYTES + 1),
      file('two.VTT', 'WEBVTT'),
    ]);
    expect(result).toHaveLength(4);
    expect(new TextDecoder().decode(result[0].bytes)).toBe('valid');
    expect(result[0].error).toBeUndefined();
    expect(result[1].error).toContain('不支持');
    expect(result[2].error).toContain('32 MiB');
    expect(result[3].error).toBeUndefined();
    expect(new Set(result.map((entry) => entry.id)).size).toBe(4);
  });

  it('converts native bytes and preserves per-file read failures', async () => {
    desktop.value = true;
    invoke.mockResolvedValue([
      { name: 'one.srt', path: 'C:\\one.srt', bytes: [65, 66], size: 2 },
      { name: 'broken.srt', path: 'C:\\broken.srt', bytes: [], size: 0, error: '文件读取失败' },
    ]);
    const result = await pickFiles();
    expect(invoke).toHaveBeenCalledWith('select_files', undefined);
    expect(result[0].bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result[0].bytes)).toEqual([65, 66]);
    expect(result[1].error).toBe('文件读取失败');
  });

  it('rejects excessive file counts before reading any bytes', async () => {
    const read = vi.fn();
    const selected = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, index) => ({
      name: `${index}.srt`, size: 1, arrayBuffer: read,
    } as unknown as File));
    await expect(readBrowserFiles(selected)).rejects.toThrow('100');
    expect(read).not.toHaveBeenCalled();
  });

  it('enforces total memory budget before reading and retains errors without consuming budget', async () => {
    // Reuse backing memory while representing five separate logical 32 MiB files.
    const buffer = new ArrayBuffer(MAX_IMPORT_BYTES);
    const oversizedRead = vi.fn();
    const reads = Array.from({ length: 5 }, () => vi.fn(async () => buffer));
    const selected = [
      { name: 'oversized.srt', size: MAX_IMPORT_BYTES + 1, arrayBuffer: oversizedRead } as unknown as File,
      ...reads.map((read, index) => ({ name: `${index}.srt`, size: MAX_IMPORT_BYTES, arrayBuffer: read } as unknown as File)),
    ];
    const result = await readBrowserFiles(selected);
    expect(result[0].error).toContain('32 MiB');
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(result.slice(1, 5).every((entry) => !entry.error)).toBe(true);
    expect(result[5].error).toContain('128 MiB');
    expect(result[5].bytes.byteLength).toBe(0);
    expect(reads[4]).not.toHaveBeenCalled();
  });

  it('never attempts browser arbitrary path reads', async () => {
    await expect(readDroppedFiles(['C:\\private.txt'])).rejects.toThrow('不能通过本地路径读取');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports native errors as Error objects usable by UI', async () => {
    desktop.value = true;
    invoke.mockRejectedValue('文件无法读取');
    await expect(pickFiles()).rejects.toThrow('文件无法读取');
  });

  it('listens for the native post-authorization drop event and releases its listener', async () => {
    desktop.value = true;
    const cleanup = vi.fn();
    listen.mockResolvedValue(cleanup);
    invoke.mockResolvedValue([{ name: 'one.srt', path: 'C:\\one.srt', bytes: [65], size: 1 }]);
    const received = vi.fn();
    const failed = vi.fn();
    const unsubscribe = await subscribeFileDrop(received, failed);
    expect(listen).toHaveBeenCalledWith('subtitle-tools:files-dropped', expect.any(Function));
    const callback = listen.mock.calls[0][1] as (event: { payload: string[] }) => void;
    callback({ payload: ['C:\\one.srt'] });
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith('read_dropped_files', { paths: ['C:\\one.srt'] });
    expect(failed).not.toHaveBeenCalled();
    unsubscribe();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('file service export boundary', () => {
  it('passes selected directory and exact binary output to native safe writing', async () => {
    desktop.value = true;
    invoke.mockResolvedValue('C:\\output\\result (1).srt');
    const result = await saveOutput('result.srt', new Uint8Array([0, 255, 66]), 'C:\\output');
    expect(invoke).toHaveBeenCalledWith('save_output', {
      name: 'result.srt', bytes: [0, 255, 66], directory: 'C:\\output',
    });
    expect(result).toBe('C:\\output\\result (1).srt');
  });

  it('preserves user cancellation without a false success path', async () => {
    desktop.value = true;
    invoke.mockResolvedValue(null);
    await expect(saveOutput('result.srt', new Uint8Array())).resolves.toBeNull();
  });

  it('explains output directory limitations in browser preview', async () => {
    await expect(pickDirectory()).rejects.toThrow('浏览器预览');
  });

  it('passes only a reviewed immutable tree and concrete native source paths to a scoped export session', async () => {
    desktop.value = true;
    const input = { id: 'source', name: 'lesson.srt', path: 'C:\\source\\season\\lesson.srt', bytes: new Uint8Array([1]), size: 1, folderSource: { rootId: 'root', rootName: 'source', relativePath: 'season/lesson.srt' } };
    const plan = planFolderOutputs([{ id: 'result', input, output: { name: 'lesson_processed.srt', bytes: new Uint8Array([65, 255]) } }], 'preserve');
    const prepared = { exportId: 'session', directory: 'D:\\output', entries: [{ id: 'result', relativePath: 'season/lesson_processed (1).srt', renamed: true }] };
    invoke.mockResolvedValueOnce(prepared);
    await expect(prepareFolderExport(plan, 'D:\\output')).resolves.toEqual(prepared);
    expect(invoke).toHaveBeenCalledWith('prepare_folder_export', {
      exportId: expect.any(String), directory: 'D:\\output', entries: [{ id: 'result', relativePath: 'season/lesson_processed.srt', sourcePath: input.path }],
    });
    expect(invoke.mock.calls[0][1]).not.toHaveProperty('bytes');
    invoke.mockResolvedValueOnce({ path: 'D:\\output\\season\\lesson_processed (1).srt', relativePath: 'season/lesson_processed (1).srt' });
    await expect(writeFolderExport('session', 'result', plan[0].bytes)).resolves.toMatchObject({ relativePath: 'season/lesson_processed (1).srt' });
    expect(invoke).toHaveBeenLastCalledWith('write_folder_export', { exportId: 'session', id: 'result', bytes: [65, 255] });
    invoke.mockResolvedValueOnce(undefined);
    await finishFolderExport('session');
    expect(invoke).toHaveBeenLastCalledWith('finish_folder_export', { exportId: 'session' });
  });

  it('preserves native output picker cancellation and rejects ungranted browser sources before IPC', async () => {
    const input = { id: 'source', name: 'lesson.srt', bytes: new Uint8Array([1]), size: 1 };
    const plan = planFolderOutputs([{ id: 'result', input, output: { name: 'lesson_processed.srt', bytes: new Uint8Array([1]) } }], 'flat');
    await expect(prepareFolderExport(plan)).rejects.toThrow('浏览器可导出');
    desktop.value = true;
    await expect(prepareFolderExport(plan)).rejects.toThrow('已授权');
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce(null);
    await expect(prepareFolderExport([{ ...plan[0], sourcePath: 'C:\\selected.srt' }])).resolves.toBeNull();
  });
});
