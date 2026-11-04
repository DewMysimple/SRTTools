import { z } from 'zod';
import { version as appVersion } from '../../package.json';
import { readPresetValues, writePresetValues, type PresetValues } from './persistence';
import { serializePresetOperation as serialize } from './preset-queue';
import { toolPresetRepository, type ToolPreset } from './preset-service';
import { workflowPresetRepository, MAX_WORKFLOW_PRESETS, MAX_WORKFLOW_STORE_BYTES, type WorkflowPreset } from './workflow-preset-service';

export const MAX_PRESET_IMPORT_BYTES = 1024 * 1024;
export const PRESET_PRIVACY_NOTICE = '查找/替换内容、关键词等个人输入参数可能包含敏感文本，将包含在预设文件中。';
export type PresetConflictStrategy = 'skip' | 'rename' | 'overwrite';
export type PresetExchangeItem = ({ kind: 'tool' } & ToolPreset) | ({ kind: 'workflow' } & WorkflowPreset);
export interface ExportSelection { toolIds: string[]; workflowIds: string[] }
export interface PresetImportRow {
  index: number;
  kind: 'tool' | 'workflow' | 'unknown';
  name: string;
  status: 'import' | 'skip' | 'incompatible';
  conflict: boolean;
  outputName?: string;
  reason?: string;
}
export interface PresetImportPlan {
  strategy: PresetConflictStrategy;
  items: PresetImportRow[];
  importCount: number;
  skipCount: number;
  conflicts: number;
  incompatible: number;
  requiresOverwriteConfirmation: boolean;
}
interface InternalPlan { snapshot: PresetValues; next: PresetValues; imported: number; skipped: number; overwrite: boolean }
const plans = new WeakMap<PresetImportPlan, InternalPlan>();

