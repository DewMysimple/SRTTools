import { cloneDocument, createId, renameExtension, SubtitleError, type ParseDiagnostic, type SubtitleCue, type SubtitleDocument, type SubtitleFormat } from './models';
import { assertValidTimes, shiftCueTimes, validateCueTime } from './time';
import { changeCase, cleanSpaces, convertPunctuation, hasVisibleText, removeDuplicateCues, replaceText, stripHtml, wrapText } from './text';
import { validateDocument } from './validate';

export interface ProcessResult {
  documents: SubtitleDocument[];
  diagnostics: ParseDiagnostic[];
  summary: string;
}

function numberParameter(params: Record<string, unknown>, key: string, fallback?: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const value = params[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new SubtitleError('INVALID_PARAMETER', `参数 ${key} 必须是 ${min}–${max} 范围内的整数。`);
  return value;
}

function choice<T extends string>(params: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
  const value = params[key] ?? fallback;
  if (!values.includes(value as T)) throw new SubtitleError('INVALID_PARAMETER', `参数 ${key} 的值不受支持。`);
  return value as T;
}

function bool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key] ?? fallback;
  if (typeof value !== 'boolean') throw new SubtitleError('INVALID_PARAMETER', `参数 ${key} 必须为开关值。`);
  return value;
}

function partDocument(document: SubtitleDocument, cues: SubtitleCue[], part: number): SubtitleDocument {
  return { ...document, id: createId(), sourcePath: undefined, fileName: document.fileName.replace(/(\.[^.]*)?$/, `_part${String(part).padStart(2, '0')}$1`), cues: cues.map((cue, i) => ({ ...cue, index: i + 1 })), modified: true };
}

