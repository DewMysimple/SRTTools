import {
  bilingualMerge, compareDocuments, decodeBytes, encodeText, mergeDocuments,
  parseSubtitle, processDocument, serializeSubtitle, SubtitleError,
} from '../core';
import type { ParseDiagnostic, SubtitleDocument } from '../core';
import { safeFileName, uniqueOutputNames } from '../services/export-service';
import type { ImportedFile } from '../services/file-service';
import type { ProcessedOutput, ProcessedTask, ProcessingOptions, ProcessingRequest } from '../services/processing-service';
import { validateFileNamePattern } from '../services/settings-service';

interface ImportedDocument {
  document: SubtitleDocument;
  diagnostics: ParseDiagnostic[];
  uncertainEncoding: boolean;
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

function readDocument(file: ImportedFile, options: ProcessingOptions): ImportedDocument {
  if (file.error) throw new SubtitleError('READ_FAILED', file.error);
  const decoded = decodeBytes(file.bytes, options.encoding);
  const suspectEncoding = decoded.text.includes('\ufffd') || decoded.text.includes('\0');
  const parsed = parseSubtitle(decoded.text, file.name);
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
  return { name: outputName(fileName, 'json', options, inputIndex), text, bytes: encodeText(text, options.outputEncoding) };
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
    return {
      name: outputName(document.fileName, document.format, options, inputIndex),
      text: result.text,
      bytes: encodeText(result.text, options.outputEncoding),
      document: result.previewCues && { ...document, cues: result.previewCues, lineEnding: options.lineEnding },
    };
  });
  return { outputs: uniqueOutputNames(outputs), diagnostics };
}

function executeFile(request: ProcessingRequest, task: ProcessedTask): ProcessedTask {
  const file = request.files[0];
  const inputIndex = request.options.fileIndexes?.[file.id] ?? 1;
  const input = readDocument(file, request.options);
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
    task.outputs = [reportOutput('comparison.json', {
      files: inputs.map((input) => stats(input.document)), summary: task.summary, diagnostics: task.diagnostics,
    }, request.options)];
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
