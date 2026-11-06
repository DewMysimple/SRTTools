import { createId, type SubtitleCue, type SubtitleDocument } from '../../../core/models';
import { validateCueTime } from '../../../core/time';

export type EditMode = 'move' | 'trim-start' | 'trim-end';

interface PositionedCue {
  position: number;
  cue: SubtitleCue;
}

interface CueChange {
  before?: PositionedCue;
  after?: PositionedCue;
}

type Edit = readonly CueChange[];

export interface EditingSession {
  document: SubtitleDocument;
  original: SubtitleDocument;
  saved: readonly SubtitleCue[];
  past: readonly Edit[];
  future: readonly Edit[];
}

const HISTORY_LIMIT = 100;

export function createSession(document: SubtitleDocument): EditingSession {
  return { document, original: document, saved: document.cues, past: [], future: [] };
}

function sameContents(a: SubtitleCue, b: SubtitleCue): boolean {
  return a === b || (a.startMs === b.startMs && a.endMs === b.endMs && a.text === b.text);
}

export function isDirty({ document, saved }: EditingSession): boolean {
  return document.cues !== saved &&
    (document.cues.length !== saved.length || document.cues.some((cue, i) => !sameContents(cue, saved[i])));
}

export function markSaved(session: EditingSession): EditingSession {
  return { ...session, saved: session.document.cues };
}

export function restoreOriginal(session: EditingSession): EditingSession {
  return { ...session, document: session.original, past: [], future: [] };
}

function apply(document: SubtitleDocument, edit: Edit, side: 'before' | 'after'): SubtitleDocument {
  const removed = new Set<string>();
  const inserted = new Map<number, SubtitleCue>();
  for (const change of edit) {
    const current = change[side === 'after' ? 'before' : 'after'];
    const target = change[side];
    if (current) removed.add(current.cue.id);
    if (target) inserted.set(target.position, target.cue);
  }
  const remaining = document.cues.filter(cue => !removed.has(cue.id));
  const cues = new Array<SubtitleCue>(remaining.length + inserted.size);
  let cursor = 0;
  for (let i = 0; i < cues.length; i++) cues[i] = inserted.get(i) ?? remaining[cursor++];
  return { ...document, cues, modified: true };
}

function commit(session: EditingSession, edit: Edit): EditingSession {
  if (!edit.length) return session;
  return {
    ...session,
    document: apply(session.document, edit, 'after'),
    past: [...session.past.slice(1 - HISTORY_LIMIT), edit],
    future: [],
  };
}

export function undo(session: EditingSession): EditingSession {
  const edit = session.past.at(-1);
  return edit ? {
    ...session, document: apply(session.document, edit, 'before'),
    past: session.past.slice(0, -1), future: [...session.future, edit],
  } : session;
}

export function redo(session: EditingSession): EditingSession {
  const edit = session.future.at(-1);
  return edit ? {
    ...session, document: apply(session.document, edit, 'after'),
    past: [...session.past, edit], future: session.future.slice(0, -1),
  } : session;
}

function assertTimes(cue: SubtitleCue) {
  const error = validateCueTime(cue);
  if (error) throw new Error(error);
}

export function timeChanges(cues: readonly SubtitleCue[], mode: EditMode, deltaMs: number): SubtitleCue[] {
  if (!Number.isSafeInteger(deltaMs)) throw new Error('偏移量必须是有效的整数毫秒。');
  return cues.map(cue => {
    const updated = {
      ...cue,
      startMs: cue.startMs + (mode === 'trim-end' ? 0 : deltaMs),
      endMs: cue.endMs + (mode === 'trim-start' ? 0 : deltaMs),
    };
    assertTimes(updated);
    return updated;
  });
}

export function replaceCues(session: EditingSession, replacements: readonly SubtitleCue[]): EditingSession {
  const byId = new Map(replacements.map(cue => [cue.id, cue]));
  const edit: CueChange[] = [];
  session.document.cues.forEach((cue, position) => {
    const replacement = byId.get(cue.id);
    if (!replacement || sameContents(cue, replacement)) return;
    assertTimes(replacement);
    edit.push({ before: { position, cue }, after: { position, cue: replacement } });
  });
  return commit(session, edit);
}

export function shiftCues(session: EditingSession, ids: readonly string[], deltaMs: number): EditingSession {
  const selected = new Set(ids);
  return replaceCues(session, timeChanges(session.document.cues.filter(cue => selected.has(cue.id)), 'move', deltaMs));
}

export function updateCue(
  session: EditingSession, id: string, patch: Partial<Pick<SubtitleCue, 'startMs' | 'endMs' | 'text'>>,
): EditingSession {
  const cue = session.document.cues.find(item => item.id === id);
  return cue ? replaceCues(session, [{ ...cue, ...patch }]) : session;
}

export function deleteCues(session: EditingSession, ids: readonly string[]): EditingSession {
  const selected = new Set(ids);
  const edit: CueChange[] = [];
  session.document.cues.forEach((cue, position) => {
    if (selected.has(cue.id)) edit.push({ before: { position, cue } });
  });
  return commit(session, edit);
}

export function insertCue(session: EditingSession, playheadMs: number): EditingSession {
  const position = session.document.cues.length;
  const startMs = session.document.cues.reduce((latest, cue) => Math.max(latest, cue.endMs), playheadMs);
  const cue = { id: createId(), index: position + 1, startMs, endMs: startMs + 2000, text: '' };
  assertTimes(cue);
  return commit(session, [{ after: { position, cue } }]);
}
