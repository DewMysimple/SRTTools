import { z } from 'zod';
import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowStep } from '../core/workflow';
import { PresetJsonParseError, readLocalValue, WORKFLOW_STORAGE_KEY, writeLocalValue } from './persistence';
import { serializePresetOperation as serialize } from './preset-queue';

export interface WorkflowPreset extends WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuarantinedWorkflow { index: number; reason: string; raw: unknown }
export interface WorkflowPresetList {
  presets: WorkflowPreset[];
  quarantined: QuarantinedWorkflow[];
  readOnly: boolean;
  warning?: string;
}
interface WorkflowStore extends WorkflowPresetList { rows: unknown[]; indices: Map<string, number> }
export interface WorkflowPresetInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  lossyMode?: WorkflowDefinition['lossyMode'];
}

export class WorkflowPresetError extends Error {
  constructor(readonly code: 'invalid-name' | 'invalid-parameters' | 'duplicate-name' | 'limit' | 'not-found' | 'read-only' | 'storage-error', message: string) {
    super(message);
    this.name = 'WorkflowPresetError';
  }
}

export const MAX_WORKFLOW_PRESETS = 50;
export const MAX_WORKFLOW_STORE_BYTES = 512 * 1024;
const metadataSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), name: z.string(), description: z.string().max(1000),
  steps: z.unknown(), lossyMode: z.enum(['reject', 'normalize']),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function nameKey(name: string): string { return name.normalize('NFC').toLowerCase(); }

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Bidi_Control}]/u.test(value)) throw new WorkflowPresetError('invalid-name', '流程名称不能包含控制字符。');
  const name = value.trim().replace(/\s+/gu, ' ').normalize('NFC');
  if (!name || name.length > 1024 || !/[^\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(name)) {
    throw new WorkflowPresetError('invalid-name', '请输入 1–40 个可见字符作为流程名称。');
  }
  const length = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)).length : Array.from(name).length;
  if (length > 40) throw new WorkflowPresetError('invalid-name', '流程名称不能超过 40 个字符。');
  return name;
}

function definition(value: Pick<WorkflowPresetInput, 'steps' | 'lossyMode'>): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse({ schemaVersion: 1, steps: value.steps, lossyMode: value.lossyMode ?? 'reject' });
  if (!parsed.success) throw new WorkflowPresetError('invalid-parameters', `流程配置无效：${parsed.error.issues[0]?.message ?? '请检查步骤与参数。'}`);
  return parsed.data;
}

function decodePreset(raw: unknown): WorkflowPreset | null {
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const value = parsed.data;
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return null;
    const config = definition({ steps: value.steps as WorkflowStep[], lossyMode: value.lossyMode });
    return { ...config, id: value.id, name: normalizeName(value.name), description: value.description,
      createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString() };
  } catch { return null; }
}

function decodeStore(raw: unknown): WorkflowStore {
  const result: WorkflowStore = { presets: [], quarantined: [], rows: [], indices: new Map(), readOnly: false };
  if (raw === null) return result;
  const envelope = record(raw);
  if (!envelope || envelope.schemaVersion !== 1 || !Array.isArray(envelope.presets)
    || Object.keys(envelope).some(key => key !== 'schemaVersion' && key !== 'presets')) {
    const warning = '本地流程格式损坏或属于未来版本，已只读隔离并保留原始数据。';
    return { ...result, readOnly: true, warning, quarantined: [{ index: -1, reason: warning, raw }] };
  }
  if (envelope.presets.length > MAX_WORKFLOW_PRESETS || bytes(raw) > MAX_WORKFLOW_STORE_BYTES) {
    const warning = '现有流程超过 50 项或 512 KiB，已只读隔离并保留原始数据。';
    return { ...result, readOnly: true, warning, quarantined: [{ index: -1, reason: warning, raw }] };
  }
  result.rows = envelope.presets.slice();
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const [index, item] of envelope.presets.entries()) {
    const preset = decodePreset(item);
    if (!preset || ids.has(preset.id.toLowerCase()) || names.has(nameKey(preset.name))) {
      result.quarantined.push({ index, raw: item, reason: '无效参数、未知操作/版本、重复名称或重复 ID；原配置保留且不会执行。' });
      if (preset) result.rows[index] = { schemaVersion: 1, quarantined: true, reason: 'conflicting-workflow-preset', raw: item };
      continue;
    }
    ids.add(preset.id.toLowerCase());
    names.add(nameKey(preset.name));
    result.presets.push(preset);
    result.indices.set(preset.id, index);
  }
  return result;
}

