import { cloneDocument, createId, SubtitleError, type ParseDiagnostic, type SubtitleDocument } from './models';
import { assertValidTimes } from './time';

export function mergeDocuments(documents: SubtitleDocument[], strategy: 'file' | 'time' = 'file'): SubtitleDocument {
  if (!documents.length) throw new SubtitleError('INVALID_PARAMETER', '请至少选择一个字幕文件。');
  if (!['file', 'time'].includes(strategy)) throw new SubtitleError('INVALID_PARAMETER', '请选择文件顺序或时间排序的合并策略。');
  const document = cloneDocument(documents[0]);
  document.id = createId(); document.fileName = 'merged.srt'; document.format = 'srt'; delete document.sourcePath;
  document.cues = documents.flatMap(input => input.cues.map(cue => ({ ...cue, id: createId() })));
  if (strategy === 'time') document.cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  document.cues.forEach((cue, i) => { cue.index = i + 1; });
  assertValidTimes(document.cues);
  return document;
}

export interface BilingualOptions {
  mode: 'index' | 'time';
  toleranceMs: number;
  reverse?: boolean;
}

export function bilingualMerge(first: SubtitleDocument, second: SubtitleDocument, options: BilingualOptions): { document: SubtitleDocument; matched: number; unmatchedFirst: number; unmatchedSecond: number; diagnostics: ParseDiagnostic[] } {
  if (!['index', 'time'].includes(options.mode) || !Number.isSafeInteger(options.toleranceMs) || options.toleranceMs < 0) throw new SubtitleError('INVALID_PARAMETER', '匹配方式无效，时间容差必须是非负整数毫秒。');
  assertValidTimes(first.cues); assertValidTimes(second.cues);
  const document = cloneDocument(first);
  document.id = createId(); document.fileName = 'bilingual.srt'; document.format = 'srt'; delete document.sourcePath;
  const used = new Set<number>();
  const sorted = second.cues.map((cue, index) => ({ cue, index })).sort((a, b) => a.cue.startMs - b.cue.startMs);
  const byIndex = new Map<number, number[]>();
  second.cues.forEach((cue, i) => {
    const indexes = byIndex.get(cue.index);
    if (indexes) indexes.push(i); else byIndex.set(cue.index, [i]);
  });
  const indexPositions = new Map<number, number>();
  let matched = 0;
  let unmatchedFirst = 0;
  const diagnostics: ParseDiagnostic[] = [];
  document.cues = first.cues.map(cue => {
    let candidate = -1;
    if (options.mode === 'index') {
      const position = indexPositions.get(cue.index) ?? 0;
      candidate = byIndex.get(cue.index)?.[position] ?? -1;
      if (candidate >= 0) indexPositions.set(cue.index, position + 1);
    }
    else {
      let low = 0;
      let high = sorted.length;
      while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle].cue.startMs < cue.startMs - options.toleranceMs) low = middle + 1; else high = middle; }
      let bestDifference = Infinity;
      for (let i = low; i < sorted.length && sorted[i].cue.startMs <= cue.startMs + options.toleranceMs; i++) {
        const item = sorted[i];
        const difference = Math.abs(item.cue.startMs - cue.startMs);
        if (!used.has(item.index) && difference < bestDifference) { candidate = item.index; bestDifference = difference; }
      }
    }
    if (candidate < 0) {
      unmatchedFirst++;
      diagnostics.push({ severity: 'warning', code: 'UNMATCHED_FIRST', message: '第一份字幕的此条目没有匹配项，已单独保留。', cueIndex: cue.index });
      return { ...cue, id: createId() };
    }
    matched++; used.add(candidate);
    const other = second.cues[candidate];
    return { ...cue, id: createId(), text: options.reverse ? `${other.text}\n${cue.text}` : `${cue.text}\n${other.text}` };
  });
  second.cues.forEach((cue, i) => {
    if (!used.has(i)) {
      document.cues.push({ ...cue, id: createId() });
      diagnostics.push({ severity: 'warning', code: 'UNMATCHED_SECOND', message: '第二份字幕的此条目没有匹配项，已单独保留。', cueIndex: cue.index });
    }
  });
  document.cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  document.cues.forEach((cue, i) => { cue.index = i + 1; });
  return { document, matched, unmatchedFirst, unmatchedSecond: second.cues.length - used.size, diagnostics };
}

export function compareDocuments(first: SubtitleDocument, second: SubtitleDocument, toleranceMs = 0): ParseDiagnostic[] {
  if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new SubtitleError('INVALID_PARAMETER', '时间容差必须是非负整数毫秒。');
  const diagnostics: ParseDiagnostic[] = [];
  const total = Math.max(first.cues.length, second.cues.length);
  for (let i = 0; i < total; i++) {
    const a = first.cues[i]; const b = second.cues[i];
    if (!a || !b) diagnostics.push({ severity: 'warning', code: 'MISSING_CUE', message: `${a ? '第二份' : '第一份'}文件缺少第 ${i + 1} 个条目。`, cueIndex: (a ?? b).index });
    else {
      if (a.text !== b.text) diagnostics.push({ severity: 'info', code: 'TEXT_DIFFERENT', message: '两份字幕正文不同。', cueIndex: a.index });
      if (Math.abs(a.startMs - b.startMs) > toleranceMs || Math.abs(a.endMs - b.endMs) > toleranceMs) diagnostics.push({ severity: 'info', code: 'TIME_DIFFERENT', message: `时间不同：开始差 ${b.startMs - a.startMs} 毫秒，结束差 ${b.endMs - a.endMs} 毫秒。`, cueIndex: a.index });
    }
  }
  return diagnostics;
}
