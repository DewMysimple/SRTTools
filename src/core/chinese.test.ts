import { describe, expect, it } from 'vitest';
import { convertChineseText } from './chinese';

describe('local dictionary Chinese conversion', () => {
  it('uses phrase mappings for ambiguous simplified words and the generic traditional direction', () => {
    const simplified = '头发 理发 发现 干杯 干部 后面 皇后';
    const traditional = '頭髮 理髮 發現 乾杯 幹部 後面 皇后';
    expect(convertChineseText(simplified, 's2t')).toBe(traditional);
    expect(convertChineseText(traditional, 't2s')).toBe(simplified);
  });

  it.each(['', 'English 123 😀', '123\r\nEnglish', '👩🏽‍💻 e\u0301'])('leaves non-Chinese content intact', text => {
    expect(convertChineseText(text, 's2t')).toBe(text);
  });

  it('preserves VTT inline timestamps and plain mathematical less-than signs', () => {
    expect(convertChineseText('1 < 2，头发 <00:01.234>发现', 's2t')).toBe('1 < 2，頭髮 <00:01.234>發現');
  });

  it('preserves mixed tags, comments, ASS controls, placeholders and the original newline sequences', () => {
    const text = '<i title="头发 > 简体">发现</i> {\\fn微软雅黑\\an8}头发\\N理发 {姓名} {{变量}} ${名称} %(名称)s %02d\r\n<!--头发-->English 42 😀\r后面\n皇后';
    expect(convertChineseText(text, 's2t')).toBe(
      '<i title="头发 > 简体">發現</i> {\\fn微软雅黑\\an8}頭髮\\N理髮 {姓名} {{变量}} ${名称} %(名称)s %02d\r\n<!--头发-->English 42 😀\r後面\n皇后',
    );
  });

  it('is stable when repeating the same direction, and keeps the opposite direction explicit', () => {
    for (const direction of ['s2t', 't2s'] as const) {
      const result = convertChineseText('头发 頭髮 干部 幹部 皇后', direction);
      expect(convertChineseText(result, direction)).toBe(result);
    }
    expect(() => convertChineseText('文字', 'tw' as 's2t')).toThrow('转换方向');
  });

  it.each(['<font title="未闭合>头发', '{\\fn字体', '{{名称}', '%(名称', '<!--未闭合'])(
    'rejects malformed recognized control syntax without silently changing it', text => {
      expect(() => convertChineseText(text, 's2t')).toThrow('标记');
    },
  );
});
