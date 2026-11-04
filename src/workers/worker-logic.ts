import {
  bilingualMerge, compareDocuments, decodeBytes, encodeText, mergeDocuments,
  parseSubtitle, processDocument, serializeSubtitle, StrictEncodingError, SubtitleError,
} from '../core';
import type { ParseDiagnostic, SubtitleCue, SubtitleDocument } from '../core';
import { safeFileName, uniqueOutputNames } from '../services/export-service';
import type { ImportedFile } from '../services/file-service';
import type { ProcessedOutput, ProcessedTask, ProcessingOptions, ProcessingRequest } from '../services/processing-service';
import { validateFileNamePattern } from '../services/settings-service';
import { convertChineseSubtitle } from '../core/chinese-subtitle';
import type { SubtitleBodySpan } from '../core/parser';
import { buildSubtitleDiff } from '../core/diff/subtitle-diff';

interface ImportedDocument {
  document: SubtitleDocument;
  diagnostics: ParseDiagnostic[];
  uncertainEncoding: boolean;
  sourceText?: string;
  bodySpans?: SubtitleBodySpan[];
}

function uniqueDiagnostics(diagnostics: ParseDiagnostic[]): ParseDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.cueIndex, diagnostic.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readDocument(file: ImportedFile, options: ProcessingOptions, captureBodies = false): ImportedDocument {
  if (file.error) throw new SubtitleError('READ_FAILED', file.error);
  const decoded = decodeBytes(file.bytes, options.encoding);
  const suspectEncoding = decoded.text.includes('\ufffd') || decoded.text.includes('\0');
  const parsed = parseSubtitle(decoded.text, file.name, { captureBodies });
  parsed.document.encoding = decoded.encoding;
  if (file.path) parsed.document.sourcePath = file.path;
  return {
    document: parsed.document,
    diagnostics: [
      ...decoded.warnings.map((message): ParseDiagnostic => ({ severity: 'warning', code: 'ENCODING_WARNING', message })),
      ...(suspectEncoding ? [{ severity: 'warning' as const, code: 'SUSPECT_ENCODING', message: '文本包含替代字符或空字符，可能已有编码损失。请核对预览并手动选择输入编码后再导出。' }] : []),
      ...parsed.diagnostics,
    ],
    uncertainEncoding: (decoded.confidence === 'low' || suspectEncoding) && (!options.encoding || options.encoding === 'auto'),
    ...(captureBodies ? { sourceText: decoded.text, bodySpans: parsed.bodySpans } : {}),
  };
}

function outputName(fileName: string, extension: string, options: ProcessingOptions, index = 1): string {
  validateFileNamePattern(options.fileNamePattern);
  const base = fileName.replace(/\.[^.]+$/u, '');
  const rendered = options.fileNamePattern.replace(/\{name\}|\{index\}/gu, token => token === '{name}' ? base : String(index));
  return safeFileName(`${rendered}.${extension}`);
}

function stats(document: SubtitleDocument) {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const cue of document.cues) {
    if (Number.isFinite(cue.startMs)) startMs = Math.min(startMs, cue.startMs);
    if (Number.isFinite(cue.endMs)) endMs = Math.max(endMs, cue.endMs);
  }
  return {
    fileName: document.fileName,
    format: document.format,
    encoding: document.encoding,
    lineEnding: document.lineEnding,
    cueCount: document.cues.length,
    characterCount: document.cues.reduce((count, cue) => count + Array.from(cue.text).length, 0),
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs: Number.isFinite(endMs) ? endMs : 0,
    spanMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0,
  };
}

function reportOutput(fileName: string, payload: unknown, options: ProcessingOptions, inputIndex = 1): ProcessedOutput {
  const text = JSON.stringify(payload, null, 2).replace(/\n/gu, options.lineEnding === 'CRLF' ? '\r\n' : '\n');
  const name = outputName(fileName, 'json', options, inputIndex);
  return { name, text, bytes: encodeOutput(text, options.outputEncoding, name) };
}

