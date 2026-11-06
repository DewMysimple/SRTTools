import { type ParseDiagnostic, type SubtitleCue, type SubtitleDocument } from './models';
import { validateCueTime } from './time';
import { hasVisibleText } from './text';

export interface ValidationOptions {
  maxChars?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export const DEFAULT_MIN_CUE_DURATION_MS = 500;

export function validateDocument(document: SubtitleDocument, options: ValidationOptions = {}): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  const texts = new Set<string>();
  const indexes = new Set<number>();
  const overlaps = new Map<SubtitleCue, SubtitleCue>();
  const byTime = document.cues.filter(cue => !validateCueTime(cue)).slice().sort((a, b) => a.startMs - b.startMs);
  let active: SubtitleCue | undefined;
  for (const cue of byTime) {
    if (active && cue.startMs < active.endMs) overlaps.set(cue, active);
    if (!active || cue.endMs > active.endMs) active = cue;
  }
  const maxChars = options.maxChars ?? 42;
  const minDurationMs = options.minDurationMs ?? DEFAULT_MIN_CUE_DURATION_MS;
  const maxDurationMs = options.maxDurationMs ?? 10000;
  for (let i = 0; i < document.cues.length; i++) {
    const cue = document.cues[i];
    const add = (code: string, message: string, severity: ParseDiagnostic['severity'] = 'warning') => diagnostics.push({ severity, code, message, cueIndex: cue.index });
    if (indexes.has(cue.index)) add('DUPLICATE_INDEX', '字幕编号重复。');
    if (cue.index !== i + 1) add('NONCONTINUOUS_INDEX', `编号不连续，按顺序应为 ${i + 1}。`);
    indexes.add(cue.index);
    const invalidTime = validateCueTime(cue);
    if (invalidTime) add('INVALID_CUE_TIME', invalidTime, 'error');
    else {
      const overlapping = overlaps.get(cue);
      if (overlapping) add('OVERLAP', `与第 ${overlapping.index} 条字幕时间重叠。`);
      const duration = cue.endMs - cue.startMs;
      if (duration < minDurationMs) add('DURATION_SHORT', `显示时长 ${duration} 毫秒，短于 ${minDurationMs} 毫秒。`);
      if (duration > maxDurationMs) add('DURATION_LONG', `显示时长 ${duration} 毫秒，长于 ${maxDurationMs} 毫秒。`);
    }
    if (i > 0 && cue.startMs < document.cues[i - 1].startMs) add('TIME_REVERSED', '开始时间早于前一条字幕，条目时间倒序。');
    if (!hasVisibleText(cue.text)) add('EMPTY_CUE', '正文没有可见文字。');
    if (texts.has(cue.text)) add('DUPLICATE_TEXT', '正文与此前某条字幕完全相同。');
    texts.add(cue.text);
    if (cue.text.replace(/\r\n?/g, '\n').split('\n').some(line => Array.from(line).length > maxChars)) add('TEXT_TOO_LONG', `正文某行超过 ${maxChars} 个字符。`);
    if (cue.text.includes('\ufffd') || cue.text.includes('\0')) add('SUSPECT_ENCODING', '正文包含替代字符或空字符，可能存在编码问题。');
  }
  if (!document.cues.length) diagnostics.push({ severity: 'warning', code: 'EMPTY_DOCUMENT', message: '没有字幕条目。' });
  return diagnostics;
}

export function documentStatistics(document: SubtitleDocument): { cues: number; characters: number; startMs: number; endMs: number; spanMs: number } {
  let startMs = Infinity;
  let endMs = 0;
  let characters = 0;
  for (const cue of document.cues) {
    startMs = Math.min(startMs, cue.startMs); endMs = Math.max(endMs, cue.endMs);
    characters += Array.from(cue.text.replace(/\s/g, '')).length;
  }
  if (!document.cues.length) startMs = 0;
  return { cues: document.cues.length, characters, startMs, endMs, spanMs: endMs - startMs };
}
