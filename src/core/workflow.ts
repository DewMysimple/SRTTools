import { z } from 'zod';
import { createId, SubtitleError, type ParseDiagnostic, type SubtitleDocument, type SubtitleFormat } from './models';
import { defaultOperationParameters, getOperationDefinition, operationParametersSchema, workflowOperationIds, type OperationEffects, type WorkflowOperationId } from './operation-registry';
import { processDocument } from './process';
import { convertChineseText } from './chinese';

export { type WorkflowOperationId } from './operation-registry';
export const MAX_WORKFLOW_STEPS = 20;
export const MAX_WORKFLOW_BYTES = 512 * 1024;

export interface WorkflowStep {
  id: string;
  operation: WorkflowOperationId;
  enabled: boolean;
  params: Record<string, unknown>;
}
export interface WorkflowDefinition {
  schemaVersion: 1;
  steps: WorkflowStep[];
  lossyMode: 'reject' | 'normalize';
}

export const workflowStepSchema = z.strictObject({
  id: z.uuid(), operation: z.enum(workflowOperationIds), enabled: z.boolean(), params: z.record(z.string(), z.unknown()),
}).superRefine((step, context) => {
  const parsed = operationParametersSchema(step.operation).safeParse(step.params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: ['params', ...issue.path], message: issue.message });
  }
});
export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1), steps: z.array(workflowStepSchema).max(MAX_WORKFLOW_STEPS), lossyMode: z.enum(['reject', 'normalize']),
}).superRefine((workflow, context) => {
  const seen = new Set<string>();
  workflow.steps.forEach((step, index) => {
    const key = step.id.toLowerCase();
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: '同一流程的步骤 ID 不能重复。' });
    seen.add(key);
  });
  let size = Infinity;
  try { size = new TextEncoder().encode(JSON.stringify(workflow)).byteLength; }
  catch { context.addIssue({ code: 'custom', message: '流程配置必须是可序列化的纯 JSON。' }); }
  if (size > MAX_WORKFLOW_BYTES) {
    context.addIssue({ code: 'custom', message: '流程配置不能超过 512 KiB，请缩短文本参数。' });
  }
});

export interface WorkflowIssue extends ParseDiagnostic { stepId?: string; stepIndex?: number }
export interface WorkflowFileAnalysis {
  id: string; name: string; applicable: boolean; outputFormat?: SubtitleFormat;
  layout: 'source' | 'normalized'; warnings: string[]; reason?: string;
}
export interface WorkflowAnalysis {
  valid: boolean; executable: boolean; enabledStepCount: number; effects: OperationEffects;
  issues: WorkflowIssue[]; files: WorkflowFileAnalysis[];
}
export interface WorkflowStepSummary {
  stepId: string; operation: WorkflowOperationId; stepIndex: number; status: 'success' | 'skipped' | 'failed';
  changedCount: number; removedCount: number; warningCount: number; summary: string; diagnostics: ParseDiagnostic[];
}
export interface WorkflowStepProgress {
  stepId: string; operation: WorkflowOperationId; stepIndex: number; totalSteps: number;
  status: 'processing' | 'success' | 'skipped'; summary?: WorkflowStepSummary;
}
export interface WorkflowExecutionContext {
  signal?: AbortSignal; onStepProgress?: (progress: WorkflowStepProgress) => void;
}
export interface WorkflowExecutionResult { document: SubtitleDocument; diagnostics: ParseDiagnostic[]; stepSummaries: WorkflowStepSummary[] }

export class WorkflowExecutionError extends SubtitleError {
  constructor(code: string, message: string, readonly stepSummaries: WorkflowStepSummary[], readonly diagnostics: ParseDiagnostic[]) {
    super(code, message);
    this.name = 'WorkflowExecutionError';
  }
}

export function createWorkflowStep(operation: WorkflowOperationId): WorkflowStep {
  return { id: createId(), operation, enabled: true, params: defaultOperationParameters(operation) };
}

