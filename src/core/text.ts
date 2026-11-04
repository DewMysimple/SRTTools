import { SubtitleError, type SubtitleCue } from './models';

export function stripHtml(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key[0] !== '#') return entities[key] ?? whole;
    const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

export function hasVisibleText(text: string): boolean {
  return /[^\s\u200b-\u200d\ufeff]/u.test(stripHtml(text).replace(/\{\\[^}]*\}/g, ''));
}

export interface ReplaceOptions {
  find: string;
  replacement: string;
  caseSensitive?: boolean;
  regex?: boolean;
}

export function replaceText(text: string, options: ReplaceOptions): string {
  if (!options.find) throw new SubtitleError('INVALID_PARAMETER', '查找内容不能为空。');
  const escaped = options.regex ? options.find : options.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let expression: RegExp;
  try { expression = new RegExp(escaped, options.caseSensitive ? 'gu' : 'giu'); }
  catch { throw new SubtitleError('INVALID_REGEX', '正则表达式无效，请检查括号、转义符和字符范围。'); }
  // Literal mode always inserts replacement literally, including $, $&, and $1.
  return options.regex ? text.replace(expression, options.replacement) : text.replace(expression, () => options.replacement);
}

export function cleanSpaces(text: string, collapse = true): string {
  return text.split(/\r\n?|\n/).map(line => {
    const trimmed = line.trim();
    return collapse ? trimmed.replace(/[ \t\u00a0\u3000]+/g, ' ') : trimmed;
  }).join('\n');
}

export function removeDuplicateCues(cues: SubtitleCue[], strategy: 'all' | 'consecutive'): SubtitleCue[] {
  const seen = new Set<string>();
  let previous: string | undefined;
  return cues.filter(cue => {
    const duplicate = strategy === 'all' ? seen.has(cue.text) : cue.text === previous;
    seen.add(cue.text); previous = cue.text;
    return !duplicate;
  });
}

export function convertPunctuation(text: string, direction: 'zh' | 'en'): string {
  const english = [',', '.', '!', '?', ':', ';', '(', ')', '[', ']'];
  const chinese = ['，', '。', '！', '？', '：', '；', '（', '）', '【', '】'];
  const from = direction === 'zh' ? english : chinese;
  const to = direction === 'zh' ? chinese : english;
  const mapping = new Map(from.map((item, i) => [item, to[i]]));
  return Array.from(text, char => mapping.get(char) ?? char).join('');
}

export function changeCase(text: string, mode: 'upper' | 'lower' | 'title'): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

export function wrapText(text: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 10000) throw new SubtitleError('INVALID_PARAMETER', '每行字数必须为 1–10000 的整数。');
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const chars = Array.from(line);
    const output: string[] = [];
    let offset = 0;
    while (chars.length - offset > maxChars) {
      // Prefer a nearby space without making lines exceed the requested bound.
      let boundary = offset + maxChars;
      for (let i = boundary - 1; i >= offset + Math.floor(maxChars / 2); i--) {
        if (/\s/.test(chars[i])) { boundary = i + 1; break; }
      }
      // Keep a cursor instead of shifting the remaining array for every output line.
      output.push(chars.slice(offset, boundary).join(''));
      offset = boundary;
    }
    output.push(chars.slice(offset).join(''));
    return output.join('\n');
  }).join('\n');
}
