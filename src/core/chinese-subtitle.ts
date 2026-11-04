import { convertChineseText, type ChineseDirection } from './chinese';
import { SubtitleError, type SubtitleDocument } from './models';
import { parseSubtitle, type SourceParseResult } from './parser';

/** Rewrite only parser-confirmed body spans and re-check the same format before exposing an output. */
export function convertChineseSubtitle(source: string, parsed: SourceParseResult, direction: ChineseDirection): { text: string; document: SubtitleDocument } {
  const spans = parsed.bodySpans;
  const input = parsed.document;
  if (!spans || spans.length !== input.cues.length || parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new SubtitleError('UNSAFE_LAYOUT', '字幕正文位置无法可靠确认，请先修正字幕结构。');
  }
  const chunks: string[] = [];
  let previousEnd = 0;
  spans.forEach((span, position) => {
    if (span.start < previousEnd || span.end < span.start || span.end > source.length) {
      throw new SubtitleError('UNSAFE_LAYOUT', '字幕正文位置重叠或超出原文范围，已停止导出。');
    }
    const original = span.csvValue ?? source.slice(span.start, span.end);
    let converted: string;
    try {
      converted = convertChineseText(original, direction);
    } catch (error) {
      if (!(error instanceof SubtitleError)) throw error;
      throw new SubtitleError(error.code, `第 ${input.cues[position].index} 条字幕：${error.message}`);
    }
    if (span.csvValue !== undefined && (span.csvQuoted || /[",\r\n]/u.test(converted))) {
      converted = `"${converted.replace(/"/gu, '""')}"`;
    }
    chunks.push(source.slice(previousEnd, span.start), converted);
    previousEnd = span.end;
  });
  chunks.push(source.slice(previousEnd));
  const text = chunks.join('');
  const output = parseSubtitle(text, input.fileName);
  const consistent = output.document.cues.length === input.cues.length && output.document.cues.every((cue, position) => {
    const original = input.cues[position];
    return cue.index === original.index && cue.startMs === original.startMs && cue.endMs === original.endMs;
  });
  if (!consistent || output.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new SubtitleError('UNSAFE_LAYOUT', '转换后字幕结构与原文不一致，已停止导出。');
  }
  return {
    text,
    document: {
      ...input, modified: true,
      cues: output.document.cues.map((cue, position) => ({ ...cue, id: input.cues[position].id })),
    },
  };
}
