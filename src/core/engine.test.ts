import { describe, expect, it } from 'vitest';
import {
  bilingualMerge, cleanSpaces, compareDocuments, decodeBytes, documentStatistics, encodeText,
  formatTimestamp, hasVisibleText, mergeDocuments, newDocument, parseSubtitle, parseTimestamp,
  processDocument, removeDuplicateCues, replaceText, serializeSubtitle, shiftCueTimes, stripHtml,
  validateCueTime, validateDocument, wrapText, type SubtitleCue, type SubtitleDocument,
} from './index';

const srt = '1\n00:00:01,000 --> 00:00:02,500\n你好，world 😀\nsecond line\n\n2\n00:00:03,000 --> 00:00:04,999\n<你好> & "quoted"';
const cue = (index = 1, startMs = 1000, endMs = 2000, text = 'Hello'): SubtitleCue => ({ id: `cue-${index}`, index, startMs, endMs, text });
const doc = (cues: SubtitleCue[] = [cue()]): SubtitleDocument => ({ ...newDocument('input.srt', 'srt'), cues });
const codes = (text: string) => parseSubtitle(text, 'test.srt').diagnostics.map(issue => issue.code);

describe('SRT parser and serializer', () => {
  it('parses standard SRT and preserves Chinese, emoji, symbols and multiline body without trailing blank line', () => {
    const result = parseSubtitle(srt, 'test.srt');
    expect(result.diagnostics).toEqual([]);
    expect(result.document.cues).toHaveLength(2);
    expect(result.document.cues[0]).toMatchObject({ index: 1, startMs: 1000, endMs: 2500, text: '你好，world 😀\nsecond line' });
    expect(result.document.cues[1].text).toBe('<你好> & "quoted"');
  });

  it.each(['\n', '\r\n', '\r'])('accepts %j line endings, BOM, extra spaces and multiple blank separators', ending => {
    const result = parseSubtitle(`\ufeff  \n\n1\n 00:00:01.000  -->   00:00:02.000 \ntext\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nother`.replace(/\n/g, ending), 'a.srt');
    expect(result.document.cues).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.document.lineEnding).toBe(ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF');
  });

  it('recovers missing, duplicate and noncontinuous indexes with separate diagnostics', () => {
    const result = parseSubtitle('00:00:01,000 --> 00:00:02,000\nmissing\n\n1\n00:00:03,000 --> 00:00:04,000\nduplicate\n\n9\n00:00:05,000 --> 00:00:06,000\ngap', 'a.srt');
    expect(result.document.cues.map(item => item.index)).toEqual([1, 1, 9]);
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['MISSING_INDEX', 'DUPLICATE_INDEX', 'NONCONTINUOUS_INDEX']));
    expect(result.document.cues[0].id).not.toBe(result.document.cues[1].id);
  });

  it('recovers later entries after illegal timing without hiding lost content', () => {
    const result = parseSubtitle('1\nbad --> bad\nlost\n\n2\n00:00:03,000 --> 00:00:04,000\nvalid', 'a.srt');
    expect(result.document.cues).toHaveLength(1);
    expect(result.document.cues[0].text).toBe('valid');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_TIME', line: 2 }));
  });

  it('marks trailing incomplete blocks as unrecoverable rather than appending them to previous cue', () => {
    const result = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\ngood\n\n2\nbroken timestamp\ntext', 'a.srt');
    expect(result.document.cues[0].text).toBe('good');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'ORPHAN_CONTENT' }));
  });

  it('retains zero-length and reversed-time cues to allow explicit repair', () => {
    const result = parseSubtitle('1\n00:00:02,000 --> 00:00:01,000\nbad\n\n2\n00:00:03,000 --> 00:00:03,000\nzero', 'a.srt');
    expect(result.document.cues).toHaveLength(2);
    expect(result.diagnostics.filter(item => item.code === 'INVALID_CUE_TIME')).toHaveLength(2);
    expect(() => serializeSubtitle(result.document)).toThrow('结束时间');
  });

  it('retains empty cue, reports empty files and malformed structure', () => {
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\ntext', 'a.srt').document.cues[0].text).toBe('');
    expect(codes('')).toContain('EMPTY_FILE');
    expect(codes('not subtitle content')).toContain('INVALID_STRUCTURE');
  });

  it('does not interpret a literal arrow in prose as a timing header', () => {
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nHello --> world', 'a.srt').document.cues[0].text).toBe('Hello --> world');
  });

  it.each(['LF', 'CRLF'] as const)('round trips subtitle content with standard numbering and %s output', lineEnding => {
    const parsed = parseSubtitle(srt, 'a.srt').document;
    parsed.cues[0].index = 9;
    const { text } = serializeSubtitle(parsed, 'srt', lineEnding);
    expect(text.startsWith('1')).toBe(true);
    const again = parseSubtitle(text, 'b.srt');
    expect(again.diagnostics).toEqual([]);
    expect(again.document.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))).toEqual(parsed.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })));
    expect(text.includes('\r\n')).toBe(lineEnding === 'CRLF');
  });

  it('rejects unsupported extension and extension/content mismatch', () => {
    expect(() => parseSubtitle(srt, 'a.exe')).toThrow('请选择');
    expect(() => parseSubtitle('WEBVTT\n\n00:01.000 --> 00:02.000\ntext', 'a.srt')).toThrow('扩展名');
  });
  it('refuses ambiguous SRT/VTT bodies instead of exporting files that lose text on reimport', () => {
    expect(() => serializeSubtitle(doc([cue(1, 1000, 2000, 'first\n\nsecond')]), 'srt')).toThrow('歧义');
    expect(() => serializeSubtitle(doc([cue(1, 1000, 2000, 'first\n\nsecond')]), 'vtt')).toThrow('歧义');
    expect(() => serializeSubtitle(doc([cue(1, 1000, 2000, '00:00:03,000 --> 00:00:04,000')]), 'srt')).toThrow('歧义');
    expect(serializeSubtitle(doc([cue(1, 1000, 2000, 'first\n\nsecond')]), 'csv').text).toContain('first\n\nsecond');
  });
});

