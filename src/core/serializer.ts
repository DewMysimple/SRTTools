import { SubtitleError, type LineEnding, type SubtitleDocument, type SubtitleFormat } from './models';
import { assertValidTimes, formatTimestamp } from './time';
import { parseSubtitle } from './parser';

export function serializeSubtitle(document: SubtitleDocument, format: SubtitleFormat = document.format, lineEnding: LineEnding = document.lineEnding): { text: string; warnings: string[] } {
  assertValidTimes(document.cues);
  const warnings: string[] = [];
  let text: string;
  const cues = document.cues;
  switch (format) {
    case 'srt':
      text = cues.map((cue, i) => `${i + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text.replace(/\r\n?/g, '\n')}`).join('\n\n') + (cues.length ? '\n' : '');
      break;
    case 'vtt':
      warnings.push('转换会移除原格式的专有样式和位置设置。');
      text = `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${cue.text.replace(/\r\n?/g, '\n')}`).join('\n\n')}${cues.length ? '\n' : ''}`;
      break;
    case 'txt':
      text = cues.map(cue => cue.text).join('\n\n');
      warnings.push('纯文本输出不包含编号和时间信息，无法直接还原为字幕。');
      break;
    case 'csv': {
      const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      text = `index,start,end,text\n${cues.map((cue, i) => [String(i + 1), formatTimestamp(cue.startMs), formatTimestamp(cue.endMs), cue.text].map(escape).join(',')).join('\n')}${cues.length ? '\n' : ''}`;
      break;
    }
    case 'ass': {
      warnings.push('ASS 输出使用统一默认样式，时间会四舍五入到 10 毫秒；原字体、颜色、位置与特效不会恢复。');
      const assTime = (ms: number) => formatTimestamp(Math.round(ms / 10) * 10, '.').replace(/^0(?=\d:)/, '').slice(0, -1);
      text = '[Script Info]\nTitle: Subtitle Tools\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
      text += cues.map(cue => {
        if (Math.round(cue.endMs / 10) <= Math.round(cue.startMs / 10)) throw new SubtitleError('PRECISION_LOSS', `第 ${cue.index} 条字幕短于 ASS 时间精度，无法导出。请先增加时长。`);
        if (/[{}]/.test(cue.text) || /\\[Nnh]/.test(cue.text)) throw new SubtitleError('UNREPRESENTABLE_TEXT', '正文包含 ASS 控制符，无法无损输出；请先清理或选择 SRT。');
        return `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${cue.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\\N')}`;
      }).join('\n');
      break;
    }
    case 'ssa': throw new SubtitleError('UNSUPPORTED_FORMAT', 'SSA 仅支持导入，导出请选择 SRT 或 ASS。');
    default: throw new SubtitleError('UNSUPPORTED_FORMAT', '不支持此导出格式。');
  }
  const newline = lineEnding === 'CRLF' ? '\r\n' : lineEnding === 'CR' ? '\r' : '\n';
  text = text.replace(/\r\n?/g, '\n').replace(/\n/g, newline);
  if (format === 'srt' || format === 'vtt') {
    // A CSV/ASS body can contain blank paragraphs or timestamp-like prose that
    // cannot be distinguished from cue separators in SRT/VTT. Refuse a lossy
    // export instead of generating a file that silently reparses differently.
    const parsed = parseSubtitle(text, `roundtrip.${format}`);
    const same = parsed.document.cues.length === cues.length && parsed.document.cues.every((cue, i) => {
      const original = cues[i];
      return cue.startMs === original.startMs && cue.endMs === original.endMs && cue.text === original.text.replace(/\r\n?/g, '\n');
    });
    if (!same || parsed.diagnostics.some(issue => issue.severity === 'error')) throw new SubtitleError('UNREPRESENTABLE_TEXT', `正文中的空白行或时间行与 ${format.toUpperCase()} 结构存在歧义，无法无损导出。请清理正文中的空白行，或选择 CSV 格式保留原文。`);
  }
  return { text, warnings };
}
