// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
import { createWorkflowStep } from '../core/workflow';
import { createPreset, listPresets, updatePreset } from './preset-service';
import { createWorkflowPreset, listWorkflowPresets } from './workflow-preset-service';
import {
  confirmPresetImport, exportPresetSelection, listExportablePresets, MAX_PRESET_IMPORT_BYTES,
  PRESET_PRIVACY_NOTICE, previewPresetImport,
} from './preset-exchange';
import {
  PRESET_STORAGE_KEY, WORKFLOW_STORAGE_KEY, PRESET_TRANSACTION_KEY, readLocalValue, readPresetValues, writePresetValues,
} from './persistence';
import { readBrowserPresetFile, readPresetImportFile } from './preset-file-service';

const toolKey = `subtitle-tools:${PRESET_STORAGE_KEY}`;
const workflowKey = `subtitle-tools:${WORKFLOW_STORAGE_KEY}`;
const date = '2026-11-04T01:02:03.004Z';
const replacement = { find: '觉的', replacement: '觉得', regex: false, caseSensitive: false };
const legacy = { schemaVersion: 1, id: '8a8bdbe5-e127-4523-a2aa-e0245cd53821', toolId: 'replace', name: '原有预设',
  parameters: { find: '旧写法', replacement: '新写法' }, createdAt: date, updatedAt: date };
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const exchange = (items: unknown[], extra: object = {}) => encoded({ format: 'srttools-presets', schemaVersion: 1, exportedAt: date, appVersion: '0.4.0', items, ...extra });
const rawSnapshot = () => [localStorage.getItem(toolKey), localStorage.getItem(workflowKey), localStorage.getItem('subtitle-tools:settings'), localStorage.getItem('subtitle-tools:history')];
beforeEach(() => { localStorage.clear(); native.enabled = false; native.invoke.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('safe preset exchange', () => {
  it('imports the documented complete example as a validated four-step workflow', async () => {
    const bytes = new Uint8Array(readFileSync('docs/examples/SRTTools-Presets.json'));
    const plan = await previewPresetImport(bytes, 'skip');
    expect(plan).toMatchObject({ importCount: 1, incompatible: 0 });
    await confirmPresetImport(plan, { overwriteConfirmed: false });
    expect((await listWorkflowPresets()).presets[0].steps.map(step => step.operation)).toEqual(['remove-empty', 'clean-spaces', 'replace', 'shift']);
  });
  it('loads every legal v0.3 preset, fills safe defaults, and keeps settings/history unchanged', async () => {
    localStorage.setItem(toolKey, JSON.stringify({ schemaVersion: 1, presets: [legacy] }));
    localStorage.setItem('subtitle-tools:settings', '{ "theme" : "dark" }');
    localStorage.setItem('subtitle-tools:history', '[ { "id" : "keep" } ]');
    const before = rawSnapshot();
    expect((await listPresets('replace')).presets[0].parameters).toEqual({ ...legacy.parameters, regex: false, caseSensitive: false });
    await createWorkflowPreset({ name: '新流程', steps: [createWorkflowStep('clean-spaces')] });
    expect(localStorage.getItem(toolKey)).toBe(before[0]);
    const updated = await updatePreset('replace', legacy.id, { name: '可继续修改' });
    expect(updated.id).toBe(legacy.id);
    expect(rawSnapshot().slice(2)).toEqual(before.slice(2));
  });

  it('exports only selected clean configuration and reimports equivalent semantics with new local identities', async () => {
    const tool = await createPreset({ toolId: 'replace', name: '选中工具', parameters: { ...replacement, inputText: '秘密字幕', path: 'C:\\private' } });
    await createPreset({ toolId: 'shift', name: '不应导出', parameters: { offsetMs: 500, policy: 'reject' } });
    const workflow = await createWorkflowPreset({ name: '选中流程', description: '保留描述', lossyMode: 'normalize', steps: [createWorkflowStep('remove-empty'), createWorkflowStep('shift')] });
    expect(PRESET_PRIVACY_NOTICE).toContain('敏感文本');
    const bytes = await exportPresetSelection({ toolIds: [tool.id], workflowIds: [workflow.id] }, date);
    const json = new TextDecoder().decode(bytes);
    expect(json).not.toMatch(/秘密字幕|private|不应导出|inputText/u);
    expect(json).toContain('觉得');
    expect(json).toContain('\n  "');
    expect(await exportPresetSelection({ toolIds: [tool.id], workflowIds: [workflow.id] }, date)).toEqual(bytes);
    localStorage.clear();
    const plan = await previewPresetImport(bytes, 'skip');
    expect(plan).toMatchObject({ importCount: 2, skipCount: 0, conflicts: 0, incompatible: 0 });
    expect(localStorage.length).toBe(0);
    await expect(confirmPresetImport(plan, { overwriteConfirmed: false })).resolves.toEqual({ imported: 2, skipped: 0 });
    const savedTool = (await listPresets('replace')).presets[0];
    const savedFlow = (await listWorkflowPresets()).presets[0];
    expect(savedTool.parameters).toEqual(tool.parameters);
    expect(savedTool.id).not.toBe(tool.id);
    expect(savedFlow).toMatchObject({ name: workflow.name, description: workflow.description, lossyMode: 'normalize' });
    const withoutStepIdentity = (step: typeof workflow.steps[number]) => ({ operation: step.operation, enabled: step.enabled, params: step.params });
    expect(savedFlow.steps.map(withoutStepIdentity)).toEqual(workflow.steps.map(withoutStepIdentity));
    expect(savedFlow.steps[0].id).not.toBe(workflow.steps[0].id);
    await expect(confirmPresetImport(plan, { overwriteConfirmed: false })).rejects.toMatchObject({ code: 'stale-preview' });
  });

  it.each(['skip', 'rename', 'overwrite'] as const)('previews %s conflicts without writing and requires explicit overwrite confirmation', async strategy => {
    const preset = await createPreset({ toolId: 'replace', name: '同名', parameters: replacement });
    const content = exchange([{ kind: 'tool', ...preset, id: crypto.randomUUID(), parameters: { ...replacement, replacement: '新值' } }]);
    const before = rawSnapshot();
    const plan = await previewPresetImport(content, strategy);
    expect(rawSnapshot()).toEqual(before);
    expect(plan.conflicts).toBe(1);
    if (strategy === 'overwrite') {
      await expect(confirmPresetImport(plan, { overwriteConfirmed: false })).rejects.toMatchObject({ code: 'confirmation-required' });
      expect(rawSnapshot()).toEqual(before);
    }
    await confirmPresetImport(plan, { overwriteConfirmed: strategy === 'overwrite' });
    const result = (await listPresets('replace')).presets;
    if (strategy === 'skip') { expect(result).toEqual([preset]); expect(rawSnapshot()).toEqual(before); }
    else if (strategy === 'rename') expect(result.map(p => p.name).sort()).toEqual(['同名', '同名 (2)'].sort());
    else expect(result).toMatchObject([{ id: preset.id, parameters: { replacement: '新值' } }]);
  });

  it.each([
    ['2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z'],
    ['9999-12-31T23:59:59.998Z', '9999-12-31T23:59:59.999Z'],
  ])('keeps future-dated tool and workflow overwrites readable without advancing past %s / %s', async (createdAt, updatedAt) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(date));
    const oldTool = { ...legacy, name: '合法旧预设', parameters: replacement, createdAt, updatedAt };
    const oldFlow = { schemaVersion: 1, id: crypto.randomUUID(), name: '合法旧流程', description: '原描述',
      steps: [createWorkflowStep('remove-empty')], lossyMode: 'reject', createdAt, updatedAt };
    localStorage.setItem(toolKey, JSON.stringify({ schemaVersion: 1, presets: [oldTool] }, null, 2));
    localStorage.setItem(workflowKey, JSON.stringify({ schemaVersion: 1, presets: [oldFlow] }, null, 3));
    localStorage.setItem('subtitle-tools:settings', '{ "theme" : "dark" }');
    localStorage.setItem('subtitle-tools:history', '[ { "id" : "keep exact bytes" } ]');
    const before = rawSnapshot();
    expect(await listPresets('replace')).toMatchObject({ presets: [oldTool], ignoredCount: 0 });
    expect(await listWorkflowPresets()).toMatchObject({ presets: [oldFlow], quarantined: [], readOnly: false });
    const incomingTool = { kind: 'tool', ...oldTool, id: crypto.randomUUID(), parameters: { ...replacement, replacement: '覆盖后的参数' } };
    const incomingFlow = { kind: 'workflow', ...oldFlow, id: crypto.randomUUID(), description: '覆盖后的描述',
      steps: [{ ...createWorkflowStep('shift'), params: { offsetMs: 500, policy: 'reject' } }] };
    const plan = await previewPresetImport(exchange([incomingTool, incomingFlow]), 'overwrite');
    expect(plan).toMatchObject({ importCount: 2, conflicts: 2, incompatible: 0, requiresOverwriteConfirmation: true });
    expect(rawSnapshot()).toEqual(before);
    await expect(confirmPresetImport(plan, { overwriteConfirmed: true })).resolves.toEqual({ imported: 2, skipped: 0 });
    const toolResult = await listPresets('replace');
    const flowResult = await listWorkflowPresets();
    expect(toolResult).toMatchObject({ ignoredCount: 0, presets: [{ ...oldTool, parameters: incomingTool.parameters }] });
    expect(toolResult.presets).toHaveLength(1);
    expect(flowResult).toMatchObject({ quarantined: [], readOnly: false, presets: [{ id: oldFlow.id, name: oldFlow.name,
      description: incomingFlow.description, lossyMode: oldFlow.lossyMode, createdAt, updatedAt,
      steps: [{ operation: 'shift', enabled: true, params: { offsetMs: 500, policy: 'reject' } }] }] });
    expect(flowResult.presets).toHaveLength(1);
    expect(flowResult.presets[0].steps[0].id).not.toBe(incomingFlow.steps[0].id);
    expect(rawSnapshot().slice(2)).toEqual(before.slice(2));
    const exported = JSON.parse(new TextDecoder().decode(await exportPresetSelection({ toolIds: [oldTool.id], workflowIds: [oldFlow.id] }, date)));
    expect(exported.items).toHaveLength(2);
    expect(exported.items.every((item: { createdAt: string; updatedAt: string }) => item.createdAt === createdAt && item.updatedAt === updatedAt)).toBe(true);
  });

  it.each(['skip', 'rename'] as const)('keeps %s semantics with valid UTC-9999 presets after a clock correction', async strategy => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(date));
    const future = '9999-12-31T23:59:59.999Z';
    const oldTool = { ...legacy, parameters: replacement, createdAt: future, updatedAt: future };
    const oldFlow = { schemaVersion: 1, id: crypto.randomUUID(), name: '未来流程', description: '',
      steps: [createWorkflowStep('clean-spaces')], lossyMode: 'reject', createdAt: future, updatedAt: future };
    localStorage.setItem(toolKey, JSON.stringify({ schemaVersion: 1, presets: [oldTool] }, null, 2));
    localStorage.setItem(workflowKey, JSON.stringify({ schemaVersion: 1, presets: [oldFlow] }, null, 3));
    const before = rawSnapshot();
    const incoming = [{ kind: 'tool', ...oldTool, id: crypto.randomUUID() }, { kind: 'workflow', ...oldFlow, id: crypto.randomUUID() }];
    const plan = await previewPresetImport(exchange(incoming), strategy);
    await confirmPresetImport(plan, { overwriteConfirmed: false });
    const tools = await listPresets('replace');
    const flows = await listWorkflowPresets();
    expect(tools.ignoredCount).toBe(0); expect(flows.quarantined).toEqual([]);
    if (strategy === 'skip') {
      expect(rawSnapshot()).toEqual(before); expect(tools.presets).toEqual([oldTool]); expect(flows.presets).toEqual([oldFlow]);
    } else {
      expect(tools.presets).toHaveLength(2); expect(flows.presets).toHaveLength(2);
      expect(tools.presets.find(item => item.id === oldTool.id)).toEqual(oldTool);
      expect(flows.presets.find(item => item.id === oldFlow.id)).toEqual(oldFlow);
      expect(tools.presets.find(item => item.id !== oldTool.id)).toMatchObject({ name: `${oldTool.name} (2)`, createdAt: date, updatedAt: date });
      expect(flows.presets.find(item => item.id !== oldFlow.id)).toMatchObject({ name: `${oldFlow.name} (2)`, createdAt: date, updatedAt: date });
    }
  });

  it('uses the current clock for newly imported items instead of inheriting external future timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(date));
    const future = '9999-12-31T23:59:59.999Z';
    const tool = { kind: 'tool', ...legacy, parameters: replacement, createdAt: future, updatedAt: future };
    const flow = { kind: 'workflow', schemaVersion: 1, id: crypto.randomUUID(), name: '新流程', description: '',
      steps: [createWorkflowStep('clean-spaces')], lossyMode: 'reject', createdAt: future, updatedAt: future };
    const plan = await previewPresetImport(exchange([tool, flow]), 'overwrite');
    expect(plan.requiresOverwriteConfirmation).toBe(false);
    await confirmPresetImport(plan, { overwriteConfirmed: false });
    expect(await listPresets('replace')).toMatchObject({ ignoredCount: 0, presets: [{ name: tool.name, parameters: replacement, createdAt: date, updatedAt: date }] });
    expect(await listWorkflowPresets()).toMatchObject({ quarantined: [], presets: [{ name: flow.name, createdAt: date, updatedAt: date }] });
  });

  it('handles same-name workflow imports, regenerates external IDs and retains isolated raw rows', async () => {
    const flow = await createWorkflowPreset({ name: '流程', steps: [createWorkflowStep('clean-spaces')] });
    const broken = { ...flow, steps: 'corrupt' };
    const future = { schemaVersion: 2, newerData: ['keep'] };
    localStorage.setItem(workflowKey, JSON.stringify({ schemaVersion: 1, presets: [broken, flow, future] }));
    const plan = await previewPresetImport(exchange([{ kind: 'workflow', ...flow, description: '覆盖描述' }]), 'overwrite');
    await confirmPresetImport(plan, { overwriteConfirmed: true });
    const stored = JSON.parse(localStorage.getItem(workflowKey)!);
    expect(stored.presets[0]).toEqual(broken);
    expect(stored.presets[1].description).toBe('覆盖描述');
    expect(stored.presets[2]).toEqual(future);
  });

  it('reports incompatible kinds/operations/parameters and never executes or persists their fields', async () => {
    const tool = { kind: 'tool', ...legacy, parameters: replacement };
    const flow = await createWorkflowPreset({ name: '合法流程', steps: [createWorkflowStep('remove-empty')] });
    const items = [
      { ...tool, id: crypto.randomUUID(), kind: 'shell', command: 'run me' },
      { ...tool, id: crypto.randomUUID(), toolId: 'unknown' },
      { ...tool, id: crypto.randomUUID(), parameters: { ...replacement, path: 'C:\\secret' } },
      { ...tool, id: crypto.randomUUID(), parameters: { ...replacement, regex: true, find: '[' } },
      { kind: 'workflow', ...flow, id: crypto.randomUUID(), steps: [{ ...flow.steps[0], operation: 'eval' }] },
      { ...tool, id: crypto.randomUUID(), parameters: { find: 'missing fields' } },
      { ...tool, id: crypto.randomUUID(), schemaVersion: 2, script: 'future' },
      tool,
    ];
    const plan = await previewPresetImport(exchange(items), 'skip');
    expect(plan).toMatchObject({ incompatible: 7, importCount: 1 });
    await confirmPresetImport(plan, { overwriteConfirmed: false });
    expect((await listPresets('replace')).presets).toHaveLength(1);
    expect(localStorage.getItem(toolKey)).not.toMatch(/run me|secret|missing fields|future|script/u);
  });

  it('rejects damaged, invalid UTF-8, huge, unknown-version and duplicate-ID files without changing old bytes', async () => {
    await createPreset({ toolId: 'replace', name: '原有', parameters: replacement });
    const before = rawSnapshot();
    const duplicate = { kind: 'tool', ...legacy, parameters: replacement };
    const inputs = [new TextEncoder().encode('{broken'), new Uint8Array([0xc3, 0x28]), new Uint8Array(MAX_PRESET_IMPORT_BYTES + 1),
      exchange([], { schemaVersion: 2 }), exchange([], { executable: 'bad' }), exchange([duplicate, duplicate]), encoded({ items: [] })];
    for (const input of inputs) {
      await expect(previewPresetImport(input, 'skip')).rejects.toBeInstanceOf(Error);
      expect(rawSnapshot()).toEqual(before);
    }
  });

  it('rejects over-capacity plans instead of truncating rows, with no persistent side effects', async () => {
    for (let i = 0; i < 20; i++) await createPreset({ toolId: 'replace', name: `已有${i}`, parameters: replacement });
    const before = rawSnapshot();
    await expect(previewPresetImport(exchange([{ kind: 'tool', ...legacy, parameters: replacement }]), 'rename')).rejects.toMatchObject({ code: 'limit' });
    expect(rawSnapshot()).toEqual(before);
    localStorage.removeItem(toolKey);
    const flows = Array.from({ length: 50 }, () => ({ schemaVersion: 2, unknown: true }));
    localStorage.setItem(workflowKey, JSON.stringify({ schemaVersion: 1, presets: flows }));
    const flow = { schemaVersion: 1, id: crypto.randomUUID(), name: '新', description: '', steps: [], lossyMode: 'reject', createdAt: date, updatedAt: date };
    await expect(previewPresetImport(exchange([{ kind: 'workflow', ...flow }]), 'skip')).rejects.toMatchObject({ code: 'limit' });
    expect(localStorage.getItem(workflowKey)).toBe(JSON.stringify({ schemaVersion: 1, presets: flows }));
  });

  it('invalidates a stale preview, rejects forged plans and commits only the privately validated payload', async () => {
    const content = exchange([{ kind: 'tool', ...legacy, parameters: replacement }]);
    const plan = await previewPresetImport(content, 'skip');
    await createPreset({ toolId: 'shift', name: '并发保存', parameters: { offsetMs: 1, policy: 'reject' } });
    await expect(confirmPresetImport(plan, { overwriteConfirmed: false })).rejects.toMatchObject({ code: 'stale-preview' });
    const valid = await previewPresetImport(content, 'skip');
    await expect(confirmPresetImport({ ...valid }, { overwriteConfirmed: true })).rejects.toMatchObject({ code: 'stale-preview' });
    valid.items[0].outputName = '伪造预览'; valid.importCount = 100;
    await expect(confirmPresetImport(valid, { overwriteConfirmed: false })).resolves.toEqual({ imported: 1, skipped: 0 });
    expect((await listPresets('replace')).presets[0].name).toBe(legacy.name);
  });

  it('rolls back both keys byte-for-byte when the second browser write fails', async () => {
    localStorage.setItem(toolKey, JSON.stringify({ schemaVersion: 1, presets: [legacy] }, null, 3));
    const workflow = await createWorkflowPreset({ name: '待分享', steps: [createWorkflowStep('clean-spaces')] });
    const content = await exportPresetSelection({ toolIds: [legacy.id], workflowIds: [workflow.id] }, date);
    localStorage.removeItem(workflowKey);
    const before = rawSnapshot();
    const plan = await previewPresetImport(content, 'rename');
    const original = Storage.prototype.setItem;
    let failed = false;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === workflowKey && !failed) { failed = true; throw new Error('disk full'); }
      original.call(this, key, value);
    });
    await expect(confirmPresetImport(plan, { overwriteConfirmed: false })).rejects.toMatchObject({ code: 'storage-error' });
    write.mockRestore();
    expect(rawSnapshot()).toEqual(before);
    expect(localStorage.getItem(PRESET_TRANSACTION_KEY)).toBeNull();
  });

  it('recovers an interrupted mixed import before any tool or workflow read', async () => {
    const tools = JSON.stringify({ schemaVersion: 1, presets: [legacy] }, null, 2);
    const workflows = JSON.stringify({ schemaVersion: 1, presets: [] }, null, 3);
    localStorage.setItem(toolKey, '{"schemaVersion":1,"presets":[]}');
    localStorage.setItem(workflowKey, '{"partial":true}');
    localStorage.setItem(PRESET_TRANSACTION_KEY, JSON.stringify({ schemaVersion: 1, tools, workflows }));
    expect((await listPresets('replace')).presets[0].id).toBe(legacy.id);
    expect(localStorage.getItem(toolKey)).toBe(tools);
    expect(localStorage.getItem(workflowKey)).toBe(workflows);
    expect(localStorage.getItem(PRESET_TRANSACTION_KEY)).toBeNull();
    localStorage.setItem(PRESET_TRANSACTION_KEY, JSON.stringify({ schemaVersion: 2, tools, workflows }));
    await expect(readLocalValue(PRESET_STORAGE_KEY)).rejects.toThrow('恢复版本');
    expect(localStorage.getItem(toolKey)).toBe(tools);
  });

  it('keeps a failed recovery journal and blocks reads until original data can be restored', async () => {
    const tools = JSON.stringify({ schemaVersion: 1, presets: [legacy] });
    const workflows = JSON.stringify({ schemaVersion: 1, presets: [] });
    localStorage.setItem(toolKey, '{}'); localStorage.setItem(workflowKey, '{}');
    localStorage.setItem(PRESET_TRANSACTION_KEY, JSON.stringify({ schemaVersion: 1, tools, workflows }));
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === workflowKey) throw new Error('quota');
      original.call(this, key, value);
    });
    await expect(readLocalValue(PRESET_STORAGE_KEY)).rejects.toThrow('quota');
    expect(localStorage.getItem(PRESET_TRANSACTION_KEY)).not.toBeNull();
    write.mockRestore();
    await readLocalValue(WORKFLOW_STORAGE_KEY);
    expect(localStorage.getItem(toolKey)).toBe(tools); expect(localStorage.getItem(workflowKey)).toBe(workflows);
    expect(localStorage.getItem(PRESET_TRANSACTION_KEY)).toBeNull();
  });

  it('uses one native CAS transaction and independent JSON picker with no renderer path', async () => {
    native.enabled = true;
    const snapshot = { tools: null, workflows: null };
    native.invoke.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(undefined).mockResolvedValueOnce([123, 125]).mockResolvedValueOnce(null);
    expect(await readPresetValues()).toEqual(snapshot);
    await writePresetValues(snapshot, snapshot);
    expect(await readPresetImportFile()).toEqual(new Uint8Array([123, 125]));
    expect(await readPresetImportFile()).toBeNull();
    expect(native.invoke.mock.calls).toEqual([
      ['get_preset_values'], ['set_preset_values', { expected: snapshot, next: snapshot }], ['read_preset_import_file'], ['read_preset_import_file'],
    ]);
  });

  it('rejects oversized or non-JSON browser preset files before reading bytes', async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    await expect(readBrowserPresetFile({ name: 'large.json', size: MAX_PRESET_IMPORT_BYTES + 1, arrayBuffer: read } as unknown as File)).rejects.toThrow('1 MiB');
    await expect(readBrowserPresetFile({ name: 'source.srt', size: 0, arrayBuffer: read } as unknown as File)).rejects.toThrow('JSON');
    expect(read).not.toHaveBeenCalled();
    expect((await listExportablePresets()).tools).toEqual([]);
  });
});
