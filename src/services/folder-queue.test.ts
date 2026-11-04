import { beforeEach, expect, it } from 'vitest';
import { nativePathKey, type ImportedFile } from './file-service';
import { useAppStore } from '../stores/app-store';

const file = (path: string): ImportedFile => ({ id: crypto.randomUUID(), path, name: path.split(/[\\/]/u).at(-1)!, bytes: new Uint8Array([1]), size: 1 });
beforeEach(() => useAppStore.setState({ files: [], notices: [], busy: false }));

it('normalizes Windows spelling and extended prefixes without conflating distinct Unicode names', () => {
  expect(nativePathKey('\\\\?\\C:\\字幕\\Episode.SRT')).toBe(nativePathKey('c:/字幕/episode.srt'));
  expect(nativePathKey('\\\\?\\UNC\\Server\\字幕\\A.srt')).toBe(nativePathKey('\\\\server\\字幕\\a.srt'));
  expect(nativePathKey('C:\\é.srt')).not.toBe(nativePathKey('C:\\e\u0301.srt'));
  expect(nativePathKey('C:\\İ.srt')).not.toBe(nativePathKey('C:\\i\u0307.srt'));
  expect(nativePathKey('C:\\ß.srt')).not.toBe(nativePathKey('C:\\SS.srt'));
});

it('does not discard a distinct Unicode filename through expanding JavaScript case folding', () => {
  const dottedCapital = file('C:\\字幕\\İ.srt');
  const combiningDot = file('C:\\字幕\\i\u0307.srt');
  useAppStore.getState().addFiles([dottedCapital, combiningDot]);
  expect(useAppStore.getState().files).toEqual([dottedCapital, combiningDot]);
});

it('a repeated native path keeps queue identity, while identical filenames in other folders remain ordered', () => {
  const first = file('C:\\字幕\\same.srt');
  useAppStore.getState().addFiles([first]);
  const original = useAppStore.getState().files;
  useAppStore.getState().addFiles([file('c:/字幕/SAME.SRT')]);
  expect(useAppStore.getState().files).toBe(original);
  const another = file('D:\\字幕\\same.srt');
  useAppStore.getState().addFiles([another]);
  expect(useAppStore.getState().files).toEqual([first, another]);
});

it('folder delivery cannot grow an existing queue past 100 entries', () => {
  const initial = Array.from({ length: 99 }, (_, index) => file(`C:\\old\\${index}.srt`));
  useAppStore.getState().addFiles(initial);
  useAppStore.getState().addFiles([file('D:\\new\\a.srt'), file('D:\\new\\b.srt')]);
  expect(useAppStore.getState().files).toHaveLength(100);
  expect(useAppStore.getState().files[99].name).toBe('a.srt');
  expect(useAppStore.getState().notices.at(-1)?.kind).toBe('error');
});
