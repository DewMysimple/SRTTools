import { SubtitleError, type SubtitleCue } from './models';

export function parseTimestamp(value: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new SubtitleError('INVALID_TIME', `无法识别时间“${value}”，请使用 HH:MM:SS,mmm。`);
  }
  const result = Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4].padEnd(3, '0'));
  if (!Number.isSafeInteger(result)) throw new SubtitleError('INVALID_TIME', '时间超过可支持的范围。');
  return result;
}

export function formatTimestamp(milliseconds: number, separator: ',' | '.' = ','): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new SubtitleError('INVALID_TIME', '时间必须是大于或等于 0 的整数毫秒。');
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(milliseconds % 1_000).padStart(3, '0')}`;
}

export const millisecondsToTimestamp = formatTimestamp;
export const timestampToMilliseconds = parseTimestamp;

export function validateCueTime(cue: Pick<SubtitleCue, 'startMs' | 'endMs'>): string | null {
  if (!Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs)) return '时间必须是整数毫秒，且在有效范围内。';
  if (cue.startMs < 0 || cue.endMs < 0) return '时间不能小于 0。';
  if (cue.endMs <= cue.startMs) return '结束时间必须晚于开始时间。';
  return null;
}

export function assertValidTimes(cues: SubtitleCue[]): void {
  for (const cue of cues) {
    const error = validateCueTime(cue);
    if (error) throw new SubtitleError('INVALID_CUE_TIME', `第 ${cue.index} 条字幕：${error}请先选择修复策略。`);
  }
}

export function shiftCueTimes(cues: SubtitleCue[], offsetMs: number, policy: 'reject' | 'clamp' | 'drop' = 'reject'): SubtitleCue[] {
  if (!Number.isSafeInteger(offsetMs)) throw new SubtitleError('INVALID_PARAMETER', '偏移量必须是整数毫秒。');
  const result: SubtitleCue[] = [];
  for (const cue of cues) {
    let shifted = { ...cue, startMs: cue.startMs + offsetMs, endMs: cue.endMs + offsetMs };
    if (policy === 'clamp') shifted = { ...shifted, startMs: Math.max(0, shifted.startMs), endMs: Math.max(0, shifted.endMs) };
    if (validateCueTime(shifted)) {
      if (policy === 'drop') continue;
      throw new SubtitleError('INVALID_CUE_TIME', `偏移后第 ${cue.index} 条字幕时间无效，请减小提前量或选择删除无效条目的策略。`);
    }
    result.push(shifted);
  }
  return result;
}
