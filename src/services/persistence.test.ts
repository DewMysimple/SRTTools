import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendHistory, clearHistory, loadHistory, type HistoryRecord } from './history-service';
import { defaultSettings, loadSettings, saveSettings, validateFileNamePattern } from './settings-service';
import { useAppStore } from '../stores/app-store';

const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));

let storage: Map<string, string>;
beforeEach(() => {
  native.enabled = false;
  native.invoke.mockReset();
  storage = new Map();
  useAppStore.setState({ files: [], settings: defaultSettings, history: [], notices: [], initialized: false });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

const record = (id: string): HistoryRecord => ({
  id, createdAt: '2026-11-03T10:00:00.000Z', toolName: '时间偏移',
  inputCount: 2, successCount: 1, failedCount: 1, outputDirectory: 'E:\\Export', summary: '1 个文件处理成功',
});

describe('startup and file queue isolation', () => {
  it('loads valid settings even if the history key contains damaged JSON', async () => {
    await saveSettings({ ...defaultSettings, theme: 'dark' });
    storage.set('subtitle-tools:history', '{broken');
    await useAppStore.getState().initialize();
    expect(useAppStore.getState()).toMatchObject({ settings: { theme: 'dark' }, history: [], initialized: true });
    expect(useAppStore.getState().notices[0]?.message).toContain('处理记录读取失败');
    expect(storage.get('subtitle-tools:history')).toBe('{broken');
  });

  it('loads valid history even if the settings key contains damaged JSON', async () => {
    await appendHistory(record('a'));
    storage.set('subtitle-tools:settings', '{broken');
    await useAppStore.getState().initialize();
    expect(useAppStore.getState()).toMatchObject({ settings: defaultSettings, history: [record('a')], initialized: true });
    expect(useAppStore.getState().notices[0]?.message).toContain('本地设置读取失败');
  });

  it('preserves queue identity when a chooser cancels or repeats the same native path', () => {
    const { addFiles } = useAppStore.getState();
    const original = { id: 'original', name: '中文 (😀).srt', path: 'D:\\示例\\中文 (😀).srt', bytes: new Uint8Array(1), size: 1 };
    addFiles([original]);
    const queue = useAppStore.getState().files;
    addFiles([]);
    expect(useAppStore.getState().files).toBe(queue);
    addFiles([{ ...original, id: 'repeated' }]);
    expect(useAppStore.getState().files).toBe(queue);
    addFiles([{ ...original, id: 'another', path: 'D:\\另一个目录\\中文 (😀).srt' }]);
    expect(useAppStore.getState().files.map(file => file.id)).toEqual(['original', 'another']);
  });
});

describe('settings persistence', () => {
  it('starts with Chinese-app defaults and reloads saved values', async () => {
    expect(await loadSettings()).toEqual(defaultSettings);
    const modified = { ...defaultSettings, theme: 'dark' as const, lineEnding: 'LF' as const, fileNamePattern: '{name}_{index}' };
    await saveSettings(modified);
    expect(await loadSettings()).toEqual(modified);
  });

  it('validates naming rules before changing persistent settings', async () => {
    await expect(saveSettings({ ...defaultSettings, fileNamePattern: '../{name}' })).rejects.toThrow('文件名规则');
    expect(storage.size).toBe(0);
    expect(() => validateFileNamePattern('{unknown}')).toThrow('占位符');
  });

  it('normalizes unknown stored fields without accepting wrong types', async () => {
    storage.set('subtitle-tools:settings', JSON.stringify({ theme: 'unknown', autoOpenDirectory: 'yes', outputEncoding: 'gbk', showPreview: false }));
    expect(await loadSettings()).toEqual({ ...defaultSettings, showPreview: false });
  });

  it('reports damaged storage rather than swallowing errors', async () => {
    storage.set('subtitle-tools:settings', '{broken');
    await expect(loadSettings()).rejects.toThrow('损坏');
  });

  it('uses fixed-key native persistence instead of renderer-supplied paths', async () => {
    native.enabled = true;
    native.invoke.mockResolvedValue(null);
    await loadSettings();
    await saveSettings(defaultSettings);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'get_local_value', { key: 'settings' });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'set_local_value', { key: 'settings', value: defaultSettings });
  });
});

describe('history persistence', () => {
  it('serializes concurrent appends and strips subtitle payloads', async () => {
    const withBody = { ...record('a'), text: '秘密字幕全文', cues: [{ text: '秘密字幕全文' }] };
    await Promise.all([appendHistory(withBody), appendHistory(record('b'))]);
    const reloaded = await loadHistory();
    expect(reloaded.map((item) => item.id)).toEqual(['b', 'a']);
    expect(storage.get('subtitle-tools:history')).not.toContain('秘密字幕全文');
    expect(reloaded[1]).toEqual(record('a'));
  });

  it('updates an existing record by ID and clears the persisted list', async () => {
    await appendHistory(record('a'));
    await appendHistory({ ...record('a'), outputPaths: ['E:\\Export\\movie.srt'] });
    expect(await loadHistory()).toHaveLength(1);
    expect((await loadHistory())[0].outputPaths).toEqual(['E:\\Export\\movie.srt']);
    await clearHistory();
    expect(await loadHistory()).toEqual([]);
  });

  it('rejects invalid metadata', async () => {
    await expect(appendHistory({ ...record('a'), successCount: -1 })).rejects.toThrow('格式无效');
  });
});
