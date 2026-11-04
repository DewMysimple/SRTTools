import type { LucideIcon } from 'lucide-react';
import { Replace, Eraser, Space, FileText, ListOrdered, Clock3, ScanLine, RefreshCw, Combine, Copy, CaseSensitive, WrapText, CodeXml, Scissors, Languages, GitCompareArrows, Timer, Crop, FileCode2, FilePenLine, Info, Braces } from 'lucide-react';
import { getOperationDefinition, validateParameterValues, type Parameter, type WorkflowOperationId } from '../core/operation-registry';
export type { Parameter } from '../core/operation-registry';
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  keywords: string[];
  parameters: Parameter[];
  note: string;
  combined?: boolean;
}
const select = (key: string, label: string, choices: [string, string][], initial?: string): Parameter => ({ key, label, type: 'select', default: initial ?? choices[0][0], options: choices.map(([value, label]) => ({ value, label })) });
const number = (key: string, label: string, initial: number, min?: number, max?: number): Parameter => ({ key, label, type: 'number', default: initial, min, max });
const check = (key: string, label: string, initial = false): Parameter => ({ key, label, type: 'checkbox', default: initial });
const tool = (id: string, name: string, description: string, category: string, icon: LucideIcon, parameters: Parameter[] = [], note = '仅处理字幕正文，保留原始时间和条目顺序。', combined = false): ToolDefinition => ({ id, name, description, category, icon, parameters, note, combined, keywords: [id, category] });
const workflowTool = (id: WorkflowOperationId, icon: LucideIcon): ToolDefinition => {
  const definition = getOperationDefinition(id)!;
  return { ...definition, icon, keywords: [id, definition.category] };
};

