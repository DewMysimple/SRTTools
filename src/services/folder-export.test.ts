import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { ImportedFile } from './file-service';
import { createPlannedZip, MAX_EXPORT_FILES, planFolderOutputs, safeFileName, validatePlannedOutputs, validateRelativeOutputPath } from './export-service';

const bytes = (value: string) => new TextEncoder().encode(value);
function input(id: string, relativePath: string, rootId = 'root-one', rootName = '中文字幕'): ImportedFile {
  return { id, name: relativePath.split('/').at(-1)!, path: `C:\\${rootId}\\${relativePath.replaceAll('/', '\\')}`, size: 6, bytes: bytes('source'), folderSource: { rootId, rootName, relativePath } };
}
const entry = (id: string, relative: string, outputName = 'movie_processed.srt', rootId?: string, rootName?: string) => ({ id, input: input(id, relative, rootId, rootName), output: { name: outputName, bytes: bytes(id) } });

describe('reviewed folder output tree', () => {
  it('keeps two and five-level directories and produces exactly the reviewed ZIP tree and bytes', async () => {
    const entries = [entry('1', '剧集/S01/E01.srt', 'E01_processed.srt'), entry('2', '第一/二/三/四/五/繁體 😀.srt', '繁體 😀_processed.srt')];
    const originals = entries.map(item => Uint8Array.from(item.input.bytes));
    const plan = planFolderOutputs(entries, 'preserve');
    expect(plan.map(item => item.relativePath)).toEqual(['剧集/S01/E01_processed.srt', '第一/二/三/四/五/繁體 😀_processed.srt']);
    const zip = await JSZip.loadAsync(await createPlannedZip(plan));
    expect(Object.keys(zip.files)).toEqual(plan.map(item => item.relativePath));
    for (const item of plan) expect(await zip.file(item.relativePath)!.async('uint8array')).toEqual(item.bytes);
    expect(entries.map(item => item.input.bytes)).toEqual(originals);
  });

  it('groups multiple same-named native roots under visible unique aliases', () => {
    const plan = planFolderOutputs([entry('1', 'S01/E01.srt', 'E01.srt', 'root-one', '字幕'), entry('2', 'S01/E01.srt', 'E01.srt', 'root-two', '字幕')], 'preserve');
    expect(plan.map(item => item.relativePath)).toEqual(['字幕/S01/E01.srt', '字幕 (2)/S01/E01.srt']);
    expect(plan[1].renamed).toBe(true);
    expect(plan[1].inputRelativePath).toBe('字幕/S01/E01.srt');
  });

  it('flattens paths with case-insensitive, Unicode-aware conflicts and never drops a file', async () => {
    const plan = planFolderOutputs([entry('1', 'A/a.srt', 'Movie.srt'), entry('2', 'B/a.srt', 'movie.srt'), entry('3', 'C/a.srt', 'MOVIE (2).srt')], 'flat');
    expect(plan.map(item => item.relativePath)).toEqual(['Movie.srt', 'movie (2).srt', 'MOVIE (2) (2).srt']);
    expect(plan.every(item => !item.relativePath.includes('/'))).toBe(true);
    const zip = await JSZip.loadAsync(await createPlannedZip(plan));
    expect(Object.keys(zip.files)).toHaveLength(3);
  });

  it('keeps distinct normal-equivalent or case-equivalent directories in separate visible aliases', () => {
    const plan = planFolderOutputs([entry('1', 'É/one.srt', 'one.srt'), entry('2', 'E\u0301/two.srt', 'two.srt'), entry('3', 'É/three.srt', 'three.srt')], 'preserve');
    expect(plan.map(item => item.relativePath)).toEqual(['É/one.srt', 'E\u0301 (2)/two.srt', 'É/three.srt']);
    expect(plan[1].renamed).toBe(true);
  });

  it('avoids file/directory prefix conflicts regardless of input ordering', () => {
    const plain: ImportedFile = { id: 'plain', name: 'dir.srt', bytes: bytes('plain'), size: 5 };
    const one = planFolderOutputs([{ id: 'plain', input: plain, output: { name: 'dir.srt', bytes: bytes('1') } }, entry('nested', 'dir.srt/item.srt', 'item.srt')], 'preserve');
    expect(one.map(item => item.relativePath)).toEqual(['dir.srt', 'dir.srt (2)/item.srt']);
    const two = planFolderOutputs([entry('nested', 'dir.srt/item.srt', 'item.srt'), { id: 'plain', input: plain, output: { name: 'dir.srt', bytes: bytes('1') } }], 'preserve');
    expect(two.map(item => item.relativePath)).toEqual(['dir.srt/item.srt', 'dir (2).srt']);
    expect(() => validatePlannedOutputs(one)).not.toThrow();
    expect(() => validatePlannedOutputs(two)).not.toThrow();
  });

  it('rejects malicious source root-relative metadata rather than trusting it as a target', () => {
    for (const relative of ['../escape.srt', '/absolute.srt', 'C:/escape.srt', '//server/share/file.srt', 'nested/../escape.srt', 'nested\\escape.srt', 'a//b.srt']) {
      expect(() => planFolderOutputs([entry('1', relative)], 'preserve')).toThrow('相对路径');
    }
  });

  it('normalizes invalid output characters and devices with an explicit renamed flag', () => {
    const plan = planFolderOutputs([entry('1', 'a.srt', 'CON.srt'), entry('2', 'b.srt', 'a:stream.srt'), entry('3', 'c.srt', 'a\u007f.srt')], 'flat');
    expect(plan.map(item => item.relativePath)).toEqual(['_CON.srt', 'a_stream.srt', 'a_.srt']);
    expect(plan.every(item => item.renamed)).toBe(true);
    expect(safeFileName('a\ud800.srt')).toBe('a_.srt');
  });

  it('rejects all unsafe ZIP entry paths and file/directory collisions at the final boundary', async () => {
    const [good] = planFolderOutputs([entry('1', 'a.srt')], 'flat');
    for (const relativePath of ['../escape.srt', 'a/../../x.srt', '/x.srt', '\\\\server\\share\\x.srt', 'C:/x.srt', 'a:stream.srt', 'a./b.srt', 'CON/x.srt', 'LPT¹.srt', 'a/x.exe']) {
      expect(() => validateRelativeOutputPath(relativePath)).toThrow();
      await expect(createPlannedZip([{ ...good, relativePath }])).rejects.toThrow();
    }
    expect(() => validatePlannedOutputs([{ ...good, relativePath: 'a.srt' }, { ...good, id: '2', relativePath: 'A.SRT/child.srt' }])).toThrow('冲突');
    expect(() => validatePlannedOutputs([good, { ...good, id: '2', relativePath: good.relativePath.toUpperCase() }])).toThrow('冲突');
  });

  it('keeps established count/byte bounds, strict relative path lengths, and stable IDs', () => {
    expect(() => planFolderOutputs([], 'flat')).toThrow('没有');
    expect(() => planFolderOutputs(Array.from({ length: MAX_EXPORT_FILES + 1 }, (_, index) => entry(String(index), 'a.srt')), 'flat')).toThrow('100');
    expect(() => planFolderOutputs([entry('same', 'a.srt'), entry('same', 'b.srt')], 'flat')).toThrow('不同结果');
    const large = { ...entry('1', 'large.srt'), output: { name: 'large.srt', bytes: { byteLength: 256 * 1024 * 1024 + 1 } as Uint8Array } };
    expect(() => planFolderOutputs([large], 'flat')).toThrow('256 MiB');
    expect(() => validateRelativeOutputPath(`${'a/'.repeat(11)}x.srt`)).toThrow('层级');
    expect(() => validateRelativeOutputPath(`${'a'.repeat(2048)}.srt`)).toThrow('2048');
  });

  it('supports pre-cancel and live ZIP cancellation, releases listeners, and then retries normally', async () => {
    const source = entry('1', 'long.srt'); source.output.bytes = bytes('中文 very long row 😀 '.repeat(20_000));
    const plan = planFolderOutputs([source], 'preserve');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(createPlannedZip(plan, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const active = new AbortController(); const progress: number[] = [];
    await expect(createPlannedZip(plan, { signal: active.signal, onProgress: percent => { progress.push(percent); active.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.length).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(await createPlannedZip(plan));
    expect(await zip.file(plan[0].relativePath)!.async('uint8array')).toEqual(source.output.bytes);
  });
});
