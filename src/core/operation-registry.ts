import { z } from 'zod';

export interface Parameter {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'checkbox';
  default: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  min?: number;
  max?: number;
}

export interface OperationEffects { text: boolean; time: boolean; index: boolean; count: boolean }
interface OperationMetadata {
  name: string;
  description: string;
  category: string;
  parameters: Parameter[];
  note: string;
  effects: OperationEffects;
}

const select = (key: string, label: string, choices: [string, string][], initial?: string): Parameter => ({
  key, label, type: 'select', default: initial ?? choices[0][0], options: choices.map(([value, label]) => ({ value, label })),
});
const textOnly: OperationEffects = { text: true, time: false, index: false, count: false };
const bodyNote = '仅处理字幕正文，保留原始时间和条目顺序。';

/** Icon-free metadata is shared by tools, workflows, parameter validation and persisted configuration. */
const definitions = {
  'remove-empty': {
    name: '删除空白字幕', description: '清除只包含空格、空行或不可见字符的条目', category: '文本处理', parameters: [],
    note: bodyNote, effects: { text: false, time: false, index: false, count: true },
  },
  'clean-spaces': {
    name: '空格清理', description: '清理行首行尾空格，合并连续空格', category: '文本处理', parameters: [],
    note: bodyNote, effects: textOnly,
  },
  replace: {
    name: '查找和替换', description: '批量替换字幕中的文字，支持正则表达式', category: '文本处理',
    parameters: [
      { key: 'find', label: '查找内容', type: 'text', default: '' },
      { key: 'replacement', label: '替换为', type: 'text', default: '', help: '留空可删除匹配文字；普通文本模式按字面替换。' },
      { key: 'caseSensitive', label: '区分大小写', type: 'checkbox', default: false },
      { key: 'regex', label: '使用正则表达式（高级）', type: 'checkbox', default: false },
    ], note: bodyNote, effects: textOnly,
  },
  chinese: {
    name: '简繁转换', description: '在本机按词组转换简体或繁体字幕正文', category: '文本处理',
    parameters: [select('direction', '转换方向', [['s2t', '简体 → 繁体（通用）'], ['t2s', '繁体 → 简体']])],
    note: '这是字词转换，不等同于翻译；专有名词与歧义词建议人工核对。保留原编号、时间、换行和格式标记。', effects: textOnly,
  },
  wrap: {
    name: '自动换行', description: '按每行字符数重新排列字幕文本', category: '文本处理',
    parameters: [{ key: 'maxChars', label: '每行最多字符', type: 'number', default: 24, min: 1, max: 10_000 }],
    note: '按 Unicode 字符计数并优先在空格断行；请人工复核语义分句。', effects: textOnly,
  },
  'strip-html': {
    name: 'HTML 清理', description: '移除正文标签并还原常见 HTML 实体', category: '文本处理', parameters: [],
    note: '会移除正文中的 HTML 标签并还原常见实体，可能改变文本；保留时间和条目顺序。', effects: textOnly,
  },
  shift: {
    name: '整体时间偏移', description: '让全部字幕提前或延后指定时间', category: '时间处理',
    parameters: [
      { key: 'offsetMs', label: '偏移量（毫秒）', type: 'number', default: 1000 },
      select('policy', '偏移后出现无效时间', [['reject', '停止处理，保留输入'], ['clamp', '负时间裁到零（空区间仍报错）'], ['drop', '删除无效时间条目']]),
    ], note: '正数表示延后，负数表示提前。默认遇到无效时间即停止；裁剪或删除需要你明确选择。',
    effects: { text: false, time: true, index: false, count: true },
  },
  renumber: {
    name: '重新编号', description: '从 1 开始为字幕连续编号', category: '检测与修复', parameters: [],
    note: '只更改编号，保留正文和时间。', effects: { text: false, time: false, index: true, count: false },
  },
} satisfies Record<string, OperationMetadata>;

export type WorkflowOperationId = keyof typeof definitions;
export interface WorkflowOperationDefinition extends OperationMetadata { id: WorkflowOperationId }
export const workflowOperationIds = Object.keys(definitions) as [WorkflowOperationId, ...WorkflowOperationId[]];
export const workflowOperations: WorkflowOperationDefinition[] = workflowOperationIds.map(id => ({ id, ...definitions[id] }));

export function getOperationDefinition(id: string): WorkflowOperationDefinition | undefined {
  return workflowOperations.find(operation => operation.id === id);
}

export function defaultOperationParameters(id: WorkflowOperationId): Record<string, unknown> {
  return Object.fromEntries(definitions[id].parameters.map(parameter => [parameter.key, parameter.default]));
}

export interface ParameterDefinition { id: string; parameters: Parameter[] }

/** The same field constraints and cross-field checks serve legacy tools and workflow steps. */
export function parametersSchema(definition: ParameterDefinition, strict = true) {
  const shape: Record<string, z.ZodType> = {};
  for (const parameter of definition.parameters) {
    if (parameter.type === 'number') {
      shape[parameter.key] = z.number().int().min(parameter.min ?? Number.MIN_SAFE_INTEGER).max(parameter.max ?? Number.MAX_SAFE_INTEGER);
    } else if (parameter.type === 'checkbox') shape[parameter.key] = z.boolean();
    else if (parameter.type === 'select') {
      const choices = parameter.options?.map(option => option.value) ?? [];
      shape[parameter.key] = z.string().refine(value => choices.includes(value), '请选择受支持的选项。');
    } else shape[parameter.key] = z.string();
  }
  const schema = strict ? z.strictObject(shape) : z.object(shape);
  return schema.superRefine((values, context) => {
    if (definition.id === 'replace') {
      if (!values.find) context.addIssue({ code: 'custom', path: ['find'], message: '请输入要查找的内容。' });
      if (values.regex && typeof values.find === 'string') {
        try { new RegExp(values.find, values.caseSensitive ? 'gu' : 'giu'); }
        catch { context.addIssue({ code: 'custom', path: ['find'], message: '正则表达式无效，请检查括号或转义符。' }); }
      }
    }
    if (definition.id === 'crop' && typeof values.endMs === 'number' && typeof values.startMs === 'number' && values.endMs <= values.startMs) {
      context.addIssue({ code: 'custom', path: ['endMs'], message: '结束时间必须大于开始时间。' });
    }
  });
}

const operationSchemas = new Map(workflowOperations.map(definition => [definition.id, parametersSchema(definition)]));
export function operationParametersSchema(id: WorkflowOperationId) {
  return operationSchemas.get(id)!;
}

export function validateParameterValues(definition: ParameterDefinition, params: Record<string, unknown>): Record<string, string> {
  const result = parametersSchema(definition, false).safeParse(params);
  if (result.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '_form');
    const field = definition.parameters.find(parameter => parameter.key === key);
    if (issue.code === 'custom') errors[key] = issue.message;
    else if (field?.type === 'number') {
      errors[key] = field.min !== undefined && field.max !== undefined ? `请输入 ${field.min}–${field.max} 范围内的整数。`
        : field.min !== undefined ? `请输入不小于 ${field.min} 的整数。` : '请输入有效整数。';
    } else errors[key] = field?.type === 'select' ? '请选择受支持的选项。' : '请检查此项。';
  }
  return errors;
}
