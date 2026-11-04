import { z } from 'zod';
import { defaultParameters, tools, validateParameters, type ToolDefinition } from '../app/tool-registry';
import { PresetJsonParseError, PRESET_STORAGE_KEY, readLocalValue, writeLocalValue } from './persistence';
import { serializePresetOperation as serialize } from './preset-queue';

export interface ToolPreset {
  id: string;
  toolId: string;
  name: string;
  parameters: Record<string, unknown>;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
}

type PresetErrorCode =
  | 'invalid-name' | 'invalid-parameters' | 'duplicate-name' | 'not-found' | 'limit'
  | 'corrupt-store' | 'unsupported-version' | 'storage-error' | 'unknown-tool';

export class PresetError extends Error {
  constructor(readonly code: PresetErrorCode, message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

export interface PresetStore {
  presets: ToolPreset[];
  futureItems: Record<string, unknown>[];
  quarantinedItems: unknown[];
  ignoredCount: number;
}

interface PresetChanges {
  name?: string;
  parameters?: Record<string, unknown>;
}

const SCHEMA_VERSION = 1;
const TOOL_LIMIT = 20;
const STORE_LIMIT = 100;
const MAX_STORE_BYTES = 256 * 1024;
const NAME_LIMIT = 40;
const metadataSchema = z.object({
  id: z.uuid(), toolId: z.string(), name: z.string(),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function hasOtherVersion(record: Record<string, unknown>): boolean {
  return Object.hasOwn(record, 'schemaVersion') && record.schemaVersion !== SCHEMA_VERSION;
}

function toolDefinition(toolId: string): ToolDefinition {
  const definition = tools.find(tool => tool.id === toolId);
  if (!definition?.parameters.length) throw new PresetError('unknown-tool', '此工具没有可保存的参数预设。');
  return definition;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new PresetError('invalid-name', '请输入预设名称。');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 1024 || /[\p{Cc}\p{Bidi_Control}]/u.test(value) || !/[^\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(name)) {
    throw new PresetError('invalid-name', '请输入 1–40 个可见字符作为预设名称，名称不能包含控制字符。');
  }
  const count = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)).length
    : Array.from(name).length;
  if (count > NAME_LIMIT) throw new PresetError('invalid-name', '预设名称不能超过 40 个字符。');
  return name;
}

function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function checkedParameters(definition: ToolDefinition, input: unknown, fillDefaults = false): Record<string, unknown> {
  const supplied = asRecord(input);
  if (!supplied) throw new PresetError('invalid-parameters', '预设参数必须是工具参数对象。');
  const parameters = fillDefaults ? defaultParameters(definition) : {};
  for (const field of definition.parameters) {
    if (Object.hasOwn(supplied, field.key)) parameters[field.key] = supplied[field.key];
  }
  const errors = validateParameters(definition, parameters);
  const invalidField = definition.parameters.find(field => errors[field.key]);
  if (invalidField) throw new PresetError('invalid-parameters', `${invalidField.label}：${errors[invalidField.key]}`);
  return parameters;
}

function decodePreset(item: Record<string, unknown>): ToolPreset | null {
  if (item.schemaVersion !== SCHEMA_VERSION) return null;
  const result = metadataSchema.safeParse(item);
  if (!result.success) return null;
  const created = Date.parse(result.data.createdAt);
  const updated = Date.parse(result.data.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) return null;
  try {
    const definition = toolDefinition(result.data.toolId);
    return {
      ...result.data, schemaVersion: SCHEMA_VERSION, name: normalizeName(result.data.name),
      parameters: checkedParameters(definition, item.parameters, true),
      createdAt: new Date(created).toISOString(), updatedAt: new Date(updated).toISOString(),
    };
  } catch (error) {
    if (error instanceof PresetError) return null;
    throw error;
  }
}

function corruptStore(): PresetError {
  return new PresetError('corrupt-store', '本地预设数据格式已损坏。可单独恢复预设存储。');
}

function sizeOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function readStore(): Promise<PresetStore> {
  let raw: unknown;
  try {
    raw = await readLocalValue(PRESET_STORAGE_KEY);
  } catch (error) {
    if (error instanceof PresetJsonParseError) throw corruptStore();
    throw new PresetError('storage-error', '无法读取本地预设。请稍后重试。');
  }
  return decodeStore(raw);
}

function decodeStore(raw: unknown): PresetStore {
  const store: PresetStore = { presets: [], futureItems: [], quarantinedItems: [], ignoredCount: 0 };
  if (raw === null) return store;
  const envelope = asRecord(raw);
  if (envelope && hasOtherVersion(envelope)) {
    throw new PresetError('unsupported-version', '当前版本无法读取此预设格式，原有数据已保留。');
  }
  if (envelope?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(envelope.presets)) throw corruptStore();
  if (envelope.presets.length > STORE_LIMIT || sizeOf(envelope) > MAX_STORE_BYTES) {
    throw new PresetError('limit', '现有预设数据超过本版本的容量限制，原有数据已保留。');
  }

  const ids = new Set<string>();
  const namesByTool = new Map<string, Set<string>>();
  for (const value of envelope.presets) {
    const item = asRecord(value);
    if (item && hasOtherVersion(item)) {
      store.futureItems.push(item);
      store.ignoredCount++;
      continue;
    }
    const preset = item && decodePreset(item);
    if (!preset) {
      store.ignoredCount++;
      store.quarantinedItems.push(value);
      continue;
    }
    const names = namesByTool.get(preset.toolId) ?? new Set<string>();
    const key = nameKey(preset.name);
    if (ids.has(preset.id.toLowerCase()) || names.has(key) || names.size >= TOOL_LIMIT) {
      store.ignoredCount++;
      // Deleting the first copy must not silently reactivate a previously conflicting row.
      store.quarantinedItems.push({ schemaVersion: 1, quarantined: true, reason: 'conflicting-tool-preset', raw: value });
      continue;
    }
    ids.add(preset.id.toLowerCase());
    names.add(key);
    namesByTool.set(preset.toolId, names);
    store.presets.push(preset);
  }
  return store;
}

/** Shared repository rules for the exchange layer; callers must hold the preset queue. */
export const toolPresetRepository = {
  decodeStore, decodePreset, normalizeName, nameKey, checkedParameters, toolDefinition,
  limits: { perTool: TOOL_LIMIT, total: STORE_LIMIT, bytes: MAX_STORE_BYTES },
};

async function writeStore(presets: ToolPreset[], preservedItems: unknown[] = []): Promise<void> {
  const value = { schemaVersion: SCHEMA_VERSION, presets: [...presets, ...preservedItems] };
  if (sizeOf(value) > MAX_STORE_BYTES) throw new PresetError('limit', '预设存储最多 256 KiB，请缩短文本参数或删除旧预设。');
  try {
    await writeLocalValue(PRESET_STORAGE_KEY, value);
  } catch {
    throw new PresetError('storage-error', '无法保存本地预设，当前参数已保留。请稍后重试。');
  }
}

function matchingPreset(store: PresetStore, toolId: string, id: string): ToolPreset {
  const preset = store.presets.find(item => item.toolId === toolId && item.id === id);
  if (!preset) throw new PresetError('not-found', '此工具的预设不存在，请重新加载预设列表。');
  return preset;
}

function checkDuplicate(presets: ToolPreset[], toolId: string, name: string, ignoreId?: string): void {
  if (presets.some(preset => preset.toolId === toolId && preset.id !== ignoreId && nameKey(preset.name) === nameKey(name))) {
    throw new PresetError('duplicate-name', '此工具已有同名预设。请更换名称或更新现有预设。');
  }
}

export async function listPresets(toolId: string): Promise<{ presets: ToolPreset[]; ignoredCount: number }> {
  toolDefinition(toolId);
  return serialize(async () => {
    const store = await readStore();
    const presets = store.presets.filter(preset => preset.toolId === toolId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { presets, ignoredCount: store.ignoredCount };
  });
}

export async function readPreset(toolId: string, id: string): Promise<ToolPreset> {
  toolDefinition(toolId);
  return serialize(async () => matchingPreset(await readStore(), toolId, id));
}

export async function createPreset(input: { toolId: string; name: string; parameters: Record<string, unknown> }): Promise<ToolPreset> {
  const { toolId } = input;
  const definition = toolDefinition(toolId);
  const name = normalizeName(input.name);
  const parameters = checkedParameters(definition, input.parameters);
  return serialize(async () => {
    const store = await readStore();
    checkDuplicate(store.presets, toolId, name);
    if (store.presets.filter(preset => preset.toolId === toolId).length >= TOOL_LIMIT) {
      throw new PresetError('limit', '每个工具最多保存 20 个预设。');
    }
    if (store.presets.length + store.futureItems.length + store.quarantinedItems.length >= STORE_LIMIT) {
      throw new PresetError('limit', '本机最多保存 100 个工具预设。');
    }
    const now = new Date().toISOString();
    const preset: ToolPreset = {
      id: crypto.randomUUID(), toolId, name, parameters, schemaVersion: SCHEMA_VERSION, createdAt: now, updatedAt: now,
    };
    await writeStore([preset, ...store.presets], [...store.futureItems, ...store.quarantinedItems]);
    return preset;
  });
}

export async function updatePreset(toolId: string, id: string, changes: PresetChanges): Promise<ToolPreset> {
  const definition = toolDefinition(toolId);
  const name = changes.name === undefined ? undefined : normalizeName(changes.name);
  const parameters = changes.parameters === undefined ? undefined : checkedParameters(definition, changes.parameters);
  return serialize(async () => {
    const store = await readStore();
    const previous = matchingPreset(store, toolId, id);
    const preset: ToolPreset = {
      ...previous, name: name ?? previous.name, parameters: parameters ?? previous.parameters,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString(),
    };
    checkDuplicate(store.presets, toolId, preset.name, id);
    await writeStore(store.presets.map(item => item.id === id ? preset : item), [...store.futureItems, ...store.quarantinedItems]);
    return preset;
  });
}

export async function deletePreset(toolId: string, id: string): Promise<void> {
  toolDefinition(toolId);
  return serialize(async () => {
    const store = await readStore();
    matchingPreset(store, toolId, id);
    await writeStore(store.presets.filter(item => item.id !== id), [...store.futureItems, ...store.quarantinedItems]);
  });
}

/** Re-check at confirmation time so a read error or a newer store never authorizes resetting it. */
export async function recoverPresetStore(): Promise<void> {
  return serialize(async () => {
    try {
      await readStore();
    } catch (error) {
      if (!(error instanceof PresetError) || error.code !== 'corrupt-store') throw error;
      await writeStore([]);
      return;
    }
    throw new PresetError('storage-error', '预设存储目前可读取，无需清理。');
  });
}
