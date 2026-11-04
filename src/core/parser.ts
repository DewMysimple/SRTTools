import { createId, newDocument, SubtitleError, type ParseDiagnostic, type ParseResult, type SubtitleCue, type SubtitleFormat } from './models';
import { parseTimestamp, validateCueTime } from './time';

const supportedFormats = new Set<SubtitleFormat>(['srt', 'vtt', 'ass', 'ssa', 'txt', 'csv']);

export function parseSubtitle(input: string, fileName: string): ParseResult {
  const extension = fileName.split('.').pop()?.toLowerCase() as SubtitleFormat;
  if (!supportedFormats.has(extension)) throw new SubtitleError('UNSUPPORTED_FORMAT', '请选择 SRT、VTT、ASS、SSA、CSV 或含时间信息的 TXT 文件。');
  const text = input.replace(/^\ufeff/, '');
  if (/^WEBVTT(?:\s|$)/.test(text.trimStart()) && !['vtt', 'txt'].includes(extension)) {
    throw new SubtitleError('FORMAT_MISMATCH', '文件内容为 WebVTT，但扩展名不匹配。请将扩展名改为 .vtt 后重新导入。');
  }
  if (extension === 'vtt') return parseVtt(text, fileName);
  if (extension === 'csv') return parseCsv(text, fileName);
  if (extension === 'ass' || extension === 'ssa') return parseAss(text, fileName, extension);
  if (extension === 'txt' && !text.includes('-->')) throw new SubtitleError('MISSING_TIMESTAMPS', 'TXT 文件没有可识别的时间信息。请使用带时间行的 SRT 模板；软件不会自动编造时间。');
  return parseSrt(text, fileName, extension);
}

export function parseSrt(text: string, fileName = 'subtitle.srt', format: SubtitleFormat = 'srt'): ParseResult {
  const document = newDocument(fileName, format, text);
  const diagnostics: ParseDiagnostic[] = [];
  const lines = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const headers: { start: number; time: number; index?: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('-->')) continue;
    const hasNumber = i > 0 && /^\s*\d+\s*$/.test(lines[i - 1]);
    // A literal arrow in ordinary subtitle prose is not a timing line.
    if (!hasNumber && !/^\s*\d/.test(lines[i])) continue;
    headers.push({ start: hasNumber ? i - 1 : i, time: i, index: hasNumber ? Number(lines[i - 1].trim()) : undefined });
  }
  if (!text.trim()) {
    diagnostics.push({ severity: 'warning', code: 'EMPTY_FILE', message: '文件为空，没有可处理的字幕。' });
    return { document, diagnostics };
  }
  if (!headers.length) {
    diagnostics.push({ severity: 'error', code: 'INVALID_STRUCTURE', message: '没有找到合法的字幕时间行，请检查文件内容和格式。', line: 1 });
    return { document, diagnostics };
  }
  if (lines.slice(0, headers[0].start).some(line => line.trim())) diagnostics.push({ severity: 'error', code: 'ORPHAN_CONTENT', message: '首条字幕之前有无法解析的内容。', line: 1 });
  const indexes = new Set<number>();
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    const lineNumber = header.time + 1;
    const match = /^\s*(\S+)\s*-->\s*(\S+)\s*$/.exec(lines[header.time]);
    if (!match) {
      diagnostics.push({ severity: 'error', code: 'INVALID_TIME', message: '时间行格式有误，无法恢复此条字幕。', line: lineNumber, cueIndex: header.index });
      continue;
    }
    let startMs: number;
    let endMs: number;
    try { startMs = parseTimestamp(match[1]); endMs = parseTimestamp(match[2]); }
    catch {
      diagnostics.push({ severity: 'error', code: 'INVALID_TIME', message: '无法解析时间，请使用 HH:MM:SS,mmm 格式。', line: lineNumber, cueIndex: header.index });
      continue;
    }
    const index = header.index ?? document.cues.length + 1;
    if (header.index === undefined) diagnostics.push({ severity: 'warning', code: 'MISSING_INDEX', message: '缺少字幕编号，已临时按解析顺序编号。', line: lineNumber, cueIndex: index });
    else if (!Number.isSafeInteger(index) || index < 1) diagnostics.push({ severity: 'warning', code: 'INVALID_INDEX', message: '字幕编号必须为正整数。', line: header.start + 1, cueIndex: index });
    if (indexes.has(index)) diagnostics.push({ severity: 'warning', code: 'DUPLICATE_INDEX', message: '字幕编号重复。', line: header.start + 1, cueIndex: index });
    if (index !== document.cues.length + 1) diagnostics.push({ severity: 'warning', code: 'NONCONTINUOUS_INDEX', message: `编号不连续，按顺序应为 ${document.cues.length + 1}。`, line: header.start + 1, cueIndex: index });
    indexes.add(index);
    const segment = lines.slice(header.time + 1, headers[h + 1]?.start ?? lines.length);
    const blank = segment.findIndex(line => !line.trim());
    const body = blank < 0 ? segment : segment.slice(0, blank);
    if (blank >= 0 && segment.slice(blank + 1).some(line => line.trim())) {
      diagnostics.push({ severity: 'error', code: 'ORPHAN_CONTENT', message: '条目分隔空行之后有无法解析的内容，未并入字幕正文。', line: header.time + blank + 3, cueIndex: index });
    }
    const cue: SubtitleCue = { id: createId(), index, startMs, endMs, text: body.join('\n') };
    document.cues.push(cue);
    const timeError = validateCueTime(cue);
    if (timeError) diagnostics.push({ severity: 'error', code: 'INVALID_CUE_TIME', message: timeError, line: lineNumber, cueIndex: index });
  }
  return { document, diagnostics };
}

