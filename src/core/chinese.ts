import { Converter as simplifiedConverter } from 'opencc-js/cn2t';
import { Converter as traditionalConverter } from 'opencc-js/t2cn';
import { SubtitleError } from './models';

export type ChineseDirection = 's2t' | 't2s';
const converters: Partial<Record<ChineseDirection, (text: string) => string>> = {};

function converter(direction: ChineseDirection) {
  if (direction !== 's2t' && direction !== 't2s') throw new SubtitleError('INVALID_PARAMETER', '简繁转换方向不受支持。');
  return converters[direction] ??= direction === 's2t'
    ? simplifiedConverter({ from: 'cn', to: 't' })
    : traditionalConverter({ from: 't', to: 'cn' });
}

function malformedMarkup(): never {
  throw new SubtitleError('UNSAFE_MARKUP', '正文中有未闭合或不支持的格式标记，请修正后重试。');
}

function tagEnd(text: string, start: number): number {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    return end < 0 ? malformedMarkup() : end + 3;
  }
  let quote = '';
  for (let position = start + 1; position < text.length; position++) {
    const char = text[position];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return position + 1;
    else if (char === '<') malformedMarkup();
  }
  return malformedMarkup();
}

function braceEnd(text: string, start: number): number {
  let depth = 1;
  for (let position = start + 1; position < text.length; position++) {
    if (text[position] === '{') depth++;
    else if (text[position] === '}' && --depth === 0) return position + 1;
  }
  return malformedMarkup();
}

/** Convert prose while leaving subtitle control syntax and placeholders byte-for-byte in the decoded text. */
export function convertChineseText(text: string, direction: ChineseDirection): string {
  const convert = converter(direction);
  const chunks: string[] = [];
  let plainStart = 0;
  for (let position = 0; position < text.length; position++) {
    let end = position;
    const char = text[position];
    if (char === '{') end = braceEnd(text, position);
    else if (char === '<' && (/[A-Za-z/!?]/u.test(text[position + 1] ?? '') || /^\d{2}:\d{2}/u.test(text.slice(position + 1, position + 7)))) end = tagEnd(text, position);
    else if (char === '%' && text[position + 1] === '(') {
      const close = text.indexOf(')', position + 2);
      if (close < 0 || !/[a-z]/iu.test(text[close + 1] ?? '')) malformedMarkup();
      end = close + 2;
    }
    if (end === position) continue;
    chunks.push(convert(text.slice(plainStart, position)), text.slice(position, end));
    position = end - 1;
    plainStart = end;
  }
  chunks.push(convert(text.slice(plainStart)));
  return chunks.join('');
}