async function readStore(): Promise<WorkflowStore> {
  try { return decodeStore(await readLocalValue(WORKFLOW_STORAGE_KEY)); }
  catch (error) {
    if (error instanceof PresetJsonParseError) return { presets: [], rows: [], indices: new Map(), readOnly: true,
      quarantined: [{ index: -1, reason: '本地流程 JSON 损坏，原始存储未修改。', raw: null }], warning: '本地流程 JSON 损坏，已停止写入并保留原始存储。' };
    throw new WorkflowPresetError('storage-error', '无法读取本地流程，请稍后重试。');
  }
}

function assertWritable(store: WorkflowStore): void {
  if (store.readOnly) throw new WorkflowPresetError('read-only', store.warning ?? '当前流程存储已只读隔离，原始数据已保留。');
}
function ensureName(store: WorkflowStore, name: string, exceptId?: string): void {
  if (store.presets.some(p => p.id !== exceptId && nameKey(p.name) === nameKey(name))) throw new WorkflowPresetError('duplicate-name', '已有同名流程，请重命名或更新原流程。');
}
function matching(store: WorkflowStore, id: string): WorkflowPreset {
  const preset = store.presets.find(p => p.id === id);
  if (!preset) throw new WorkflowPresetError('not-found', '流程不存在或已被隔离，请重新读取。');
  return preset;
}
async function writeRows(rows: unknown[]): Promise<void> {
  const value = { schemaVersion: 1, presets: rows };
  if (rows.length > MAX_WORKFLOW_PRESETS || bytes(value) > MAX_WORKFLOW_STORE_BYTES) throw new WorkflowPresetError('limit', '本机最多保存 50 个流程、总计 512 KiB（包括隔离项目）。');
  try { await writeLocalValue(WORKFLOW_STORAGE_KEY, value); }
  catch { throw new WorkflowPresetError('storage-error', '无法保存流程，当前编辑内容已保留，请稍后重试。'); }
}

export async function listWorkflowPresets(): Promise<WorkflowPresetList> {
  return serialize(async () => {
    const { presets, quarantined, readOnly, warning } = await readStore();
    return { presets: presets.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), quarantined, readOnly, ...(warning ? { warning } : {}) };
  });
}
export async function readWorkflowPreset(id: string): Promise<WorkflowPreset> {
  return serialize(async () => matching(await readStore(), id));
}
export async function createWorkflowPreset(input: WorkflowPresetInput): Promise<WorkflowPreset> {
  const name = normalizeName(input.name);
  const config = definition(input);
  const description = z.string().max(1000).parse(input.description ?? '');
  return serialize(async () => {
    const store = await readStore(); assertWritable(store); ensureName(store, name);
    const now = new Date().toISOString();
    const preset: WorkflowPreset = { ...config, id: crypto.randomUUID(), name, description, createdAt: now, updatedAt: now };
    await writeRows([preset, ...store.rows]);
    return preset;
  });
}
export async function updateWorkflowPreset(id: string, changes: Partial<WorkflowPresetInput>): Promise<WorkflowPreset> {
  const snapshot = structuredClone(changes);
  return serialize(async () => {
    const store = await readStore(); assertWritable(store);
    const previous = matching(store, id);
    const name = normalizeName(snapshot.name ?? previous.name);
    ensureName(store, name, id);
    const config = definition({ steps: snapshot.steps ?? previous.steps, lossyMode: snapshot.lossyMode ?? previous.lossyMode });
    const description = z.string().max(1000).parse(snapshot.description ?? previous.description);
    const preset: WorkflowPreset = { ...previous, ...config, name, description,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString() };
    await writeRows(store.rows.map((row, index) => index === store.indices.get(id) ? preset : row));
    return preset;
  });
}
export async function duplicateWorkflowPreset(id: string, name: string): Promise<WorkflowPreset> {
  // Keep the read and write together, rather than composing the two public queued methods.
  return serialize(async () => {
    const store = await readStore(); assertWritable(store);
    const previous = matching(store, id);
    const normalized = normalizeName(name); ensureName(store, normalized);
    const now = new Date().toISOString();
    const preset = { ...previous, id: crypto.randomUUID(), name: normalized, createdAt: now, updatedAt: now };
    await writeRows([preset, ...store.rows]);
    return preset;
  });
}
export async function deleteWorkflowPreset(id: string): Promise<void> {
  return serialize(async () => {
    const store = await readStore(); assertWritable(store); matching(store, id);
    await writeRows(store.rows.filter((_row, index) => index !== store.indices.get(id)));
  });
}

/** Exchange shares these validators and retains every quarantined row. Queue required. */
export const workflowPresetRepository = { decodeStore, decodePreset, normalizeName, nameKey, assertWritable, ensureName };