export function analyzeWorkflow(value: unknown, files: readonly { id: string; name: string; error?: string }[] = []): WorkflowAnalysis {
  const parsed = workflowDefinitionSchema.safeParse(value);
  const effects: OperationEffects = { text: false, time: false, index: false, count: false };
  const issues: WorkflowIssue[] = [];
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map(issue => ({ severity: 'error' as const, code: 'INVALID_WORKFLOW', message: issue.message,
      ...(issue.path[0] === 'steps' && typeof issue.path[1] === 'number' ? { stepIndex: issue.path[1] } : {}),
    })));
    return { valid: false, executable: false, enabledStepCount: 0, effects, issues, files: files.map(file => ({ ...file, applicable: false, layout: 'normalized', warnings: [], reason: '流程配置无效。' })) };
  }
  const definition = parsed.data;
  const enabled = definition.steps.filter(step => step.enabled);
  if (!enabled.length) issues.push({ severity: 'error', code: 'EMPTY_WORKFLOW', message: '请添加并启用至少一个处理步骤。' });
  for (const step of enabled) {
    const metadata = getOperationDefinition(step.operation)!;
    for (const key of Object.keys(effects) as (keyof OperationEffects)[]) effects[key] ||= metadata.effects[key];
    if (step.operation === 'shift' && step.params.policy !== 'drop') {
      // Count changes remain possible if another enabled operation can remove cues.
      effects.count = enabled.some(item => item.operation === 'remove-empty' || item.operation === 'shift' && item.params.policy === 'drop');
    }
  }
  const sourceLayout = enabled.length > 0 && enabled.every(step => step.operation === 'chinese');
  const analysisFiles = files.map((file): WorkflowFileAnalysis => {
    const extension = file.name.split('.').at(-1)?.toLowerCase() as SubtitleFormat;
    const layout = sourceLayout ? 'source' : 'normalized';
    const warnings: string[] = [];
    if (file.error) return { id: file.id, name: file.name, applicable: false, layout, warnings, reason: file.error };
    if (!['srt', 'vtt', 'ass', 'ssa', 'csv', 'txt'].includes(extension)) return { id: file.id, name: file.name, applicable: false, layout, warnings, reason: '不支持此输入格式。' };
    if (!sourceLayout && ['vtt', 'ass', 'ssa'].includes(extension)) {
      if (definition.lossyMode !== 'normalize') return { id: file.id, name: file.name, applicable: false, layout, warnings, reason: '此流程会改变原文布局。ASS、SSA、VTT 组合步骤需明确同意规范化为 SRT，或仅使用简繁转换。' };
      warnings.push(`${extension.toUpperCase()} 将规范化为 SRT，字体、位置、样式、控制标记和 cue 设置可能丢失。`);
    }
    const outputFormat = !sourceLayout && ['vtt', 'ass', 'ssa', 'txt'].includes(extension) ? 'srt' : extension;
    if (!sourceLayout) warnings.push('输出按统一格式序列化，编号会连续递增；最终预览展示实际输出编号。');
    return { id: file.id, name: file.name, applicable: enabled.length > 0, layout, outputFormat, warnings,
      ...(!enabled.length ? { reason: '没有启用的步骤。' } : {}) };
  });
  return { valid: true, executable: enabled.length > 0 && (!files.length || analysisFiles.some(file => file.applicable)), enabledStepCount: enabled.length, effects, issues, files: analysisFiles };
}

function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('处理流程已取消。', 'AbortError');
}

/** Execute only in-memory document transforms. Serialization and encoding happen once in the worker. */
export function executeWorkflow(input: SubtitleDocument, value: WorkflowDefinition, context: WorkflowExecutionContext = {}): WorkflowExecutionResult {
  const definition = workflowDefinitionSchema.parse(value);
  const analysis = analyzeWorkflow(definition, [{ id: input.id, name: input.fileName }]);
  if (!analysis.executable || !analysis.files[0]?.applicable) throw new SubtitleError('INCOMPATIBLE_WORKFLOW', analysis.files[0]?.reason ?? analysis.issues[0]?.message ?? '此流程不能执行。');
  let document = input;
  const stepSummaries: WorkflowStepSummary[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  for (let stepIndex = 0; stepIndex < definition.steps.length; stepIndex++) {
    active(context.signal);
    const step = definition.steps[stepIndex];
    const base = { stepId: step.id, operation: step.operation, stepIndex, totalSteps: definition.steps.length };
    if (!step.enabled) {
      const summary: WorkflowStepSummary = { ...base, status: 'skipped', changedCount: 0, removedCount: 0, warningCount: 0, summary: '此步骤已禁用，未执行。', diagnostics: [] };
      stepSummaries.push(summary);
      context.onStepProgress?.({ ...base, status: 'skipped', summary });
      continue;
    }
    context.onStepProgress?.({ ...base, status: 'processing' });
    active(context.signal);
    try {
      const before = document;
      const result = step.operation === 'chinese'
        ? { documents: [{ ...document, modified: true, cues: document.cues.map(cue => {
          active(context.signal);
          return { ...cue, text: convertChineseText(cue.text, step.params.direction as 's2t' | 't2s') };
        }) }], diagnostics: [] as ParseDiagnostic[] }
        : processDocument(document, step.operation, step.params);
      active(context.signal);
      document = result.documents[0];
      const afterIds = new Set(document.cues.map(cue => cue.id));
      const previous = new Map(before.cues.map(cue => [cue.id, cue]));
      const removedCount = before.cues.filter(cue => !afterIds.has(cue.id)).length;
      const changedCount = removedCount + document.cues.filter(cue => {
        const original = previous.get(cue.id);
        return !original || original.text !== cue.text || original.index !== cue.index || original.startMs !== cue.startMs || original.endMs !== cue.endMs;
      }).length;
      const stepDiagnostics = result.diagnostics.map(diagnostic => ({ ...diagnostic, stepId: step.id, stepIndex, operation: step.operation }));
      diagnostics.push(...stepDiagnostics);
      const summary: WorkflowStepSummary = { ...base, status: 'success', changedCount, removedCount,
        warningCount: stepDiagnostics.filter(item => item.severity === 'warning').length,
        summary: `完成：${changedCount} 条发生变化${removedCount ? `，其中删除 ${removedCount} 条` : ''}。`, diagnostics: stepDiagnostics };
      stepSummaries.push(summary);
      context.onStepProgress?.({ ...base, status: 'success', summary });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const code = error instanceof SubtitleError ? error.code : 'WORKFLOW_STEP_FAILED';
      const message = error instanceof Error ? error.message : '步骤处理失败。';
      const diagnostic: ParseDiagnostic = { severity: 'error', code, message, stepId: step.id, stepIndex, operation: step.operation };
      diagnostics.push(diagnostic);
      stepSummaries.push({ ...base, status: 'failed', changedCount: 0, removedCount: 0, warningCount: 0, summary: message, diagnostics: [diagnostic] });
      throw new WorkflowExecutionError(code, `第 ${stepIndex + 1} 步（${getOperationDefinition(step.operation)!.name}）：${message}`, stepSummaries, diagnostics);
    }
  }
  active(context.signal);
  return { document, diagnostics, stepSummaries };
}
