import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createZip, safeFileName, uniqueOutputNames } from './export-service';

describe('safe ZIP exports', () => {
  it('does not silently replace duplicate or case-insensitive names', async () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const zip = await JSZip.loadAsync(await createZip([
      { name: 'movie.srt', bytes: bytes('first') },
      { name: 'MOVIE.srt', bytes: bytes('second') },
      { name: 'movie (2).srt', bytes: bytes('third') },
      { name: 'movie.srt', bytes: bytes('fourth') },
    ]));
    expect(Object.keys(zip.files)).toEqual(['movie.srt', 'MOVIE (2).srt', 'movie (2) (2).srt', 'movie (3).srt']);
    expect(await zip.file('movie.srt')?.async('string')).toBe('first');
    expect(await zip.file('MOVIE (2).srt')?.async('string')).toBe('second');
  });

  it('keeps all ZIP entries at the archive root and handles Windows device names', async () => {
    const zip = await JSZip.loadAsync(await createZip([{ name: '../CON.srt', bytes: new Uint8Array([1, 2]) }]));
    expect(Object.keys(zip.files)).toEqual(['.._CON.srt']);
    expect(safeFileName('CON.srt')).toBe('_CON.srt');
    expect(safeFileName('COM¹.srt')).toBe('_COM¹.srt');
    expect(safeFileName('lpt³.vtt')).toBe('_lpt³.vtt');
    expect(safeFileName('...')).toBe('subtitle');
    expect(safeFileName('test.srt.  ')).toBe('test.srt');
  });

  it('handles canonically equivalent Unicode filenames', () => {
    const outputs = uniqueOutputNames([
      { name: 'café.srt', bytes: new Uint8Array() },
      { name: 'cafe\u0301.srt', bytes: new Uint8Array() },
    ]);
    expect(outputs[0].name).toBe('café.srt');
    expect(outputs[1].name).toBe('cafe\u0301 (2).srt');
  });

  it('leaves room for collision suffixes and never cuts an emoji surrogate pair', () => {
    const longName = `${'字😀'.repeat(100)}.srt`;
    const outputs = uniqueOutputNames([
      { name: longName, bytes: new Uint8Array() },
      { name: longName, bytes: new Uint8Array() },
    ]);
    expect(outputs[0].name.length).toBeLessThanOrEqual(220);
    expect(outputs[1].name.length).toBeLessThanOrEqual(220);
    expect(outputs[1].name).toMatch(/ \(2\)\.srt$/u);
    expect(new TextDecoder().decode(new TextEncoder().encode(outputs[1].name))).toBe(outputs[1].name);
  });

  it('rejects an empty export', async () => {
    await expect(createZip([])).rejects.toThrow('没有可导出');
  });
});