function encodeOutput(text: string, encoding: string, fileName: string, cues?: readonly SubtitleCue[]): Uint8Array {
  if (/^gb(?:k|18030)$/iu.test(encoding.replace(/[\s_-]/gu, ''))) {
    for (const cue of cues ?? []) {
      try { encodeText(cue.text, encoding); }
      catch (error) {
        if (!(error instanceof StrictEncodingError)) throw error;
        throw new SubtitleError(error.code, `第 ${cue.index} 条字幕：${error.message}`);
      }
    }
  }
  try {
    return encodeText(text, encoding);
  } catch (error) {
    if (!(error instanceof StrictEncodingError)) throw error;
    let location = '输出头部或报告元数据';
    if (!fileName.toLowerCase().endsWith('.json')) {
      try {
        const parsed = parseSubtitle(text, fileName, { captureBodies: true });
        const position = parsed.bodySpans?.findIndex(span => error.offset >= span.start && error.offset < span.end) ?? -1;
        if (position >= 0) location = `第 ${parsed.document.cues[position].index} 条字幕`;
      } catch { /* Plain TXT output has no subtitle timing structure. */ }
    }
    throw new SubtitleError(error.code, `${location}：${error.message}`);
  }
}

function assertCanExport(input: ImportedDocument, operation: string): void {
  if (input.uncertainEncoding) {
    throw new SubtitleError('UNCERTAIN_ENCODING', '编码检测结果不确定。请核对字幕预览，并手动选择文件编码后重新处理。');
  }
  const errors = input.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  // Time errors preserve all cues and may be handled by an explicitly selected repair strategy.
  const unresolved = operation === 'repair'
    ? errors.filter((diagnostic) => diagnostic.code !== 'INVALID_CUE_TIME')
    : errors;
  if (unresolved.length > 0) {
    throw new SubtitleError('PARSE_ERRORS', '文件包含解析错误。请先查看字幕检测结果；为防止丢失内容，本次没有生成字幕文件。');
  }
  if (!input.document.cues.length) {
    throw new SubtitleError('EMPTY_DOCUMENT', '文件没有可处理的字幕条目，请检查源文件或先运行字幕检测。');
  }
}

function serializeDocuments(documents: SubtitleDocument[], options: ProcessingOptions, inputIndex = 1): { outputs: ProcessedOutput[]; diagnostics: ParseDiagnostic[] } {
  const diagnostics: ParseDiagnostic[] = [];
  const outputs = documents.map((document): ProcessedOutput => {
    const result = serializeSubtitle(document, document.format, options.lineEnding);
    diagnostics.push(...result.warnings.map((message): ParseDiagnostic => ({ severity: 'warning', code: 'LOSSY_CONVERSION', message })));
    const name = outputName(document.fileName, document.format, options, inputIndex);
    return {
      name,
      text: result.text,
      bytes: encodeOutput(result.text, options.outputEncoding, name, result.previewCues ?? document.cues),
      document: result.previewCues && { ...document, cues: result.previewCues, lineEnding: options.lineEnding },
    };
  });
  return { outputs: uniqueOutputNames(outputs), diagnostics };
}