export class PresetExchangeError extends Error {
  constructor(readonly code: 'invalid-json' | 'unsupported-version' | 'limit' | 'invalid-selection' | 'stale-preview' | 'confirmation-required' | 'storage-error', message: string) {
    super(message); this.name = 'PresetExchangeError';
  }
}
const stamp = z.iso.datetime({ offset: true });
const toolItemSchema = z.object({
  kind: z.literal('tool'), schemaVersion: z.literal(1), id: z.uuid(), toolId: z.string(), name: z.string(),
  parameters: z.record(z.string(), z.unknown()), createdAt: stamp, updatedAt: stamp,
}).strict();
const envelopeSchema = z.object({
  format: z.literal('srttools-presets'), schemaVersion: z.literal(1), exportedAt: stamp,
  appVersion: z.string().min(1).max(40), items: z.array(z.unknown()).max(150),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function byteSize(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  const item = record(value);
  return item ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : value;
}
function fail(code: ConstructorParameters<typeof PresetExchangeError>[0], message: string): never { throw new PresetExchangeError(code, message); }

function parseItem(value: unknown): PresetExchangeItem {
  const raw = record(value);
  if (raw?.kind === 'tool') {
    const parsed = toolItemSchema.safeParse(raw);
    if (!parsed.success) throw new Error('工具预设结构、ID 或版本无效。');
    const { kind, ...item } = parsed.data;
    const definition = toolPresetRepository.toolDefinition(item.toolId);
    const declared = new Set(definition.parameters.map(p => p.key));
    if (Object.keys(item.parameters).some(key => !declared.has(key))) throw new Error('预设含未声明的参数或路径/代码字段。');
    // Do not fill missing fields on external imports. Legacy Store loading still fills safe defaults.
    toolPresetRepository.checkedParameters(definition, item.parameters);
    const preset = toolPresetRepository.decodePreset(item);
    if (!preset) throw new Error('工具预设参数或日期无效。');
    return { kind, ...preset };
  }
  if (raw?.kind === 'workflow') {
    const { kind, ...item } = raw;
    const preset = workflowPresetRepository.decodePreset(item);
    if (!preset) throw new Error('流程含未知操作、版本、字段或无效参数。');
    return { kind, ...preset };
  }
  throw new Error('不支持的预设 kind，已隔离且不会执行。');
}

async function loadSnapshot(): Promise<PresetValues> {
  try { return await readPresetValues(); }
  catch { return fail('storage-error', '无法读取预设快照，原存储未修改。请先恢复可读状态。'); }
}
function repositories(snapshot: PresetValues) {
  const tools = toolPresetRepository.decodeStore(snapshot.tools);
  const workflows = workflowPresetRepository.decodeStore(snapshot.workflows);
  return { tools, workflows };
}

export async function listExportablePresets(): Promise<{ tools: ToolPreset[]; workflows: WorkflowPreset[]; warnings: string[] }> {
  return serialize(async () => {
    const { tools, workflows } = repositories(await loadSnapshot());
    return { tools: tools.presets, workflows: workflows.presets, warnings: [
      ...(tools.ignoredCount ? [`${tools.ignoredCount} 个无效或未来工具预设未列入可导出项目。`] : []),
      ...(workflows.quarantined.length ? [`${workflows.quarantined.length} 个流程隔离项目未列入可导出项目。`] : []),
      ...(workflows.warning ? [workflows.warning] : []),
    ] };
  });
}

export async function exportPresetSelection(selection: ExportSelection, exportedAt = new Date().toISOString()): Promise<Uint8Array> {
  const toolIds = new Set(selection.toolIds);
  const workflowIds = new Set(selection.workflowIds);
  if (toolIds.size !== selection.toolIds.length || workflowIds.size !== selection.workflowIds.length || !toolIds.size && !workflowIds.size) {
    return fail('invalid-selection', '请明确选择至少一个预设，且不能重复选择。');
  }
  if (!stamp.safeParse(exportedAt).success) return fail('invalid-selection', '导出时间格式无效。');
  return serialize(async () => {
    const { tools, workflows } = repositories(await loadSnapshot());
    const selectedTools = tools.presets.filter(p => toolIds.has(p.id));
    const selectedWorkflows = workflows.presets.filter(p => workflowIds.has(p.id));
    if (selectedTools.length !== toolIds.size || selectedWorkflows.length !== workflowIds.size) return fail('invalid-selection', '部分所选预设已改变或不可用，请重新选择。');
    const items: PresetExchangeItem[] = [
      ...selectedTools.map(p => ({ kind: 'tool' as const, ...p })),
      ...selectedWorkflows.map(p => ({ kind: 'workflow' as const, ...p })),
    ];
    // Revalidate and pick only schema-declared fields. User replacement text remains intentionally included.
    const safe = items.map(parseItem).sort((a, b) => {
      const left = `${a.kind}\0${a.kind === 'tool' ? a.toolId : ''}\0${a.name}\0${a.id}`;
      const right = `${b.kind}\0${b.kind === 'tool' ? b.toolId : ''}\0${b.name}\0${b.id}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const result = new TextEncoder().encode(`${JSON.stringify(ordered({ format: 'srttools-presets', schemaVersion: 1,
      exportedAt, appVersion, items: safe }), null, 2)}\n`);
    if (result.byteLength > MAX_PRESET_IMPORT_BYTES) return fail('limit', '所选预设 JSON 超过 1 MiB，请分批导出。');
    return result;
  });
}

function decodeFile(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_PRESET_IMPORT_BYTES) return fail('limit', '预设文件最多 1 MiB，请分批导入。');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return fail('invalid-json', '文件不是有效的 UTF-8 JSON，原有预设未修改。'); }
  const envelope = record(raw);
  if (envelope?.format === 'srttools-presets' && envelope.schemaVersion !== 1) return fail('unsupported-version', '此预设来自未来或不支持的版本，已停止导入；请保留原文件。');
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return fail('invalid-json', `预设交换文件结构无效：${parsed.error.issues[0]?.message ?? '请检查格式。'}`);
  const ids = new Set<string>();
  for (const value of parsed.data.items) {
    const id = record(value)?.id;
    if (typeof id === 'string') {
      if (ids.has(id.toLowerCase())) return fail('invalid-json', '交换文件含重复 ID，请核对后重新导入。');
      ids.add(id.toLowerCase());
    }
  }
  return parsed.data;
}

function renamed(base: string, occupied: Set<string>, key: (s: string) => string): string {
  for (let index = 2; index <= 1000; index++) {
    const suffix = ` (${index})`;
    const candidate = `${Array.from(base).slice(0, 40 - suffix.length).join('')}${suffix}`;
    if (!occupied.has(key(candidate))) return candidate;
  }
  return fail('limit', '无法生成不重名的名称，请先整理已有预设。');
}

export async function previewPresetImport(bytes: Uint8Array, strategy: PresetConflictStrategy): Promise<PresetImportPlan> {
  if (!['skip', 'rename', 'overwrite'].includes(strategy)) return fail('invalid-json', '请选择受支持的同名冲突策略。');
  const file = decodeFile(bytes);
  return serialize(async () => {
    const snapshot = await loadSnapshot();
    const stores = repositories(snapshot);
    workflowPresetRepository.assertWritable(stores.workflows);
    // Preserve every original raw row, including future or damaged entries, when importing other valid rows.
    const originalTools = record(snapshot.tools)?.presets;
    const toolRows: unknown[] = Array.isArray(originalTools) ? structuredClone(originalTools) : [];
    const workflowRows = structuredClone(stores.workflows.rows);
    const toolPresets = [...stores.tools.presets];
    const workflowPresets = [...stores.workflows.presets];
    const toolIndices = new Map(toolPresets.map(preset => [preset.id,
      toolRows.findIndex(row => { const raw = record(row); return raw && toolPresetRepository.decodePreset(raw)?.id === preset.id; })]));
    toolRows.forEach((row, index) => {
      const raw = record(row);
      const decoded = raw && toolPresetRepository.decodePreset(raw);
      if (decoded && toolIndices.get(decoded.id) !== index) {
        toolRows[index] = { schemaVersion: 1, quarantined: true, reason: 'conflicting-tool-preset', raw: row };
      }
    });
    const workflowIndices = new Map(stores.workflows.indices);
    const rows: PresetImportRow[] = [];
    let overwritten = false;
    const now = new Date().toISOString();
    for (const [index, value] of file.items.entries()) {
      let item: PresetExchangeItem;
      try { item = parseItem(value); }
      catch (error) {
        const raw = record(value);
        rows.push({ index, kind: raw?.kind === 'tool' || raw?.kind === 'workflow' ? raw.kind : 'unknown',
          name: typeof raw?.name === 'string' ? raw.name.slice(0, 160) : `项目 ${index + 1}`, status: 'incompatible', conflict: false,
          reason: error instanceof Error ? error.message : '预设无效。' });
        continue;
      }
      const kind = item.kind;
      const existing = kind === 'tool'
        ? toolPresets.find(p => p.toolId === item.toolId && toolPresetRepository.nameKey(p.name) === toolPresetRepository.nameKey(item.name))
        : workflowPresets.find(p => workflowPresetRepository.nameKey(p.name) === workflowPresetRepository.nameKey(item.name));
      const conflict = Boolean(existing);
      if (conflict && strategy === 'skip') {
        rows.push({ index, kind, name: item.name, status: 'skip', conflict, reason: '保留已有同名预设。' });
        continue;
      }
      let name = item.name;
      if (conflict && strategy === 'rename') {
        const occupied = kind === 'tool' ? toolPresets.filter(p => p.toolId === item.toolId).map(p => p.name) : workflowPresets.map(p => p.name);
        const key = kind === 'tool' ? toolPresetRepository.nameKey : workflowPresetRepository.nameKey;
        name = renamed(item.name, new Set(occupied.map(key)), key);
      }
      const replace = conflict && strategy === 'overwrite';
      overwritten ||= replace;
      const { kind: _kind, ...source } = item;
      void _kind;
      const local = { ...source, id: replace ? existing!.id : crypto.randomUUID(), name,
        createdAt: replace ? existing!.createdAt : now, updatedAt: now };
      if (kind === 'tool') {
        const preset = local as ToolPreset;
        if (replace) {
          const position = toolIndices.get(existing!.id)!;
          toolRows[position] = preset;
          toolPresets.splice(toolPresets.findIndex(p => p.id === existing!.id), 1, preset);
        } else { toolIndices.set(preset.id, toolRows.length); toolRows.push(preset); toolPresets.push(preset); }
      } else {
        const preset = local as WorkflowPreset;
        // All external IDs, including step IDs, are untrusted identities and become local snapshots.
        preset.steps = preset.steps.map(step => ({ ...step, id: crypto.randomUUID() }));
        if (replace) {
          const position = workflowIndices.get(existing!.id)!;
          workflowRows[position] = preset;
          workflowPresets.splice(workflowPresets.findIndex(p => p.id === existing!.id), 1, preset);
        } else { workflowIndices.set(preset.id, workflowRows.length); workflowRows.push(preset); workflowPresets.push(preset); }
      }
      rows.push({ index, kind, name: item.name, outputName: name, status: 'import', conflict });
    }
    if (toolRows.length > toolPresetRepository.limits.total || toolPresets.some(p => toolPresets.filter(other => other.toolId === p.toolId).length > toolPresetRepository.limits.perTool)) {
      return fail('limit', '工具预设超过每工具 20 项或全局 100 项；请分批导入或选择覆盖。');
    }
    if (workflowRows.length > MAX_WORKFLOW_PRESETS) return fail('limit', '本机最多保存 50 个流程（含隔离项目），请先整理或选择覆盖。');
    const importCount = rows.filter(row => row.status === 'import').length;
    const next: PresetValues = {
      tools: toolRows.length || snapshot.tools !== null ? { schemaVersion: 1, presets: toolRows } : null,
      workflows: workflowRows.length || snapshot.workflows !== null ? { schemaVersion: 1, presets: workflowRows } : null,
    };
    if (byteSize(next.tools) > toolPresetRepository.limits.bytes || byteSize(next.workflows) > MAX_WORKFLOW_STORE_BYTES) return fail('limit', '导入后将超过工具 256 KiB 或流程 512 KiB 容量，未修改存储。');
    const plan: PresetImportPlan = {
      strategy, items: rows, importCount, skipCount: rows.filter(row => row.status === 'skip').length,
      conflicts: rows.filter(row => row.conflict).length, incompatible: rows.filter(row => row.status === 'incompatible').length,
      requiresOverwriteConfirmation: overwritten,
    };
    // The commit payload is inaccessible to JSON/untrusted callers; mutating UI preview rows cannot change it.
    plans.set(plan, { snapshot, next, imported: importCount, skipped: plan.skipCount, overwrite: overwritten });
    return plan;
  });
}

export async function confirmPresetImport(plan: PresetImportPlan, options: { overwriteConfirmed: boolean }): Promise<{ imported: number; skipped: number }> {
  const internal = plans.get(plan);
  if (!internal) return fail('stale-preview', '导入预览不存在或已使用，请重新读取文件并预览。');
  if (internal.overwrite && options.overwriteConfirmed !== true) return fail('confirmation-required', '覆盖同名预设前需要明确确认。');
  return serialize(async () => {
    const current = await loadSnapshot();
    if (JSON.stringify(current) !== JSON.stringify(internal.snapshot)) return fail('stale-preview', '预设已在预览后改变，请重新预览导入。');
    try {
      if (internal.imported) await writePresetValues(internal.snapshot, internal.next);
    } catch { return fail('storage-error', '预设导入未完成，原有配置已保留或等待事务恢复。请重新读取后重试。'); }
    plans.delete(plan);
    return { imported: internal.imported, skipped: internal.skipped };
  });
}