export function processDocument(input: SubtitleDocument, operation: string, params: Record<string, unknown> = {}): ProcessResult {
  const document = cloneDocument(input);
  let diagnostics: ParseDiagnostic[] = [];
  let documents = [document];
  let summary = '';
  const mapText = (transform: (text: string) => string) => { document.cues = document.cues.map(cue => ({ ...cue, text: transform(cue.text) })); };
  switch (operation) {
    case 'replace': {
      if (typeof params.find !== 'string' || !params.find) throw new SubtitleError('INVALID_PARAMETER', '请输入查找内容。');
      if (params.replacement !== undefined && typeof params.replacement !== 'string') throw new SubtitleError('INVALID_PARAMETER', '替换内容必须是文本。');
      const options = { find: params.find, replacement: (params.replacement ?? '') as string, caseSensitive: bool(params, 'caseSensitive', false), regex: bool(params, 'regex', false) };
      // Validate even for empty documents.
      replaceText('', options);
      mapText(text => replaceText(text, options));
      break;
    }
    case 'remove-empty': document.cues = document.cues.filter(cue => hasVisibleText(cue.text)); break;
    case 'clean-spaces': mapText(text => cleanSpaces(text, bool(params, 'collapse', true))); break;
    case 'duplicates': document.cues = removeDuplicateCues(document.cues, choice(params, 'strategy', ['all', 'consecutive'], 'consecutive')); break;
    case 'punctuation': mapText(text => convertPunctuation(text, choice(params, 'direction', ['zh', 'en'], 'zh'))); break;
    case 'case': mapText(text => changeCase(text, choice(params, 'mode', ['upper', 'lower', 'title'], 'lower'))); break;
    case 'wrap': {
      const maxChars = numberParameter(params, 'maxChars', 42, 1, 10000);
      mapText(text => wrapText(text, maxChars)); break;
    }
    case 'strip-html': mapText(stripHtml); break;
    case 'extract':
      if (!bool(params, 'preserveLines', true)) mapText(text => text.replace(/\r\n?|\n/g, ' '));
      document.format = 'txt'; document.fileName = renameExtension(document.fileName, 'txt');
      diagnostics.push({ severity: 'warning', code: 'LOSSY_TEXT', message: '纯文本导出会移除时间和编号，无法直接还原字幕。' });
      break;
    case 'renumber': document.cues.forEach((cue, i) => { cue.index = i + 1; }); break;
    case 'shift': {
      const policy = choice(params, 'policy', ['reject', 'clamp', 'drop'], 'reject');
      document.cues = shiftCueTimes(document.cues, numberParameter(params, 'offsetMs', undefined), policy);
      if (policy !== 'reject') diagnostics.push({ severity: 'warning', code: 'TIME_POLICY', message: `已按所选策略${policy === 'drop' ? '删除偏移后无效的条目' : '将负时间裁剪到零，无法保留的条目仍会报错'}。` });
      break;
    }
    case 'duration': {
      const deltaMs = numberParameter(params, 'deltaMs', undefined);
      const policy = choice(params, 'policy', ['reject', 'drop'], 'reject');
      document.cues = document.cues.map(cue => ({ ...cue, endMs: cue.endMs + deltaMs })).filter(cue => {
        if (!validateCueTime(cue)) return true;
        if (policy === 'drop') return false;
        throw new SubtitleError('INVALID_CUE_TIME', `第 ${cue.index} 条字幕调整后时间无效，请调整时长或选择删除无效条目。`);
      });
      diagnostics = validateDocument(document).filter(item => item.code === 'OVERLAP');
      break;
    }
    case 'min-duration':
    case 'max-duration': {
      assertValidTimes(document.cues);
      const durationMs = numberParameter(params, 'durationMs', undefined, 1);
      document.cues = document.cues.map(cue => ({ ...cue, endMs: cue.startMs + (operation === 'min-duration' ? Math.max(durationMs, cue.endMs - cue.startMs) : Math.min(durationMs, cue.endMs - cue.startMs)) }));
      assertValidTimes(document.cues);
      diagnostics = validateDocument(document).filter(item => item.code === 'OVERLAP');
      break;
    }
    case 'crop': {
      assertValidTimes(document.cues);
      const startMs = numberParameter(params, 'startMs', 0, 0);
      const endMs = numberParameter(params, 'endMs', undefined, startMs + 1);
      const resetTime = bool(params, 'resetTime', false);
      document.cues = document.cues.map(cue => ({ ...cue, startMs: Math.max(cue.startMs, startMs), endMs: Math.min(cue.endMs, endMs) })).filter(cue => cue.endMs > cue.startMs).map(cue => ({ ...cue, startMs: cue.startMs - (resetTime ? startMs : 0), endMs: cue.endMs - (resetTime ? startMs : 0) }));
      if (!document.cues.length) throw new SubtitleError('EMPTY_RANGE', '指定范围内没有字幕，未生成空输出。');
      break;
    }
    case 'split-count': {
      const count = numberParameter(params, 'count', 100, 1, 1000000);
      if (!document.cues.length) throw new SubtitleError('EMPTY_DOCUMENT', '没有字幕可以拆分。');
      documents = [];
      for (let i = 0; i < document.cues.length; i += count) documents.push(partDocument(document, document.cues.slice(i, i + count), documents.length + 1));
      break;
    }
    case 'split-time': {
      assertValidTimes(document.cues);
      const timeMs = numberParameter(params, 'timeMs', undefined, 1);
      const resetTime = bool(params, 'resetTime', false);
      const before = document.cues.filter(cue => cue.startMs < timeMs).map(cue => ({ ...cue, endMs: Math.min(timeMs, cue.endMs) }));
      const after = document.cues.filter(cue => cue.endMs > timeMs).map(cue => ({ ...cue, id: createId(), startMs: Math.max(timeMs, cue.startMs) - (resetTime ? timeMs : 0), endMs: cue.endMs - (resetTime ? timeMs : 0) }));
      if (!before.length || !after.length) throw new SubtitleError('EMPTY_RANGE', '拆分点必须位于字幕时间跨度内，且前后都包含字幕。');
      documents = [partDocument(document, before, 1), partDocument(document, after, 2)];
      break;
    }
    case 'convert': {
      document.format = choice<SubtitleFormat>(params, 'format', ['srt', 'vtt', 'txt', 'csv', 'ass'], 'srt');
      document.fileName = renameExtension(document.fileName, document.format);
      break;
    }
    case 'detect':
      diagnostics = validateDocument(document, { maxChars: numberParameter(params, 'maxChars', 42, 1), minDurationMs: numberParameter(params, 'minDurationMs', 500, 0), maxDurationMs: numberParameter(params, 'maxDurationMs', 10000, 1) });
      summary = `检测 ${document.cues.length} 条字幕，发现 ${diagnostics.length} 个问题。`;
      document.modified = input.modified;
      break;
    case 'repair': {
      if (bool(params, 'removeEmpty', true)) document.cues = document.cues.filter(cue => hasVisibleText(cue.text));
      const invalid = choice(params, 'invalidTime', ['keep', 'drop', 'extend'], 'keep');
      if (invalid === 'drop') document.cues = document.cues.filter(cue => !validateCueTime(cue));
      if (invalid === 'extend') {
        const durationMs = numberParameter(params, 'durationMs', 1000, 1);
        document.cues = document.cues.map(cue => {
          if (!validateCueTime(cue)) return cue;
          if (!Number.isSafeInteger(cue.startMs)) throw new SubtitleError('INVALID_CUE_TIME', `第 ${cue.index} 条字幕的开始时间不可恢复。`);
          const startMs = Math.max(0, cue.startMs);
          return { ...cue, startMs, endMs: startMs + durationMs };
        });
      }
      if (choice(params, 'overlap', ['keep', 'trim'], 'keep') === 'trim') {
        // Never reorder entries silently. Trimming only works for strictly increasing start times.
        for (let i = 0; i < document.cues.length - 1; i++) {
          const cue = document.cues[i]; const next = document.cues[i + 1];
          if (cue.endMs > next.startMs) {
            if (next.startMs <= cue.startMs) throw new SubtitleError('AMBIGUOUS_OVERLAP', `第 ${cue.index} 条与下一条的开始时间重合或倒序，无法裁短修复。请选择保留重叠或调整时间。`);
            cue.endMs = next.startMs;
          }
        }
      }
      if (bool(params, 'renumber', true)) document.cues.forEach((cue, i) => { cue.index = i + 1; });
      diagnostics = validateDocument(document);
      summary = `修复完成：保留 ${document.cues.length} 条字幕；重新检测后剩余 ${diagnostics.length} 个问题。`;
      break;
    }
    default: throw new SubtitleError('UNSUPPORTED_OPERATION', `不支持此操作：${operation}。`);
  }
  if (!summary) {
    const changed = document.cues.filter((cue, i) => cue.text !== input.cues[i]?.text || cue.index !== input.cues[i]?.index || cue.startMs !== input.cues[i]?.startMs || cue.endMs !== input.cues[i]?.endMs).length;
    summary = documents.length > 1 ? `已生成 ${documents.length} 份字幕文件。` : `处理 ${input.cues.length} 条字幕，输出 ${document.cues.length} 条；${changed} 条发生变化。`;
  }
  return { documents, diagnostics, summary };
}