export const tools: ToolDefinition[] = [
  workflowTool('replace', Replace),
  workflowTool('remove-empty', Eraser),
  workflowTool('clean-spaces', Space),
  tool('extract', '文本提取', '导出纯文本，方便阅读和整理文稿', '文本处理', FileText, [check('preserveLines', '保留字幕内的换行', true)], '输出 TXT，不包含时间和编号。'),
  tool('duplicates', '删除重复字幕', '按全部文本或连续重复条目去重', '文本处理', Copy, [select('strategy', '去重范围', [['consecutive', '仅连续重复'], ['all', '全部相同文本']])]),
  tool('punctuation', '标点转换', '在常见中文和英文标点之间转换', '文本处理', Languages, [select('direction', '转换方向', [['zh', '英文标点 → 中文标点'], ['en', '中文标点 → 英文标点']])]),
  workflowTool('chinese', Languages),
  tool('case', '英文大小写', '将英文转为大写、小写或单词首字母大写', '文本处理', CaseSensitive, [select('mode', '大小写规则', [['lower', '全部小写'], ['upper', '全部大写'], ['title', '单词首字母大写']])]),
  workflowTool('wrap', WrapText),
  workflowTool('strip-html', CodeXml),
  tool('merge', '多文件合并', '将多个字幕文件合并为一份 SRT', '合并与拆分', Combine, [select('strategy', '合并顺序', [['file', '按文件列表顺序'], ['time', '按开始时间排序']])], '保留各文件的原始时间；可在下方调整文件顺序，合并后重新编号。', true),
  tool('bilingual', '双语字幕合并', '按编号或时间匹配两份字幕', '合并与拆分', Languages, [select('mode', '匹配方式', [['index', '按字幕编号'], ['time', '按开始时间']]), number('toleranceMs', '时间容差（毫秒）', 300, 0), check('reverse', '第二份文件的文字显示在上方')], '需要恰好两份字幕。未匹配条目会保留，并在摘要中列出。', true),
  tool('split-count', '按条数拆分', '将字幕拆成若干份，保留原始时间', '合并与拆分', Scissors, [number('count', '每个文件的条目数', 100, 1, 1_000_000)], '不重置时间；每份输出重新编号。'),
  tool('split-time', '按时间拆分', '在指定时间点将字幕分为前后两份', '合并与拆分', Scissors, [number('timeMs', '拆分时间点（毫秒）', 60000, 1)], '跨越分割点的字幕会在两侧裁开，输出保留绝对时间。'),
  tool('compare', '字幕对比', '比较两份字幕的文本与时间差异', '合并与拆分', GitCompareArrows, [number('toleranceMs', '允许的时间差（毫秒）', 100, 0)], '需要恰好两份字幕，导出不含字幕全文的 JSON 差异报告。', true),
  tool('convert', '格式转换', '在 SRT、VTT、TXT、CSV、ASS 之间转换', '格式转换', RefreshCw, [select('format', '输出格式', [['srt', 'SRT · 标准字幕'], ['vtt', 'VTT · 网页字幕'], ['txt', 'TXT · 纯文本'], ['csv', 'CSV · 表格字幕'], ['ass', 'ASS · 基础字幕']])], 'ASS / SSA 的字体、位置、颜色和特效会丢失；VTT 设置会丢失。无时间信息的 TXT 无法生成字幕。CSV 列为 index,start,end,text。'),
  tool('detect', '字幕检测', '检查编号、重叠、空白和异常时间', '检测与修复', ScanLine, [], '只生成检测报告，不修改字幕。报告包含问题位置与原因，不保存字幕全文。'),
  tool('repair', '检测与修复', '重新编号、删除空白，并按所选策略修复时间', '检测与修复', ListOrdered, [select('invalidTime', '无效时间策略', [['keep', '保留并报告（阻止无效字幕导出）'], ['drop', '删除无效时间条目'], ['extend', '将结束时间延长至开始后 1 秒']]), select('overlap', '时间重叠策略', [['keep', '保留并报告'], ['trim', '缩短前一条的结束时间']])], '执行后重新检测。删除和时间调整只按你选择的策略进行；无法安全修复时会停止导出。'),
  workflowTool('renumber', ListOrdered),
  workflowTool('shift', Clock3),
  tool('duration', '调整显示时长', '统一增加或减少字幕的显示时间', '时间处理', Timer, [number('deltaMs', '时长增减（毫秒）', 500), select('policy', '调整后出现无效时间', [['reject', '停止处理，保留输入'], ['drop', '删除无效时间条目']])], '仅调整结束时间。默认遇到结束时间不晚于开始时间即停止，可明确选择删除无效条目。'),
  tool('min-duration', '最短显示时长', '将过短的字幕延长至指定时长', '时间处理', Timer, [number('durationMs', '最短时长（毫秒）', 1000, 1)], '延长时间可能造成重叠，结果会重新检测。'),
  tool('max-duration', '最长显示时长', '将过长的字幕缩短至指定时长', '时间处理', Timer, [number('durationMs', '最长时长（毫秒）', 7000, 1)], '仅缩短结束时间，保留正文与开始时间。'),
  tool('crop', '按时间范围裁剪', '保留指定时间范围内的字幕', '时间处理', Crop, [number('startMs', '范围开始（毫秒）', 0, 0), number('endMs', '范围结束（毫秒）', 60000, 1)], '边界条目会裁剪到所选范围，保留绝对时间；完全位于范围外的条目删除。'),
  tool('encoding', '编码与换行', '严格转换 UTF-8、UTF-16、GBK 或 GB18030 编码', '文件处理', FileCode2, [], '在导出选项中选择编码和换行符。旧编码不支持的字符会阻止导出。字幕会按统一模型规范化，原格式的样式和布局不保留。'),
  tool('rename', '批量重命名导出', '使用名称模板导出新的字幕副本', '文件处理', FilePenLine, [], '在导出选项中设置文件名模板。仅导出新文件，字幕会规范化，不移动或重命名原文件。'),
  tool('info', '文件信息与统计', '查看条目数、字符数与时间跨度', '文件处理', Info, [], '生成 JSON 统计报告；不修改原文件，不保存字幕全文。'),
];
export const categoryIcons: Record<string, LucideIcon> = { '文本处理': FileText, '合并与拆分': Combine, '格式转换': RefreshCw, '检测与修复': ScanLine, '时间处理': Clock3, '文件处理': Braces };
export const categories = Object.keys(categoryIcons);
export const quickToolIds = ['replace', 'shift', 'convert', 'remove-empty', 'detect', 'merge'];
export function defaultParameters(definition: ToolDefinition): Record<string, unknown> { return Object.fromEntries(definition.parameters.map(p => [p.key, p.default])); }
export function validateParameters(definition: ToolDefinition, params: Record<string, unknown>): Record<string, string> {
  return validateParameterValues(definition, params);
}