function parseVtt(text: string, fileName: string): ParseResult {
  const document = newDocument(fileName, 'vtt', text);
  const diagnostics: ParseDiagnostic[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0].trim()) || lines[0].includes('-->')) throw new SubtitleError('INVALID_VTT', 'VTT 文件必须以 WEBVTT 头开始，头部不能包含时间箭头。');
  let i = 1;
  while (i < lines.length && lines[i].trim()) {
    if (lines[i].includes('-->')) {
      diagnostics.push({ severity: 'error', code: 'INVALID_STRUCTURE', message: 'WEBVTT 头部与字幕之间缺少分隔空行，已尝试恢复字幕。', line: i + 1 });
      break;
    }
    diagnostics.push({ severity: 'warning', code: 'LOSSY_VTT', message: 'VTT 头部元数据不会保留；包含时间映射时请人工核对时间。', line: i + 1 });
    i++;
  }
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const blockStart = i;
    if (/^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[i].trim())) {
      if (!lines[i].startsWith('NOTE')) diagnostics.push({ severity: 'warning', code: 'LOSSY_VTT', message: 'VTT 样式或区域信息不会保留。', line: i + 1 });
      while (i < lines.length && lines[i].trim()) i++;
      continue;
    }
    if (!lines[i].includes('-->')) i++; // Optional cue identifier.
    const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+(.*))?\s*$/.exec(lines[i] ?? '');
    if (!match) {
      diagnostics.push({ severity: 'error', code: 'INVALID_TIME', message: 'VTT 时间行格式有误。', line: blockStart + 1 });
      while (i < lines.length && lines[i].trim()) i++;
      continue;
    }
    const timeLine = i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
    try {
      const vttTime = (value: string) => parseTimestamp(/^\d{2}:\d{2}\.\d{3}$/.test(value) ? `00:${value}` : value);
      const cue = { id: createId(), index: document.cues.length + 1, startMs: vttTime(match[1]), endMs: vttTime(match[2]), text: body.join('\n') };
      document.cues.push(cue);
      if (![match[1], match[2]].every(value => /^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(value))) diagnostics.push({ severity: 'warning', code: 'NONSTANDARD_TIME', message: 'VTT 时间使用了非标准分隔符或毫秒位数，导出时会规范化。', line: timeLine + 1, cueIndex: cue.index });
      if (match[3]) diagnostics.push({ severity: 'warning', code: 'LOSSY_VTT', message: 'VTT cue 的位置、对齐等设置不会保留。', line: timeLine + 1, cueIndex: cue.index });
      const error = validateCueTime(cue);
      if (error) diagnostics.push({ severity: 'error', code: 'INVALID_CUE_TIME', message: error, line: timeLine + 1, cueIndex: cue.index });
    } catch {
      diagnostics.push({ severity: 'error', code: 'INVALID_TIME', message: '无法解析 VTT 时间。', line: timeLine + 1 });
    }
  }
  if (!document.cues.length && !diagnostics.length) diagnostics.push({ severity: 'warning', code: 'EMPTY_FILE', message: 'VTT 文件没有字幕条目。' });
  return { document, diagnostics };
}

export function parseCsvRows(text: string, rowLines?: number[]): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowStartLine = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++;
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closedQuote) throw new SubtitleError('INVALID_CSV', 'CSV 引号位置错误。');
      quoted = true;
    } else if (char === ',') { row.push(field); field = ''; closedQuote = false; }
    else if (char === '\n' || char === '\r') {
      row.push(field); rows.push(row); rowLines?.push(rowStartLine); row = []; field = ''; closedQuote = false;
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++; rowStartLine = line;
    } else {
      if (closedQuote) throw new SubtitleError('INVALID_CSV', 'CSV 引号结束后必须是逗号或换行。');
      field += char;
    }
  }
  if (quoted) throw new SubtitleError('INVALID_CSV', 'CSV 存在未闭合的引号。');
  if (field || row.length || closedQuote) { row.push(field); rows.push(row); rowLines?.push(rowStartLine); }
  return rows;
}

