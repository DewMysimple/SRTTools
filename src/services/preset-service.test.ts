// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, desktop } = vi.hoisted(() => ({ invoke: vi.fn(), desktop: { value: false } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => desktop.value }));

import {
  createPreset, deletePreset, listPresets, readPreset, recoverPresetStore, updatePreset,
} from './preset-service';
import { PRESET_STORAGE_KEY } from './persistence';

const storageKey = `subtitle-tools:${PRESET_STORAGE_KEY}`;
const replacement = { find: '觉的', replacement: '觉得', caseSensitive: false, regex: false };
const stamp = '2026-11-04T01:02:03.004Z';
const fixture = {
  id: '8a8bdbe5-e127-4523-a2aa-e0245cd53821', toolId: 'replace', name: '原有预设',
  schemaVersion: 1, parameters: { find: '旧写法', replacement: '新写法' },
  createdAt: stamp, updatedAt: stamp,
};
const presetData = (presets: unknown[]) => JSON.stringify({ schemaVersion: 1, presets });

beforeEach(() => {
  localStorage.clear();
  desktop.value = false;
  invoke.mockReset();
});

describe('tool preset service', () => {
  it('saves only declared parameters across all parameter types and restores them from browser storage', async () => {
    const saved = await createPreset({
      toolId: 'replace', name: '  常用替换  ',
      parameters: { ...replacement, inputFile: 'secret', outputDirectory: 'C:\\private', encoding: 'gbk' },
    });
    await createPreset({ toolId: 'bilingual', name: '常用匹配', parameters: { mode: 'time', toleranceMs: 125, reverse: true } });
    expect(saved).toMatchObject({ name: '常用替换', toolId: 'replace', schemaVersion: 1, parameters: replacement });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(saved.createdAt).toBe(saved.updatedAt);
    expect(localStorage.getItem(storageKey)).not.toMatch(/secret|private|gbk/u);
    await expect(readPreset('replace', saved.id)).resolves.toEqual(saved);
    await expect(listPresets('bilingual')).resolves.toMatchObject({
      ignoredCount: 0, presets: [{ parameters: { mode: 'time', toleranceMs: 125, reverse: true } }],
    });
  });

  it('keeps tools isolated and never changes a saved snapshot until an explicit update', async () => {
    const form = { ...replacement };
    const first = await createPreset({ toolId: 'replace', name: 'Common', parameters: form });
    form.find = '新输入';
    const shift = await createPreset({ toolId: 'shift', name: 'common', parameters: { offsetMs: 2000, policy: 'reject' } });
    const second = await createPreset({ toolId: 'replace', name: 'Another', parameters: form });
    await expect(readPreset('shift', first.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(updatePreset('replace', shift.id, { name: '错误工具' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(deletePreset('replace', shift.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(createPreset({ toolId: 'replace', name: 'CoMmOn', parameters: form })).rejects.toMatchObject({ code: 'duplicate-name' });
    await expect(listPresets('replace')).resolves.toMatchObject({ presets: [second, first] });
    await expect(readPreset('replace', first.id)).resolves.toMatchObject({ parameters: replacement });
    const updated = await updatePreset('replace', first.id, { name: '新名称', parameters: form });
    expect(updated).toMatchObject({ id: first.id, name: '新名称', parameters: form, createdAt: first.createdAt });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    await deletePreset('replace', second.id);
    await expect(listPresets('replace')).resolves.toMatchObject({ presets: [updated] });
    await expect(readPreset('shift', shift.id)).resolves.toEqual(shift);
  });

  it('validates names, types, bounds, options, regexes and tools before persisting', async () => {
    for (const name of ['', '　', '\uFE0F', '\n无效', '坏\u007f名', '长'.repeat(41)]) {
      await expect(createPreset({ toolId: 'replace', name, parameters: replacement })).rejects.toMatchObject({ code: 'invalid-name' });
    }
    await expect(createPreset({ toolId: 'renumber', name: '参数为空', parameters: {} })).rejects.toMatchObject({ code: 'unknown-tool' });
    for (const [toolId, parameters] of [
      ['replace', { ...replacement, caseSensitive: 'false' }],
      ['replace', { ...replacement, regex: true, find: '[' }],
      ['shift', { offsetMs: Infinity, policy: 'reject' }],
      ['shift', { offsetMs: 1.25, policy: 'reject' }],
      ['shift', { offsetMs: Number.MAX_SAFE_INTEGER + 1, policy: 'reject' }],
      ['shift', { offsetMs: 1000, policy: 'missing' }],
      ['wrap', { maxChars: 10_001 }],
      ['split-count', { count: 1_000_001 }],
      ['crop', { startMs: 4000, endMs: 2000 }],
    ] as const) {
      await expect(createPreset({ toolId, name: '无效参数', parameters })).rejects.toMatchObject({ code: 'invalid-parameters' });
    }
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('fills newly declared fields, rejects bad rows, and preserves future-version items', async () => {
    const future = {
      ...fixture, id: '82709f1b-36ab-4527-ae5a-09f3a847ac7d', name: '新版数据', schemaVersion: 2, futureField: 123,
    };
    const current = { ...fixture, parameters: { ...fixture.parameters, path: 'must not be read' } };
    localStorage.setItem(storageKey, presetData([
      current, future, { ...fixture, id: 'invalid-id' },
      { ...fixture, toolId: 'unknown' },
      { ...fixture, parameters: { ...fixture.parameters, regex: 'true' } },
    ]));
    const result = await listPresets('replace');
    expect(result.ignoredCount).toBe(4);
    expect(result.presets).toEqual([{ ...fixture, parameters: { ...fixture.parameters, caseSensitive: false, regex: false } }]);
    await updatePreset('replace', fixture.id, { name: '改名' });
    const stored = JSON.parse(localStorage.getItem(storageKey)!);
    expect(stored.presets).toHaveLength(2);
    expect(stored.presets).toContainEqual(future);
    expect(JSON.stringify(stored)).not.toContain('must not be read');
  });

  it('recovers only broken preset JSON or v1 envelopes and preserves settings/history', async () => {
    localStorage.setItem('subtitle-tools:settings', '{"theme":"dark"}');
    localStorage.setItem('subtitle-tools:history', '[{"id":"history"}]');
    for (const damaged of ['{bad JSON', '{"schemaVersion":1,"presets":"invalid"}']) {
      localStorage.setItem(storageKey, damaged);
      await expect(listPresets('replace')).rejects.toMatchObject({ code: 'corrupt-store' });
      await expect(createPreset({ toolId: 'replace', name: '新建', parameters: replacement })).rejects.toMatchObject({ code: 'corrupt-store' });
      expect(localStorage.getItem(storageKey)).toBe(damaged);
      await recoverPresetStore();
      expect(localStorage.getItem(storageKey)).toBe(presetData([]));
    }
    expect(localStorage.getItem('subtitle-tools:settings')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('subtitle-tools:history')).toBe('[{"id":"history"}]');
    await expect(recoverPresetStore()).rejects.toMatchObject({ code: 'storage-error' });
  });

  it('never resets an unsupported schema or unreadable IPC storage', async () => {
    for (const schemaVersion of [2, '2.1']) {
      const future = JSON.stringify({ schemaVersion, presets: [{ newType: true }] });
      localStorage.setItem(storageKey, future);
      await expect(listPresets('replace')).rejects.toMatchObject({ code: 'unsupported-version' });
      await expect(recoverPresetStore()).rejects.toMatchObject({ code: 'unsupported-version' });
      expect(localStorage.getItem(storageKey)).toBe(future);
    }

    desktop.value = true;
    invoke.mockRejectedValue('访问被拒绝');
    await expect(recoverPresetStore()).rejects.toMatchObject({ code: 'storage-error' });
    expect(invoke.mock.calls).toEqual([['get_local_value', { key: PRESET_STORAGE_KEY }]]);
  });

  it('enforces per-tool, total and UTF-8 storage budgets without damaging existing rows', async () => {
    const parameters = { offsetMs: 0, policy: 'reject' };
    const tooLong = { ...replacement, replacement: '字'.repeat(90_000) };
    await expect(createPreset({ toolId: 'replace', name: '超过容量', parameters: tooLong })).rejects.toMatchObject({ code: 'limit' });
    const fullTool = Array.from({ length: 20 }, (_, i) => ({
      ...fixture, id: `8a8bdbe5-e127-4523-a2aa-${String(i).padStart(12, '0')}`, name: `偏移 ${i}`, toolId: 'shift', parameters,
    }));
    localStorage.setItem(storageKey, presetData(fullTool));
    await expect(createPreset({ toolId: 'shift', name: '第 21 个', parameters })).rejects.toMatchObject({ code: 'limit' });
    expect(localStorage.getItem(storageKey)).toBe(presetData(fullTool));
    const futureItems = Array.from({ length: 80 }, () => ({ schemaVersion: 2 }));
    localStorage.setItem(storageKey, presetData([...fullTool, ...futureItems]));
    await expect(createPreset({ toolId: 'replace', name: '全局第 101 个', parameters: replacement })).rejects.toMatchObject({ code: 'limit' });
  });

  it('serializes native reads/writes, keeps the queue alive after failure, and uses only the fixed key', async () => {
    desktop.value = true;
    let stored: unknown = null;
    let failNext = true;
    invoke.mockImplementation(async (command: string, { key, value }: { key: string; value?: unknown }) => {
      expect(key).toBe(PRESET_STORAGE_KEY);
      if (command === 'get_local_value') return structuredClone(stored);
      expect(command).toBe('set_local_value');
      await new Promise(resolve => setTimeout(resolve, 1));
      if (failNext) {
        failNext = false;
        throw new Error('磁盘已满');
      }
      stored = structuredClone(value);
    });
    const input = { toolId: 'replace', parameters: replacement };
    const failed = createPreset({ ...input, name: '写入失败' });
    const first = createPreset({ ...input, name: '首项' });
    const second = createPreset({ ...input, name: '次项' });
    const listed = listPresets('replace');
    await expect(failed).rejects.toMatchObject({ code: 'storage-error' });
    const savedFirst = await first;
    const savedSecond = await second;
    await expect(listed).resolves.toMatchObject({ presets: [savedSecond, savedFirst] });
    const deleting = deletePreset('replace', savedFirst.id);
    const renaming = updatePreset('replace', savedSecond.id, { name: '更新名称' });
    await deleting;
    const updated = await renaming;
    await expect(listPresets('replace')).resolves.toEqual({ presets: [updated], ignoredCount: 0 });
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