describe('integer millisecond time functions', () => {
  it.each([0, 1, 999, 1000, 59999, 60000, 3599999, 3600000, 86400000, 360000000])('round trips %d ms across boundaries and days', ms => {
    expect(parseTimestamp(formatTimestamp(ms))).toBe(ms);
  });
  it('accepts dot separator and pads partial milliseconds without float accumulation', () => {
    expect(parseTimestamp('01:02:03.4')).toBe(3723400);
    expect(parseTimestamp('00:00:00,01')).toBe(10);
  });
  it.each(['00:60:00,000', '00:00:60,000', '-1:00:00,000', '00:00:01,0000', 'nonsense'])('rejects illegal timestamp %j', value => expect(() => parseTimestamp(value)).toThrow());
  it('rejects negative, fractional, unsafe and invalid cue times', () => {
    expect(() => formatTimestamp(-1)).toThrow();
    expect(() => formatTimestamp(1.5)).toThrow();
    expect(validateCueTime(cue(1, 1000, 1000))).toContain('结束时间');
    expect(validateCueTime(cue(1, 1000, 999))).toContain('结束时间');
    expect(validateCueTime(cue(1, -1, 1000))).toContain('小于');
    expect(validateCueTime(cue(1, 1, Number.MAX_SAFE_INTEGER + 1))).toContain('整数');
  });
  it('shifts forward/backward immutably and preserves stable cue IDs', () => {
    const cues = [cue()];
    expect(shiftCueTimes(cues, 999)[0]).toMatchObject({ id: 'cue-1', startMs: 1999, endMs: 2999 });
    expect(shiftCueTimes(cues, -1000)[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(cues[0].startMs).toBe(1000);
  });
  it('requires explicit negative-time policy and never emits empty intervals', () => {
    expect(() => shiftCueTimes([cue()], -1001)).toThrow();
    expect(shiftCueTimes([cue()], -1500, 'clamp')[0]).toMatchObject({ startMs: 0, endMs: 500 });
    expect(shiftCueTimes([cue()], -2000, 'drop')).toHaveLength(0);
    expect(() => shiftCueTimes([cue()], -2000, 'clamp')).toThrow();
  });
});

describe('text tools preserve timestamps', () => {
  it('uses literal replacement and case-insensitive matching by default', () => {
    expect(replaceText('Hello hello\nHELLO', { find: 'hello', replacement: '$&' })).toBe('$& $&\n$&');
    expect(replaceText('a.b aXb', { find: 'a.b', replacement: 'c' })).toBe('c aXb');
  });
  it('supports case sensitivity and explicit regular expressions', () => {
    expect(replaceText('Hello hello', { find: 'Hello', replacement: 'x', caseSensitive: true })).toBe('x hello');
    expect(replaceText('Hello 123', { find: '(\\d+)', replacement: '[$1]', regex: true })).toBe('Hello [123]');
  });
  it('rejects empty find and malformed regular expressions even for empty documents', () => {
    expect(() => replaceText('abc', { find: '', replacement: 'x' })).toThrow('不能为空');
    expect(() => processDocument(doc([]), 'replace', { find: '[', regex: true })).toThrow('正则');
  });
  it('cleans spaces line by line, and recognizes invisible-only or HTML-only cues', () => {
    expect(cleanSpaces('  hello   world \n  第二行\t\t字  ')).toBe('hello world\n第二行 字');
    expect(hasVisibleText(' <i> </i>\u200b\n\t')).toBe(false);
    expect(hasVisibleText('😀')).toBe(true);
    expect(processDocument(doc([cue(1, 1, 5, ' '), cue(2, 5, 10, '<b></b>'), cue(3, 10, 20, '字')]), 'remove-empty').documents[0].cues).toHaveLength(1);
  });
  it('cleans spaces idempotently while preserving timings, original text and clean cues', () => {
    const input = doc([cue(1, 1, 5, ' 字   幕 '), cue(2, 5, 10, '已经清理')]);
    const first = processDocument(input, 'clean-spaces').documents[0];
    const second = processDocument(first, 'clean-spaces').documents[0];
    expect(first.cues).toEqual([{ ...input.cues[0], text: '字 幕' }, input.cues[1]]);
    expect(second.cues).toEqual(first.cues);
    expect(input.cues[0].text).toBe(' 字   幕 ');
  });
  it('only removes exact duplicate text with selectable consecutive/all scope', () => {
    const cues = [cue(1, 1, 2, 'a'), cue(2, 2, 3, 'a'), cue(3, 3, 4, 'b'), cue(4, 4, 5, 'a')];
    expect(removeDuplicateCues(cues, 'consecutive').map(item => item.index)).toEqual([1, 3, 4]);
    expect(removeDuplicateCues(cues, 'all').map(item => item.index)).toEqual([1, 3]);
  });
  it('strips actual HTML, preserves unknown entities, cautiously decodes known/numeric entities', () => {
    expect(stripHtml('<i>Hello</i><br/>A &amp; B &unknown; &#x1f600; &#55296;')).toBe('Hello\nA & B &unknown; 😀 &#55296;');
    expect(stripHtml('2 < 3 &lt;b&gt;')).toBe('2 < 3 <b>');
  });
  it('wraps by Unicode code points without truncating or splitting emoji surrogate pairs', () => {
    expect(wrapText('中文😀abcdef', 3)).toBe('中文😀\nabc\ndef');
    expect(wrapText('hello world', 6).replace(/\n/g, '')).toBe('hello world');
    expect(() => wrapText('abc', 0)).toThrow();
  });
  it('extracts text with selectable original line breaks and warns about timestamp loss', () => {
    const result = processDocument(parseSubtitle(srt, 'a.srt').document, 'extract', { preserveLines: false });
    expect(result.documents[0].format).toBe('txt');
    expect(serializeSubtitle(result.documents[0]).text).toContain('你好，world 😀 second line');
    expect(serializeSubtitle(result.documents[0]).text).not.toContain('-->');
    expect(result.diagnostics.some(item => item.code === 'LOSSY_TEXT')).toBe(true);
  });
  it('applies case/punctuation/wrap only to text and leaves source immutable', () => {
    const original = doc([cue(1, 1000, 3000, 'hello, world!')]);
    const cased = processDocument(original, 'case', { mode: 'title' }).documents[0];
    const result = processDocument(cased, 'punctuation', { direction: 'zh' }).documents[0];
    expect(result.cues[0]).toMatchObject({ id: original.cues[0].id, startMs: 1000, endMs: 3000, text: 'Hello， World！' });
    expect(original.cues[0].text).toBe('hello, world!');
  });
});

describe('merge, compare and split tools', () => {
  const first = doc([cue(1, 5000, 6000, 'a'), cue(2, 7000, 8000, 'b')]);
  const second = doc([cue(1, 1000, 2000, 'A'), cue(2, 3000, 4000, 'B')]);

  it('merges by file order or start time while retaining absolute times', () => {
    expect(mergeDocuments([first, second], 'file').cues.map(item => item.text)).toEqual(['a', 'b', 'A', 'B']);
    expect(mergeDocuments([first, second], 'time').cues.map(item => item.startMs)).toEqual([1000, 3000, 5000, 7000]);
    expect(first.cues[0].index).toBe(1);
    expect(new Set(mergeDocuments([first, first]).cues.map(item => item.id)).size).toBe(4);
  });
  it('matches bilingual entries by index, supports reverse text order, preserves unmatched rows', () => {
    const result = bilingualMerge(first, doc([cue(1, 5000, 6000, '甲'), cue(3, 9000, 10000, '丙')]), { mode: 'index', toleranceMs: 0, reverse: true });
    expect(result.matched).toBe(1);
    expect(result.unmatchedFirst).toBe(1);
    expect(result.unmatchedSecond).toBe(1);
    expect(result.document.cues.map(item => item.text)).toEqual(['甲\na', 'b', '丙']);
    expect(result.diagnostics).toHaveLength(2);
  });
  it('uses nearest one-to-one bilingual time matches within inclusive tolerance', () => {
    const result = bilingualMerge(first, doc([cue(4, 5050, 6500, '甲'), cue(7, 7099, 8500, '乙')]), { mode: 'time', toleranceMs: 50 });
    expect(result.matched).toBe(1);
    expect(result.unmatchedFirst).toBe(1);
    expect(result.unmatchedSecond).toBe(1);
    const noReuse = bilingualMerge(doc([cue(1, 1000, 2000), cue(2, 1001, 2000)]), doc([cue(1, 1000, 2000)]), { mode: 'time', toleranceMs: 5 });
    expect(noReuse.matched).toBe(1);
  });
  it('splits by count with normalized indexes and unique output names', () => {
    const result = processDocument(mergeDocuments([first, second]), 'split-count', { count: 3 });
    expect(result.documents.map(item => item.cues.length)).toEqual([3, 1]);
    expect(result.documents.map(item => item.fileName)).toEqual(['merged_part01.srt', 'merged_part02.srt']);
    expect(result.documents[1].cues[0].index).toBe(1);
  });
  it('splits across a cue at a time point and optionally rebases the second part', () => {
    const result = processDocument(doc([cue(1, 1000, 3000, 'cross')]), 'split-time', { timeMs: 2000, resetTime: true });
    expect(result.documents[0].cues[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(result.documents[1].cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(() => processDocument(first, 'split-time', { timeMs: 100 })).toThrow('前后');
  });
  it('compares text, time tolerance and missing entries by row without silently aligning', () => {
    const result = compareDocuments(first, doc([cue(1, 5050, 6050, 'changed')]), 50);
    expect(result.map(item => item.code)).toEqual(['TEXT_DIFFERENT', 'MISSING_CUE']);
    expect(compareDocuments(first, first)).toEqual([]);
  });
});

describe('format conversions', () => {
  it('converts SRT to valid WEBVTT with period separators, and round trips body/time', () => {
    const source = parseSubtitle(srt, 'a.srt').document;
    const serialized = serializeSubtitle(source, 'vtt');
    expect(serialized.text.startsWith('WEBVTT\n\n')).toBe(true);
    expect(serialized.text).toContain('00:00:01.000 --> 00:00:02.500');
    expect(parseSubtitle(serialized.text, 'a.vtt').document.cues.map(item => item.text)).toEqual(source.cues.map(item => item.text));
  });
  it('handles VTT identifiers, short timestamps, metadata blocks and settings with a loss warning', () => {
    const result = parseSubtitle('WEBVTT - title\nLanguage: en\n\nNOTE ignored\nanything\n\nSTYLE\n::cue {color: red}\n\nidentifier\n00:01.000 --> 00:02.000 align:start position:10%\nHello\nWorld\n', 'a.vtt');
    expect(result.document.cues[0]).toMatchObject({ startMs: 1000, endMs: 2000, text: 'Hello\nWorld' });
    expect(result.diagnostics.filter(item => item.code === 'LOSSY_VTT')).toHaveLength(3);
  });
  it('rejects VTT without WEBVTT header', () => expect(() => parseSubtitle(srt, 'a.vtt')).toThrow('WEBVTT'));
  it('recovers VTT cues after a missing header separator but blocks silent content loss with an error', () => {
    const parsed = parseSubtitle('WEBVTT\n00:00:01.000 --> 00:00:02.000\nrecover me', 'a.vtt');
    expect(parsed.document.cues).toHaveLength(1);
    expect(parsed.document.cues[0].text).toBe('recover me');
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_STRUCTURE', line: 2 }));
  });
  it('warns when nonstandard VTT milliseconds are normalized', () => {
    const parsed = parseSubtitle('WEBVTT\n\n00:00:01,0 --> 00:00:02.00\ntext', 'a.vtt');
    expect(parsed.document.cues[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'NONSTANDARD_TIME' }));
  });
  it('round trips CSV including quotes, commas, CRLF and embedded newlines', () => {
    const source = doc([cue(1, 1, 999, 'text,"quoted"\n中文😀'), cue(2, 1000, 2000, '')]);
    const csv = serializeSubtitle(source, 'csv', 'CRLF').text;
    expect(csv).toContain('"text,""quoted""\r\n中文😀"');
    const parsed = parseSubtitle(csv, 'a.csv');
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.cues.map(item => item.text)).toEqual(source.cues.map(item => item.text));
  });
  it.each(['index,start,end,text\n1,"unclosed', 'bad,header\n1,2', 'index,start,end,text\n1,"a"z,3,x'])('rejects malformed CSV %j', input => {
    expect(() => parseSubtitle(input, 'a.csv')).toThrow();
  });
  it('diagnoses CSV rows with an incorrect column count without hiding loss', () => {
    expect(parseSubtitle('index,start,end,text\n1,2,3,4,5', 'a.csv').diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_CSV', severity: 'error' }));
  });
  it.each(['index,start,end,text,note', 'index,start,end,text,start'])('refuses CSV extra/duplicate columns instead of silently dropping them: %s', header => {
    expect(() => parseSubtitle(`${header}\n1,"00:00:01,000","00:00:02,000",text,extra`, 'a.csv')).toThrow('避免静默丢失数据');
  });
  it('uses physical CSV line numbers after embedded quoted newlines', () => {
    const parsed = parseSubtitle('index,start,end,text\r\n1,"00:00:01,000","00:00:02,000","first\r\nsecond"\r\n2,bad,bad,text', 'a.csv');
    expect(parsed.document.cues[0].text).toBe('first\nsecond');
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_CSV', line: 4 }));
  });
  it.each(['ass', 'ssa'] as const)('imports %s styles as plain subtitle text and declares loss', extension => {
    const result = parseSubtitle('[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.23,0:00:03.45,Default,{\\b1}Hello, world\\N你好', `a.${extension}`);
    expect(result.document.cues[0]).toMatchObject({ startMs: 1230, endMs: 3450, text: 'Hello, world\n你好' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_ASS', severity: 'warning' }));
  });
  it('rejects unsupported ASS drawing events with a parse error instead of outputting vector commands as text', () => {
    const result = parseSubtitle('[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,{\\p1}m 0 0 l 10 10', 'a.ass');
    expect(result.document.cues).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_ASS', severity: 'error' }));
  });
  it('does not misclassify literal ASS paths containing \\p1 as drawing commands', () => {
    const parsed = parseSubtitle('[Script Info]\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,C:\\p1\\photos', 'a.ass');
    expect(parsed.document.cues[0].text).toBe('C:\\p1\\photos');
    expect(parsed.diagnostics.some(item => item.severity === 'error')).toBe(false);
  });
  it('diagnoses ASS dialogue fields missing from the declared format', () => {
    const parsed = parseSubtitle('[Script Info]\n[Events]\nFormat: Start, End, Style, Text\nDialogue: 0:00:01.00,0:00:02.00,Default', 'a.ass');
    expect(parsed.document.cues).toHaveLength(0);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_ASS', line: 4 }));
  });
  it('exports ASS with default style and verified centisecond precision', () => {
    const output = serializeSubtitle(doc([cue(1, 1234, 2345, 'Hello\n你好')]), 'ass');
    expect(output.warnings.join()).toContain('10 毫秒');
    expect(parseSubtitle(output.text, 'a.ass').document.cues[0]).toMatchObject({ startMs: 1230, endMs: 2350, text: 'Hello\n你好' });
    expect(() => serializeSubtitle(doc([cue(1, 1, 2)]), 'ass')).toThrow('精度');
  });
  it('TXT without timestamps is rejected; recognizable timing can be imported without invention', () => {
    expect(() => parseSubtitle('plain\ntext', 'a.txt')).toThrow('不会自动编造时间');
    expect(parseSubtitle(srt, 'a.txt').document.cues).toHaveLength(2);
  });
});

describe('detection and explicit repair policies', () => {
  it('detects duplicate indexes, reversed/overlapping times, invisible text, suspect encoding and excessive lengths/durations', () => {
    const source = doc([cue(2, 1000, 20000, 'A'.repeat(43)), cue(2, 100, 200, ''), cue(9, 300, 200, '\ufffd'), cue(4, 2000, 3000, 'A'.repeat(43))]);
    const result = validateDocument(source).map(item => item.code);
    expect(result).toEqual(expect.arrayContaining(['NONCONTINUOUS_INDEX', 'DUPLICATE_INDEX', 'TIME_REVERSED', 'OVERLAP', 'EMPTY_CUE', 'SUSPECT_ENCODING', 'TEXT_TOO_LONG', 'DURATION_SHORT', 'DURATION_LONG', 'INVALID_CUE_TIME', 'DUPLICATE_TEXT']));
  });
  it('default repair only removes empty cues and renumbers; invalid time stays visible', () => {
    const source = doc([cue(4, 0, 1000, ' '), cue(9, 3000, 2000, 'bad')]);
    const result = processDocument(source, 'repair');
    expect(result.documents[0].cues).toEqual([{ ...source.cues[1], index: 1 }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_CUE_TIME' }));
    expect(() => serializeSubtitle(result.documents[0])).toThrow();
  });
  it('distinguishes reversed row order from true overlapping intervals', () => {
    const reversed = validateDocument(doc([cue(1, 5000, 6000), cue(2, 1000, 2000)]));
    expect(reversed.map(issue => issue.code)).toContain('TIME_REVERSED');
    expect(reversed.map(issue => issue.code)).not.toContain('OVERLAP');
    const realOverlap = validateDocument(doc([cue(1, 5000, 8000), cue(2, 1000, 6000)]));
    expect(realOverlap).toContainEqual(expect.objectContaining({ code: 'OVERLAP', cueIndex: 1 }));
  });
  it('allows explicit invalid-time extension/deletion and rechecks remaining overlaps', () => {
    const source = doc([cue(1, 1000, 500, 'bad'), cue(2, 1500, 3000, 'second')]);
    const result = processDocument(source, 'repair', { invalidTime: 'extend', durationMs: 1000 });
    expect(result.documents[0].cues[0].endMs).toBe(2000);
    expect(result.diagnostics.some(item => item.code === 'OVERLAP')).toBe(true);
    expect(processDocument(source, 'repair', { invalidTime: 'drop' }).documents[0].cues).toHaveLength(1);
  });
  it('trims overlaps only with explicit policy and refuses ambiguous equal starts', () => {
    expect(processDocument(doc([cue(1, 1000, 3000), cue(2, 2000, 4000)]), 'repair', { overlap: 'trim' }).documents[0].cues[0].endMs).toBe(2000);
    expect(() => processDocument(doc([cue(1, 1000, 3000), cue(2, 1000, 4000)]), 'repair', { overlap: 'trim' })).toThrow('无法裁短');
  });
  it('crops to a range, clips boundary cues and optionally rebases time', () => {
    const result = processDocument(doc([cue(1, 1000, 3000), cue(2, 5000, 7000)]), 'crop', { startMs: 2000, endMs: 6000, resetTime: true });
    expect(result.documents[0].cues.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[0, 1000], [3000, 4000]]);
    expect(() => processDocument(doc(), 'crop', { startMs: 5000, endMs: 6000 })).toThrow('没有字幕');
  });
  it('adjusts durations with validation and reports newly caused overlaps', () => {
    const source = doc([cue(1, 1000, 2000), cue(2, 2500, 3500)]);
    expect(() => processDocument(source, 'duration', { deltaMs: -1000 })).toThrow('时间无效');
    expect(processDocument(source, 'duration', { deltaMs: -1000, policy: 'drop' }).documents[0].cues).toHaveLength(0);
    expect(processDocument(source, 'min-duration', { durationMs: 2000 }).diagnostics.some(item => item.code === 'OVERLAP')).toBe(true);
    expect(processDocument(source, 'max-duration', { durationMs: 500 }).documents[0].cues[0].endMs).toBe(1500);
    expect(processDocument(source, 'duration', { deltaMs: 1000 }).diagnostics).toContainEqual(expect.objectContaining({ code: 'OVERLAP' }));
  });
  it('summarizes Unicode character counts and time span', () => {
    expect(documentStatistics(doc([cue(1, 1000, 2000, '中 😀\nA'), cue(2, 3000, 5000, 'B')]))).toEqual({ cues: 2, characters: 4, startMs: 1000, endMs: 5000, spanMs: 4000 });
  });
  it('validates parameter types and unsupported operations', () => {
    expect(() => processDocument(doc(), 'shift', { offsetMs: '1000' })).toThrow();
    expect(() => processDocument(doc(), 'split-count', { count: 0 })).toThrow();
    expect(() => processDocument(doc(), 'unknown')).toThrow('不支持此操作');
  });
});

describe('encoding integrity', () => {
  const text = '中文，English 😀\r\n第二行';
  it.each(['UTF-8', 'UTF-8 BOM', 'UTF-16 LE', 'UTF-16 BE'])('round trips and automatically recognizes %s without corrupting emoji', encoding => {
    const bytes = encodeText(text, encoding);
    const decoded = decodeBytes(bytes);
    expect(decoded.text).toBe(text);
    expect(decoded.encoding).toBe(encoding);
    expect(decoded.confidence).toBe('high');
  });
  it('supports explicit no-BOM UTF-16 and marks heuristically detected UTF-16 as uncertain', () => {
    const bytes = encodeText('ASCII header and 中文\nsecond line', 'UTF-16 LE').slice(2);
    expect(decodeBytes(bytes, 'UTF-16 LE').text).toBe('ASCII header and 中文\nsecond line');
    const guessed = decodeBytes(bytes);
    expect(guessed.encoding).toBe('UTF-16 LE');
    expect(guessed.confidence).toBe('low');
    expect(guessed.warnings).toHaveLength(1);
  });
  it('requires manual selection for GBK and verifies known GBK/GB18030 byte fixtures', () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    expect(() => decodeBytes(gbk)).toThrow('手动选择');
    expect(decodeBytes(gbk, 'GBK').text).toBe('中文');
    expect(decodeBytes(new Uint8Array([0x94, 0x39, 0xfc, 0x36]), 'GB18030').text).toBe('😀');
    expect(() => encodeText('中文', 'GBK')).toThrow('暂不支持无损导出');
  });
  it('reports preexisting Unicode replacement characters in UTF-8 without BOM, plus NUL after a manual override', () => {
    expect(decodeBytes(new TextEncoder().encode('already damaged �')).warnings.join()).toContain('替代字符');
    expect(decodeBytes(new TextEncoder().encode('abc\0def'), 'UTF-8').warnings.join()).toContain('空字符');
  });
  it('rejects malformed Unicode rather than silently replacing characters', () => {
    expect(() => decodeBytes(new Uint8Array([0xff, 0xfe, 0x00]), 'UTF-16 LE')).toThrow();
    expect(() => encodeText('\ud800', 'UTF-8')).toThrow('不完整');
    expect(() => encodeText('\udc00', 'UTF-16 LE')).toThrow('不完整');
  });
});
