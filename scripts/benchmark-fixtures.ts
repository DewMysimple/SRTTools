import { formatTimestamp } from '../src/core/time';

/** Synthetic and deterministic; no user subtitle data or filesystem access. */
export function benchmarkSubtitleText(cueCount: number, variant: 'srt' | 'ass' | 'long-line' = 'srt'): string {
  if (variant === 'long-line') return '1\n00:00:01,000 --> 00:00:03,000\n' + '字幕 😀 long line '.repeat(16384) + '\n';
  const chunks: string[] = [];
  if (variant === 'ass') {
    chunks.push('[Script Info]\nTitle: Benchmark fixture\n[V4+ Styles]\nStyle: Default,Arial,42\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  }
  for (let position = 0; position < cueCount; position++) {
    const startMs = position * 3000 + 1000;
    if (variant === 'ass') {
      const time = (value: number) => formatTimestamp(value, '.').slice(1, -1);
      chunks.push(`Dialogue: 0,${time(startMs)},${time(startMs + 2000)},Default,,0,0,0,,{\\pos(12,34)}软件发展 😀\\N第二行字幕`);
    } else {
      const text = position % 23 === 0 ? '   ' : `  第 ${position + 1} 行简体字幕 繁體 😀 <i>local text</i>  \n Second  line with spaces & punctuation! `;
      chunks.push(`${position + 1}\n${formatTimestamp(startMs)} --> ${formatTimestamp(startMs + 2000)}\n${text}`);
    }
  }
  return chunks.join(variant === 'ass' ? '\n' : '\n\n') + '\n';
}