function executeFile(request: ProcessingRequest, task: ProcessedTask): ProcessedTask {
  const file = request.files[0];
  const inputIndex = request.options.fileIndexes?.[file.id] ?? 1;
  const input = readDocument(file, request.options, request.operation === 'chinese');
  task.document = input.document;
  task.diagnostics = input.diagnostics;
  if (request.operation === 'info') {
    task.summary = `${input.document.cues.length} 条字幕，文件大小 ${file.size} 字节`;
    task.outputs = [reportOutput(file.name, { ...stats(input.document), inputBytes: file.size, diagnostics: task.diagnostics }, request.options, inputIndex)];
    return { ...task, status: 'success' };
  }
  if (request.operation === 'detect') {
    const result = processDocument(input.document, 'detect', request.params);
    task.diagnostics = uniqueDiagnostics([...task.diagnostics, ...result.diagnostics]);
    task.summary = `检测完成：${task.diagnostics.filter((item) => item.severity === 'error').length} 个错误，${task.diagnostics.filter((item) => item.severity === 'warning').length} 个提醒`;
    task.outputs = [reportOutput(file.name, { ...stats(input.document), summary: task.summary, diagnostics: task.diagnostics }, request.options, inputIndex)];
    return { ...task, status: 'success' };
  }
  assertCanExport(input, request.operation);
  if (request.operation === 'chinese') {
    const direction = request.params.direction ?? 's2t';
    if (direction !== 's2t' && direction !== 't2s') throw new SubtitleError('INVALID_PARAMETER', '简繁转换方向不受支持。');
    const result = convertChineseSubtitle(input.sourceText!, {
      document: input.document, diagnostics: input.diagnostics, bodySpans: input.bodySpans,
    }, direction);
    const name = outputName(file.name, input.document.format, request.options, inputIndex);
    task.outputs = [{
      name,
      text: result.text,
      bytes: encodeOutput(result.text, request.options.outputEncoding, name, result.document.cues),
      document: result.document,
    }];
    task.diagnostics = task.diagnostics.filter(diagnostic => diagnostic.code !== 'LOSSY_ASS' && diagnostic.code !== 'LOSSY_VTT')
      .map(diagnostic => diagnostic.code === 'NONSTANDARD_TIME' ? { ...diagnostic, message: '原时间行使用非标准格式，本次保留原样。' } : diagnostic);
    if (input.document.format === 'ass' || input.document.format === 'ssa') {
      task.diagnostics.push({ severity: 'info', code: 'ASS_PREVIEW', message: '输出保留原样式和控制标记；预览仅显示通用字幕正文，不呈现样式效果。' });
    }
    const changed = result.document.cues.filter((cue, position) => cue.text !== input.document.cues[position].text).length;
    task.summary = `简繁转换完成：${changed} / ${input.document.cues.length} 条正文变化；保留编号、时间、原换行与格式布局。`;
    return { ...task, status: 'success' };
  }
  const result = request.operation === 'encoding' || request.operation === 'rename'
    ? { documents: [input.document], diagnostics: [] as ParseDiagnostic[], summary: '已按导出编码、换行和命名规则规范化字幕' }
    : processDocument(input.document, request.operation, request.params);
  const serialized = serializeDocuments(result.documents, request.options, inputIndex);
  task.outputs = serialized.outputs;
  if (request.operation === 'repair') {
    task.inputDiagnostics = task.diagnostics;
    task.diagnostics = [
      ...task.diagnostics.filter((diagnostic) => /^(ENCODING_WARNING|SUSPECT_ENCODING|LOSSY_)/u.test(diagnostic.code)),
      ...result.diagnostics, ...serialized.diagnostics,
    ];
  } else {
    task.diagnostics = [...task.diagnostics, ...result.diagnostics, ...serialized.diagnostics];
  }
  task.summary = result.summary;
  return { ...task, status: 'success' };
}

