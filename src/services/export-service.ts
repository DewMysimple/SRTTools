export interface NamedOutput {
  name: string;
  bytes: Uint8Array;
}

function truncateName(text: string, maxUnits: number): string {
  let result = '';
  for (const character of text) {
    if (result.length + character.length > maxUnits) break;
    result += character;
  }
  return result;
}

function nameParts(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot < 12
    ? { base: name.slice(0, dot), extension: name.slice(dot) }
    : { base: name, extension: '' };
}

export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- Windows forbids control characters in filenames.
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/u, '').trim();
  if (!safe || safe === '.' || safe === '..') safe = 'subtitle';
  if (/^(con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(safe)) safe = `_${safe}`;
  if (safe.length > 220) {
    const { base, extension } = nameParts(safe);
    safe = truncateName(base, 220 - extension.length) + extension;
  }
  return safe;
}

/** ZIP entries are unique on case-insensitive Windows filesystems too. */
export function uniqueOutputNames<T extends NamedOutput>(outputs: readonly T[]): T[] {
  const used = new Set<string>();
  return outputs.map((output) => {
    const safe = safeFileName(output.name);
    const { base, extension } = nameParts(safe);
    let candidate = safe;
    let suffix = 2;
    while (used.has(candidate.normalize('NFC').toLocaleLowerCase('en-US'))) {
      const marker = ` (${suffix++})`;
      candidate = `${truncateName(base, 220 - marker.length - extension.length)}${marker}${extension}`;
    }
    used.add(candidate.normalize('NFC').toLocaleLowerCase('en-US'));
    return { ...output, name: candidate };
  });
}

export async function createZip(outputs: readonly NamedOutput[]): Promise<Uint8Array> {
  if (outputs.length === 0) throw new Error('没有可导出的处理结果。');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const output of uniqueOutputNames(outputs)) {
    zip.file(output.name, output.bytes, { binary: true, createFolders: false });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