function parseCsv(text: string, fileName: string): ParseResult {
  const document = newDocument(fileName, 'csv', text);
  const diagnostics: ParseDiagnostic[] = [];
  const rowLines: number[] = [];
  const rows = parseCsvRows(text, rowLines);
  const header = rows.shift()?.map(value => value.trim().toLowerCase());
  rowLines.shift();
  if (!header || header.length !== 4 || new Set(header).size !== 4 || !['index', 'start', 'end', 'text'].every(column => header.includes(column))) throw new SubtitleError('INVALID_CSV', 'CSV 首行必须恰好为 index,start,end,text 四列（顺序可调整）；时间使用 HH:MM:SS,mmm。请先移除其他列，避免静默丢失数据。');
  const column = (row: string[], name: string) => row[header.indexOf(name)] ?? '';
  rows.forEach((row, position) => {
    if (row.length === 1 && !row[0]) return;
    if (row.length !== header.length) {
      diagnostics.push({ severity: 'error', code: 'INVALID_CSV', message: 'CSV 行的列数与表头不一致。', line: rowLines[position] });
      return;
    }
    try {
      const indexText = column(row, 'index').trim();
      const index = Number(indexText);
      if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(index) || index < 1) throw new Error('index');
      const cue = { id: createId(), index, startMs: parseTimestamp(column(row, 'start')), endMs: parseTimestamp(column(row, 'end')), text: column(row, 'text').replace(/\r\n?/g, '\n') };
      document.cues.push(cue);
      const error = validateCueTime(cue);
      if (error) diagnostics.push({ severity: 'error', code: 'INVALID_CUE_TIME', message: error, cueIndex: index, line: rowLines[position] });
    } catch {
      diagnostics.push({ severity: 'error', code: 'INVALID_CSV', message: 'CSV 编号或时间格式不正确。', line: rowLines[position] });
    }
  });
  return { document, diagnostics };
}

function parseAss(text: string, fileName: string, format: 'ass' | 'ssa'): ParseResult {
  const document = newDocument(fileName, format, text);
  const diagnostics: ParseDiagnostic[] = [{ severity: 'warning', code: 'LOSSY_ASS', message: '转换为通用字幕模型会丢失字体、颜色、位置、样式、绘图及特效。请核对预览；带绘图模式的条目不支持转换。' }];
  let inEvents = false;
  let columns: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!/^\s*\[Script Info\]/im.test(text)) throw new SubtitleError('INVALID_ASS', 'ASS / SSA 文件缺少 [Script Info]。');
  lines.forEach((line, lineIndex) => {
    if (/^\s*\[/.test(line)) { inEvents = /^\s*\[Events\]\s*$/i.test(line); return; }
    if (!inEvents) return;
    if (/^\s*Format:/i.test(line)) { columns = line.replace(/^\s*Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase()); return; }
    if (!/^\s*Dialogue:/i.test(line)) return;
    if (new Set(columns).size !== columns.length || !columns.includes('start') || !columns.includes('end') || columns[columns.length - 1] !== 'text') {
      diagnostics.push({ severity: 'error', code: 'INVALID_ASS', message: 'Events Format 必须包含 Start、End 且以 Text 列结尾。', line: lineIndex + 1 });
      return;
    }
    const values = line.replace(/^\s*Dialogue:\s*/i, '').split(',');
    if (values.length < columns.length) {
      diagnostics.push({ severity: 'error', code: 'INVALID_ASS', message: 'Dialogue 的字段数量少于 Events Format 定义。', line: lineIndex + 1 });
      return;
    }
    const fields = values.slice(0, columns.length - 1);
    fields.push(values.slice(columns.length - 1).join(','));
    const read = (name: string) => fields[columns.indexOf(name)] ?? '';
    try {
      const time = (value: string) => {
        const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim());
        if (!match) throw new Error('time');
        return parseTimestamp(`${match[1].padStart(2, '0')}:${match[2]}:${match[3]}.${match[4]}0`);
      };
      if (/\{[^}]*\\p[1-9]\d*[^}]*\}/i.test(read('text'))) throw new Error('drawing');
      const cue = { id: createId(), index: document.cues.length + 1, startMs: time(read('start')), endMs: time(read('end')), text: read('text').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, '\u00a0') };
      document.cues.push(cue);
      const error = validateCueTime(cue);
      if (error) diagnostics.push({ severity: 'error', code: 'INVALID_CUE_TIME', message: error, line: lineIndex + 1, cueIndex: cue.index });
    } catch {
      diagnostics.push({ severity: 'error', code: 'INVALID_ASS', message: '此条字幕含无效时间或不支持的绘图模式，无法转换。', line: lineIndex + 1 });
    }
  });
  if (!document.cues.length && diagnostics.length === 1) diagnostics.push({ severity: 'warning', code: 'EMPTY_FILE', message: '没有找到 Dialogue 字幕。' });
  return { document, diagnostics };
}