function executeCombined(request: ProcessingRequest, task: ProcessedTask): ProcessedTask {
  if (request.files.length < 2) throw new SubtitleError('INVALID_PARAMS', '请至少选择两个字幕文件。');
  if (request.operation !== 'merge' && request.files.length !== 2) throw new SubtitleError('INVALID_PARAMS', '双语合并和字幕对比需要恰好两个文件，请调整文件列表。');
  const inputs: ImportedDocument[] = [];
  for (const file of request.files) {
    try {
      const input = readDocument(file, request.options);
      inputs.push(input);
      task.diagnostics.push(...input.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${file.name}：${diagnostic.message}` })));
      task.document = {
        ...inputs[0].document,
        fileName: `${inputs.length} 份输入字幕`,
        sourcePath: undefined,
        cues: inputs.flatMap((item) => item.document.cues),
      };
    } catch (error) {
      const code = error instanceof SubtitleError ? error.code : 'READ_FAILED';
      const message = `${file.name}：${error instanceof Error ? error.message : '文件无法读取。'}`;
      task.diagnostics.push({ severity: 'error', code, message });
      throw new SubtitleError(code, message);
    }
  }
  if (request.operation === 'compare') {
    const toleranceMs = Number(request.params.toleranceMs ?? 0);
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new SubtitleError('INVALID_PARAMS', '时间容差必须是非负整数毫秒。');
    task.diagnostics.push(...compareDocuments(inputs[0].document, inputs[1].document, toleranceMs));
    task.summary = `对比完成，共 ${task.diagnostics.length} 条问题或差异`;
    const [before, after] = inputs.map(input => input.document);
    const unavailable = inputs.some(input => input.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
      ? 'input-errors' : inputs.some(input => input.uncertainEncoding) ? 'uncertain-encoding' : undefined;
    const logical = unavailable ? undefined : buildSubtitleDiff(before.cues, after.cues, { trustIds: false, timeToleranceMs: toleranceMs });
    const visualComparison = !logical
      ? { mode: 'logical', timeToleranceMs: toleranceMs, kind: 'unavailable', reason: unavailable }
      : logical.kind === 'aligned'
      ? { mode: 'logical', timeToleranceMs: toleranceMs, kind: logical.kind, summary: logical.summary }
      : { mode: 'logical', timeToleranceMs: toleranceMs, kind: logical.kind, beforeCount: logical.beforeCount, afterCount: logical.afterCount, reason: logical.reason };
    task.outputs = [reportOutput('comparison.json', {
      files: inputs.map((input) => stats(input.document)), summary: task.summary, diagnostics: task.diagnostics,
      visualComparison,
    }, request.options)];
    if (unavailable) task.comparisonUnavailable = unavailable;
    else task.comparison = { before, after, toleranceMs };
    return { ...task, status: 'success' };
  }
  inputs.forEach((input, index) => {
    try { assertCanExport(input, request.operation); }
    catch (error) {
      throw new SubtitleError(error instanceof SubtitleError ? error.code : 'PARSE_ERRORS', `${request.files[index].name}：${error instanceof Error ? error.message : '无法处理此文件。'}`);
    }
  });
  let document: SubtitleDocument;
  if (request.operation === 'merge') {
    const strategy = request.params.strategy ?? 'file';
    if (strategy !== 'file' && strategy !== 'time') throw new SubtitleError('INVALID_PARAMS', '请选择按文件顺序或按时间排序合并。');
    document = mergeDocuments(inputs.map((input) => input.document), strategy);
    task.summary = `已合并 ${inputs.length} 个文件，共 ${document.cues.length} 条字幕；保留原始时间`;
  } else if (request.operation === 'bilingual') {
    const mode = request.params.mode ?? 'time';
    const toleranceMs = Number(request.params.toleranceMs ?? 500);
    if (mode !== 'index' && mode !== 'time') throw new SubtitleError('INVALID_PARAMS', '请选择按编号或开始时间匹配。');
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new SubtitleError('INVALID_PARAMS', '时间容差必须是非负整数毫秒。');
    const result = bilingualMerge(inputs[0].document, inputs[1].document, { mode, toleranceMs, reverse: request.params.reverse === true });
    document = result.document;
    task.diagnostics.push(...result.diagnostics);
    task.summary = `已匹配 ${result.matched} 条；首份未匹配 ${result.unmatchedFirst} 条，第二份未匹配 ${result.unmatchedSecond} 条（均保留）`;
  } else {
    throw new SubtitleError('UNSUPPORTED_OPERATION', '暂不支持此组合操作。');
  }
  const result = serializeDocuments([document], request.options);
  task.outputs = result.outputs;
  task.diagnostics.push(...result.diagnostics);
  return { ...task, status: 'success' };
}

/** Pure worker entry point, also used for meaningful integration tests without a browser. */
export function executeProcessingRequest(request: ProcessingRequest): ProcessedTask {
  if (!request.files[0]) throw new SubtitleError('INVALID_PARAMS', '请先选择字幕文件。');
  const task: ProcessedTask = {
    id: request.files[0].id,
    inputName: request.files[0].name,
    inputSize: request.files[0].size,
    status: 'queued', diagnostics: [], outputs: [], summary: '等待处理',
  };
  if (request.kind === 'combined') {
    task.inputName = request.files.map((file) => file.name).join(' + ');
    task.inputSize = request.files.reduce((sum, file) => sum + file.size, 0);
  }
  try {
    return request.kind === 'combined' ? executeCombined(request, task) : executeFile(request, task);
  } catch (error) {
    return {
      ...task,
      status: 'failed',
      outputs: [],
      summary: '处理失败，原文件未修改',
      errorMessage: error instanceof Error ? error.message : '处理失败，请检查文件和参数。',
      errorCode: error instanceof SubtitleError ? error.code : 'PROCESSING_FAILED',
    };
  }
}
