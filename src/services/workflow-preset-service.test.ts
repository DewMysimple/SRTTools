// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
import { createWorkflowStep } from '../core/workflow';
import {
  createWorkflowPreset, deleteWorkflowPreset, duplicateWorkflowPreset, listWorkflowPresets,
  readWorkflowPreset, updateWorkflowPreset,
} from './workflow-preset-service';
import { WORKFLOW_STORAGE_KEY } from './persistence';

const key = `subtitle-tools:${WORKFLOW_STORAGE_KEY}`;
beforeEach(() => { localStorage.clear(); native.enabled = false; native.invoke.mockReset(); });

describe('saved workflow configurations', () => {
  it('creates, reloads, updates, renames, duplicates and deletes without saving input/authorization', async () => {
    const steps = [createWorkflowStep('remove-empty'), createWorkflowStep('shift')];
    const form = { name: '  中文字幕　 标准清理  ', description: '清理并延后', steps, lossyMode: 'reject' as const, inputPath: 'C:\\private.srt', inputText: '秘密正文', outputDirectory: 'C:\\out' };
    const first = await createWorkflowPreset(form);
    expect(first.name).toBe('中文字幕 标准清理');
    expect(first.createdAt).toBe(first.updatedAt);
    steps[1].params.offsetMs = 8000;
    await expect(readWorkflowPreset(first.id)).resolves.toMatchObject({ steps: [{}, { params: { offsetMs: 1000 } }] });
    expect(localStorage.getItem(key)).not.toMatch(/private|秘密正文|outputDirectory/u);
    const updated = await updateWorkflowPreset(first.id, { name: '新名称', description: '描述', lossyMode: 'normalize', steps });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    const copied = await duplicateWorkflowPreset(first.id, '副本');
    expect(copied.id).not.toBe(first.id);
    expect(copied.steps).toEqual(updated.steps);
    await deleteWorkflowPreset(first.id);
    await expect(readWorkflowPreset(first.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(listWorkflowPresets()).resolves.toMatchObject({ presets: [copied], quarantined: [], readOnly: false });
  });

  it('accepts draft configurations but requires valid parameters and unique stable step IDs', async () => {
    await createWorkflowPreset({ name: '空草稿', steps: [] });
    await createWorkflowPreset({ name: '禁用草稿', steps: [{ ...createWorkflowStep('remove-empty'), enabled: false }] });
    const twenty = Array.from({ length: 20 }, () => createWorkflowStep('clean-spaces'));
    await createWorkflowPreset({ name: '20 步', steps: twenty });
    const before = localStorage.getItem(key);
    await expect(createWorkflowPreset({ name: '21 步', steps: [...twenty, createWorkflowStep('renumber')] })).rejects.toMatchObject({ code: 'invalid-parameters' });
    await expect(createWorkflowPreset({ name: '重复 ID', steps: [twenty[0], twenty[0]] })).rejects.toMatchObject({ code: 'invalid-parameters' });
    const invalid = createWorkflowStep('replace');
    invalid.params = { find: '[', replacement: '', regex: true, caseSensitive: true };
    await expect(createWorkflowPreset({ name: '坏正则', steps: [invalid] })).rejects.toMatchObject({ code: 'invalid-parameters' });
    expect(localStorage.getItem(key)).toBe(before);
  });

  it('normalizes names, rejects hidden/control names and explains conflicts', async () => {
    for (const name of ['', '　', '\uFE0F', '坏\u202e名', '换\n行', '长'.repeat(41)]) {
      await expect(createWorkflowPreset({ name, steps: [] })).rejects.toMatchObject({ code: 'invalid-name' });
    }
    const saved = await createWorkflowPreset({ name: 'Common  Flow', steps: [] });
    await expect(createWorkflowPreset({ name: 'common flow', steps: [] })).rejects.toMatchObject({ code: 'duplicate-name' });
    const other = await createWorkflowPreset({ name: 'Other', steps: [] });
    await expect(updateWorkflowPreset(other.id, { name: saved.name })).rejects.toMatchObject({ code: 'duplicate-name' });
  });

  it('preserves unknown operations, versions, duplicate IDs and invalid rows when editing legal flows', async () => {
    const legal = await createWorkflowPreset({ name: '合法', steps: [createWorkflowStep('remove-empty')] });
    const future = { ...legal, id: crypto.randomUUID(), name: '未来', schemaVersion: 2, futureField: { keep: true } };
    const removedOperation = { ...legal, id: crypto.randomUUID(), name: '旧操作', steps: [{ ...legal.steps[0], operation: 'removed-operation' }] };
    const duplicate = { ...legal, name: '重复身份' };
    const malformed = { unknown: ['exact', 'retained'] };
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, presets: [malformed, legal, future, removedOperation, duplicate] }));
    await expect(listWorkflowPresets()).resolves.toMatchObject({ presets: [legal], quarantined: [{ index: 0 }, { index: 2 }, { index: 3 }, { index: 4 }], readOnly: false });
    await updateWorkflowPreset(legal.id, { name: '只改合法项' });
    const stored = JSON.parse(localStorage.getItem(key)!);
    expect(stored.presets[0]).toEqual(malformed);
    expect(stored.presets.slice(2, 4)).toEqual([future, removedOperation]);
    expect(stored.presets[4]).toMatchObject({ quarantined: true, raw: duplicate });
    await deleteWorkflowPreset(legal.id);
    await expect(listWorkflowPresets()).resolves.toMatchObject({ presets: [], quarantined: [{}, {}, {}, {}] });
  });

  it.each(['{broken', JSON.stringify({ schemaVersion: 2, presets: [{ future: true }] }), JSON.stringify({ schemaVersion: 1, presets: 'broken' })])('isolates damaged/future envelopes and never overwrites them: %s', async raw => {
    localStorage.setItem(key, raw);
    await expect(listWorkflowPresets()).resolves.toMatchObject({ presets: [], readOnly: true, quarantined: [{ index: -1 }] });
    await expect(createWorkflowPreset({ name: '不能覆盖', steps: [] })).rejects.toMatchObject({ code: 'read-only' });
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('counts quarantined rows toward 50 and enforces the 512 KiB store budget', async () => {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, presets: Array.from({ length: 50 }, () => ({ schemaVersion: 2, future: true })) }));
    const before = localStorage.getItem(key);
    await expect(createWorkflowPreset({ name: '第51项', steps: [] })).rejects.toMatchObject({ code: 'limit' });
    expect(localStorage.getItem(key)).toBe(before);
    localStorage.removeItem(key);
    const step = createWorkflowStep('replace');
    step.params.find = '旧'; step.params.replacement = '字'.repeat(50_000);
    for (let i = 0; i < 3; i++) await createWorkflowPreset({ name: `大配置 ${i}`, steps: [step] });
    const full = localStorage.getItem(key);
    await expect(createWorkflowPreset({ name: '超过字节限额', steps: [step] })).rejects.toMatchObject({ code: 'limit' });
    expect(localStorage.getItem(key)).toBe(full);
  });

  it('keeps the editing snapshot and previous storage intact after a failed write', async () => {
    const old = await createWorkflowPreset({ name: '原有', steps: [] });
    const before = localStorage.getItem(key);
    const input = { name: '未保存', steps: [createWorkflowStep('shift')] };
    const snapshot = JSON.stringify(input);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    await expect(createWorkflowPreset(input)).rejects.toMatchObject({ code: 'storage-error' });
    write.mockRestore();
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(localStorage.getItem(key)).toBe(before);
    await expect(readWorkflowPreset(old.id)).resolves.toEqual(old);
    await createWorkflowPreset(input);
  });

  it('serializes saves and uses only the native fixed workflow key', async () => {
    native.enabled = true;
    let stored: unknown = null;
    native.invoke.mockImplementation(async (command: string, args: { key: string; value?: unknown }) => {
      expect(args.key).toBe(WORKFLOW_STORAGE_KEY);
      if (command === 'get_local_value') return structuredClone(stored);
      expect(command).toBe('set_local_value');
      await new Promise(resolve => setTimeout(resolve, 1));
      stored = structuredClone(args.value);
    });
    const first = createWorkflowPreset({ name: '首项', steps: [] });
    const second = createWorkflowPreset({ name: '次项', steps: [] });
    const both = await Promise.all([first, second]);
    expect((await listWorkflowPresets()).presets.map(p => p.id).sort()).toEqual(both.map(p => p.id).sort());
    expect(localStorage.length).toBe(0);
  });
});
