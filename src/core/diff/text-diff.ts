export interface TextDiffSegment {
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

interface CueTextDiff {
  before: TextDiffSegment[];
  after: TextDiffSegment[];
  detailed: boolean;
}

const MAX_TEXT_UNITS = 4096;
const MAX_MATRIX_CELLS = 24_000;

function append(parts: TextDiffSegment[], kind: TextDiffSegment['kind'], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else parts.push({ kind, text });
}

function plainText(before: string, after: string, detailed: boolean): CueTextDiff {
  return {
    detailed,
    before: before ? [{ kind: 'equal', text: before }] : [],
    after: after ? [{ kind: 'equal', text: after }] : [],
  };
}

/** Compute only for visible, already-paired cues. Preserve graphemes and the exact source text. */
export function diffCueText(before: string, after: string): CueTextDiff {
  if (before === after) return plainText(before, after, true);
  if (before.length + after.length > MAX_TEXT_UNITS || typeof Intl.Segmenter !== 'function') {
    return plainText(before, after, false);
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const left = Array.from(segmenter.segment(before), item => item.segment);
  const right = Array.from(segmenter.segment(after), item => item.segment);
  const commonLimit = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < commonLimit && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < commonLimit - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;

  const oldMiddle = left.slice(prefix, left.length - suffix);
  const newMiddle = right.slice(prefix, right.length - suffix);
  const stride = newMiddle.length + 1;
  const cells = (oldMiddle.length + 1) * stride;
  if (cells > MAX_MATRIX_CELLS) return plainText(before, after, false);

  const common = new Uint16Array(cells);
  for (let i = oldMiddle.length - 1; i >= 0; i--) {
    for (let j = newMiddle.length - 1; j >= 0; j--) {
      const cell = i * stride + j;
      common[cell] = oldMiddle[i] === newMiddle[j]
        ? 1 + common[cell + stride + 1]
        : Math.max(common[cell + stride], common[cell + 1]);
    }
  }

  const result: CueTextDiff = { detailed: true, before: [], after: [] };
  const appendEqual = (text: string) => {
    append(result.before, 'equal', text);
    append(result.after, 'equal', text);
  };
  appendEqual(left.slice(0, prefix).join(''));
  let i = 0;
  let j = 0;
  while (i < oldMiddle.length && j < newMiddle.length) {
    const cell = i * stride + j;
    if (oldMiddle[i] === newMiddle[j]) {
      appendEqual(oldMiddle[i]);
      i++;
      j++;
    } else if (common[cell + stride] >= common[cell + 1]) {
      append(result.before, 'delete', oldMiddle[i]);
      i++;
    } else {
      append(result.after, 'insert', newMiddle[j]);
      j++;
    }
  }
  append(result.before, 'delete', oldMiddle.slice(i).join(''));
  append(result.after, 'insert', newMiddle.slice(j).join(''));
  appendEqual(left.slice(left.length - suffix).join(''));
  return result;
}
