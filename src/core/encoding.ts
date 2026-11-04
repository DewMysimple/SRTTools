import { SubtitleError } from './models';

export interface DecodedText {
  text: string;
  encoding: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

function textIntegrityWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (text.includes('\ufffd')) warnings.push('文本包含替代字符 �，可能在此前的保存过程中已丢失字符。');
  if (text.includes('\0')) warnings.push('文本包含空字符，可能选择了不正确的编码；请核对预览。');
  return warnings;
}

function normalizedEncoding(encoding: string): string {
  const key = encoding.toLowerCase().replace(/[\s_-]/g, '');
  const names: Record<string, string> = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', gbk: 'GBK', gb18030: 'GB18030', auto: 'auto' };
  const name = names[key];
  if (!name) throw new SubtitleError('UNKNOWN_ENCODING', `暂不支持编码：${encoding}。`);
  return name;
}

export function decodeBytes(bytes: Uint8Array, override?: string): DecodedText {
  let encoding = override ? normalizedEncoding(override) : 'auto';
  let confidence: DecodedText['confidence'] = 'high';
  const warnings: string[] = [];
  if (encoding === 'auto') {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'UTF-8 BOM';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'UTF-16 LE';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'UTF-16 BE';
    else {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) throw new Error('NUL');
        return { text, encoding: 'UTF-8', confidence, warnings: textIntegrityWarnings(text) };
      } catch {
        let oddZeros = 0;
        let evenZeros = 0;
        for (let i = 0; i < Math.min(bytes.length, 4000); i++) {
          if (bytes[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
        }
        if (oddZeros > 3 && oddZeros > evenZeros * 3) encoding = 'UTF-16 LE';
        else if (evenZeros > 3 && evenZeros > oddZeros * 3) encoding = 'UTF-16 BE';
        else throw new SubtitleError('UNKNOWN_ENCODING', '无法可靠识别编码。请手动选择 UTF-16、GBK 或 GB18030 后重新导入。');
        confidence = 'low';
        warnings.push('文件没有编码标记，UTF-16 为推测结果；请核对预览或手动选择编码。');
      }
    }
  }
  const label = encoding === 'UTF-8 BOM' ? 'utf-8' : encoding.toLowerCase().replace(/ /g, '');
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes);
    warnings.push(...textIntegrityWarnings(text));
    if (encoding === 'GBK' || encoding === 'GB18030') warnings.push('正在使用手动指定的中文编码；请核对预览。中文旧编码仅支持导入，导出请选择 Unicode 编码。');
    return { text, encoding, confidence, warnings };
  } catch {
    throw new SubtitleError('DECODE_FAILED', `无法使用 ${encoding} 解码，请选择正确的文件编码。`);
  }
}

export function encodeText(text: string, requested: string): Uint8Array {
  const encoding = normalizedEncoding(requested);
  // Reject unpaired surrogates rather than silently replacing data with U+FFFD.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new SubtitleError('ENCODE_FAILED', '文本含有不完整的 Unicode 字符，无法无损导出。');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new SubtitleError('ENCODE_FAILED', '文本含有不完整的 Unicode 字符，无法无损导出。');
  }
  if (encoding === 'UTF-8') return new TextEncoder().encode(text);
  if (encoding === 'UTF-8 BOM') {
    const data = new TextEncoder().encode(text);
    const result = new Uint8Array(data.length + 3);
    result.set([0xef, 0xbb, 0xbf]); result.set(data, 3);
    return result;
  }
  if (encoding === 'UTF-16 LE' || encoding === 'UTF-16 BE') {
    const littleEndian = encoding === 'UTF-16 LE';
    const data = new Uint8Array(text.length * 2 + 2);
    data.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
    const view = new DataView(data.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2 + 2, text.charCodeAt(i), littleEndian);
    return data;
  }
  throw new SubtitleError('UNSUPPORTED_ENCODING', `${encoding} 暂不支持无损导出，请选择 UTF-8 或 UTF-16。`);
}
