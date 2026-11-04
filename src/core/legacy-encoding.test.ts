import { describe, expect, it } from 'vitest';
import { decodeBytes, encodeText } from './encoding';

describe('strict legacy Chinese output', () => {
  it.each(['GBK', 'GB18030'])('writes exact common Chinese bytes in %s', encoding => {
    const bytes = encodeText('中文\r\nABC', encoding);
    expect(Array.from(bytes)).toEqual([0xd6, 0xd0, 0xce, 0xc4, 13, 10, 65, 66, 67]);
    expect(decodeBytes(bytes, encoding).text).toBe('中文\r\nABC');
  });

  it('keeps the independently defined Euro mappings', () => {
    expect(Array.from(encodeText('€', 'GBK'))).toEqual([0x80]);
    expect(Array.from(encodeText('€', 'GB18030'))).toEqual([0xa2, 0xe3]);
  });

  it.each([
    ['😀', [0x94, 0x39, 0xfc, 0x36]],
    ['𠀀', [0x95, 0x32, 0x82, 0x36]],
  ] as const)('represents %s with verified GB18030 bytes and refuses it in GBK', (character, expected) => {
    expect(Array.from(encodeText(character, 'GB18030'))).toEqual(expected);
    expect(decodeBytes(Uint8Array.from(expected), 'GB18030').text).toBe(character);
    expect(() => encodeText(character, 'GBK')).toThrow('GBK');
  });

  it('uses the current WHATWG two-byte mapping for U+1E3F in both profiles', () => {
    for (const encoding of ['GBK', 'GB18030']) {
      expect(Array.from(encodeText('ḿ', encoding))).toEqual([0xa8, 0xbc]);
    }
  });

  it.each(['\uE5E5', '\uE78D'])('refuses non-roundtripping PUA compatibility aliases in both encodings', character => {
    for (const encoding of ['GBK', 'GB18030']) {
      expect(() => encodeText(character, encoding)).toThrow('无损');
    }
  });

  it('locates the original UTF-16 offset and scalar without replacing it', () => {
    const text = '中文\nASCII 😀 后面';
    try {
      encodeText(text, 'GBK');
      expect.unreachable('unsupported emoji must fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENCODE_FAILED', offset: 9, character: '😀' });
      expect((error as Error).message).toContain('U+1F600');
    }
  });

  it.each(['GBK', 'GB18030', 'UTF-8', 'UTF-16 BE'])('refuses lone surrogates before the %s encoder', encoding => {
    expect(() => encodeText('正文\ud800末尾', encoding)).toThrow('不完整');
  });

  it('handles surrogate pairs at an encoding chunk boundary without changing any source text', () => {
    const text = 'A'.repeat(8191) + '😀' + '中文\n'.repeat(5000);
    const bytes = encodeText(text, 'GB18030');
    expect(decodeBytes(bytes, 'GB18030').text).toBe(text);
    expect(Array.from(bytes.slice(8191, 8195))).toEqual([0x94, 0x39, 0xfc, 0x36]);
  });

  it('continues to require manual legacy decoding and retains the default Unicode encoder', () => {
    const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(() => decodeBytes(bytes)).toThrow('手动选择');
    expect(Array.from(encodeText('中文', 'UTF-8'))).toEqual([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
  });

  it('roundtrips the full scalar repertoire except the explicitly refused WHATWG compatibility aliases', () => {
    const refused = new Set([
      0xe5e5, 0xe78d, 0xe78e, 0xe78f, 0xe790, 0xe791, 0xe792, 0xe793, 0xe794, 0xe795, 0xe796,
      0xe81e, 0xe826, 0xe82b, 0xe82c, 0xe832, 0xe843, 0xe854, 0xe864,
    ]);
    const chunks: string[] = [];
    let part = '';
    let count = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff || refused.has(codePoint)) continue;
      part += String.fromCodePoint(codePoint);
      count++;
      if (part.length >= 8192) { chunks.push(part); part = ''; }
    }
    chunks.push(part);
    const text = chunks.join('');
    expect(count).toBe(1_112_045);
    expect(decodeBytes(encodeText(text, 'GB18030'), 'GB18030').text).toBe(text);
    for (const codePoint of refused) {
      expect(() => encodeText(String.fromCodePoint(codePoint), 'GB18030')).toThrow('无损');
    }
  });
});
