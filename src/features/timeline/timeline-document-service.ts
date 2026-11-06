import { encodeText } from '../../core/encoding';
import type { ParseResult, SubtitleDocument } from '../../core/models';
import { serializeSubtitle } from '../../core/serializer';
import { safeFileName } from '../../services/export-service';
import { pickFiles, saveOutput } from '../../services/file-service';
import { runWorkerRequest } from '../../services/processing-service';

export const timelineEncodings = ['UTF-8', 'UTF-8 BOM', 'UTF-16 LE', 'UTF-16 BE', 'GBK', 'GB18030'];

export async function openTimelineDocument(encoding: string): Promise<(ParseResult & { sourceToken?: string }) | null> {
  const files = await pickFiles('timeline');
  if (!files.length) return null;
  const result = await runWorkerRequest({
    kind: 'timeline', files, operation: '', params: {},
    options: { encoding, lineEnding: 'LF', outputEncoding: 'UTF-8', fileNamePattern: '{name}_processed' },
  });
  if (!result.document) throw new Error(result.errorMessage ?? '无法读取时间轴字幕。');
  return { document: result.document, diagnostics: result.diagnostics, sourceToken: files[0].draftSourceToken };
}

export function buildTimelineOutput(document: SubtitleDocument, encoding = document.encoding) {
  const output = serializeSubtitle(document, 'srt', document.lineEnding);
  return {
    name: safeFileName(`${document.fileName.replace(/\.srt$/iu, '')}_timed.srt`),
    bytes: encodeText(output.text, encoding),
  };
}

export async function saveTimelineDocument(document: SubtitleDocument, encoding: string): Promise<string | null> {
  const { name, bytes } = buildTimelineOutput(document, encoding);
  return saveOutput(name, bytes);
}
