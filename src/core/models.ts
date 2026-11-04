export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa' | 'txt' | 'csv';
export type LineEnding = 'CRLF' | 'LF' | 'CR';

export interface SubtitleCue {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleDocument {
  id: string;
  fileName: string;
  sourcePath?: string;
  format: SubtitleFormat;
  encoding: string;
  lineEnding: LineEnding;
  cues: SubtitleCue[];
  modified: boolean;
}

export interface ParseDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  line?: number;
  cueIndex?: number;
}

export interface ParseResult {
  document: SubtitleDocument;
  diagnostics: ParseDiagnostic[];
}

export class SubtitleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SubtitleError';
    this.code = code;
  }
}

let nextId = 0;
export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `subtitle-${Date.now()}-${++nextId}`;
}

export function newDocument(fileName: string, format: SubtitleFormat, text = ''): SubtitleDocument {
  const lineEnding: LineEnding = text.includes('\r\n') ? 'CRLF' : text.includes('\r') ? 'CR' : 'LF';
  return { id: createId(), fileName, format, encoding: 'UTF-8', lineEnding, cues: [], modified: false };
}

export function cloneDocument(document: SubtitleDocument): SubtitleDocument {
  return { ...document, cues: document.cues.map(cue => ({ ...cue })), modified: true };
}

export function renameExtension(name: string, extension: SubtitleFormat): string {
  return `${name.replace(/\.[^.]*$/, '')}.${extension}`;
}
