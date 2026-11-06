import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import type { SubtitleDocument } from '../../core/models';
import { isDirty, recoverSession, type EditingSession } from './core/editing-session';

const encodings = ['UTF-8', 'UTF-8 BOM', 'UTF-16 LE', 'UTF-16 BE', 'GBK', 'GB18030'] as const;
const encodingSchema = z.enum(encodings);
const idSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const cueSchema = z.strictObject({
  id: z.string().min(1).max(128),
  index: z.int(),
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  text: z.string().max(16 * 1024 * 1024),
});
const cuesSchema = z.array(cueSchema).max(100_000).refine(cues => new Set(cues.map(cue => cue.id)).size === cues.length);
const draftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draftId: idSchema,
  revision: z.int().positive(),
  fileName: z.string().min(1).max(255).regex(/^[^<>:"/\\|?*]+\.srt$/iu).refine(value => !/\p{Cc}/u.test(value)),
  format: z.literal('srt'),
  encoding: encodingSchema,
  lineEnding: z.enum(['CRLF', 'LF', 'CR']),
  original: cuesSchema,
  cues: cuesSchema,
});
const healthSchema = z.enum(['ready', 'fallback', 'damaged', 'incompatible', 'inaccessible', 'retired']);
const timestampSchema = z.int().nonnegative();
const receiptSchema = z.strictObject({
  savedAtMs: timestampSchema,
  bytes: z.int().nonnegative(),
  overSoftLimit: z.boolean(),
});
const listSchema = z.strictObject({
  drafts: z.array(z.strictObject({
    draftId: idSchema,
    health: healthSchema,
    fileName: z.string().nullable(),
    savedAtMs: timestampSchema.nullable(),
    sourcePath: z.string().nullable(),
    bytes: z.int().nonnegative(),
  })).max(256),
  usedBytes: z.number().nonnegative(),
  budgetBytes: z.int().positive(),
  draftLimit: z.int().positive(),
});
const loadedSchema = z.strictObject({
  draft: draftSchema,
  sourceStatus: z.enum(['unchanged', 'changed', 'missing', 'unverified']),
  sourceToken: idSchema.nullable(),
  headRevision: z.int().positive(),
  savedAtMs: timestampSchema,
  health: z.enum(['ready', 'fallback']),
}).refine(value => value.headRevision >= value.draft.revision);

export type DraftList = z.infer<typeof listSchema>;
export type DraftSummary = DraftList['drafts'][number];
export type LoadedDraft = z.infer<typeof loadedSchema>;
type SaveReceipt = z.infer<typeof receiptSchema>;
type DraftPayload = z.infer<typeof draftSchema>;

export interface DraftStore {
  save(payload: DraftPayload, sourceToken?: string): Promise<SaveReceipt>;
  discard(id: string, throughRevision?: number): Promise<boolean>;
}

export const nativeDraftStore: DraftStore = {
  async save(payload, sourceToken) {
    return receiptSchema.parse(await invoke('save_draft', { payload: JSON.stringify(payload), sourceToken }));
  },
  async discard(draftId, throughRevision) {
    return z.boolean().parse(await invoke('discard_draft', { draftId, throughRevision }));
  },
};

export async function listRecoverable(): Promise<DraftList> {
  return listSchema.parse(await invoke('list_drafts'));
}

export async function loadRecoverable(draftId: string): Promise<LoadedDraft> {
  const loaded = loadedSchema.safeParse(await invoke('load_draft', { draftId }));
  if (!loaded.success || loaded.data.draft.draftId !== draftId) throw new Error('草稿结构无效，已保留在本机。');
  return loaded.data;
}

export async function pruneResolvedDrafts(): Promise<number> {
  return z.int().nonnegative().parse(await invoke('prune_drafts'));
}

export function sessionFromDraft({ draft, headRevision }: LoadedDraft): EditingSession {
  const info = {
    id: draft.draftId, fileName: draft.fileName, format: draft.format,
    encoding: draft.encoding, lineEnding: draft.lineEnding,
  };
  const original: SubtitleDocument = { ...info, modified: false, cues: draft.original };
  return recoverSession(original, { ...info, modified: true, cues: draft.cues }, headRevision);
}

function newDraftId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export type ProtectionStatus =
  | { kind: 'idle' | 'saving' }
  | { kind: 'saved'; savedAtMs: number; overSoftLimit?: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'cleanup' };

type Job =
  | { kind: 'save'; session: EditingSession }
  | { kind: 'retire'; throughRevision?: number };

export class DraftRecoveryService {
  private draftId: string;
  private mayExist: boolean;
  private pending?: Job;
  private latestRevision = 0;
  private running?: Promise<boolean>;
  private debounce?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onStatus: (status: ProtectionStatus) => void,
    private readonly sourceToken?: string,
    existingId?: string,
    private readonly store = nativeDraftStore,
  ) {
    this.draftId = existingId ?? newDraftId();
    this.mayExist = !!existingId;
  }

  get activeId() { return this.draftId; }
  get needsFlush() { return !!this.pending || !!this.running; }

  scheduleSave(session: EditingSession) {
    if (session.revision < this.latestRevision) return;
    this.latestRevision = session.revision;
    if (isDirty(session)) {
      this.pending = { kind: 'save', session };
    } else if (this.mayExist) {
      this.pending = { kind: 'retire', throughRevision: session.revision };
    } else {
      this.pending = undefined;
      this.clearTimers();
      this.onStatus({ kind: 'idle' });
      return;
    }
    this.onStatus({ kind: 'saving' });
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), 1200);
    this.deadline ??= setTimeout(() => void this.flush(), 12_000);
  }

  private clearTimers() {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.debounce = this.deadline = undefined;
  }

  async flush(): Promise<boolean> {
    this.clearTimers();
    if (this.running) {
      await this.running;
      return this.flush();
    }
    const job = this.pending;
    if (!job) return true;
    this.pending = undefined;
    this.onStatus({ kind: 'saving' });
    const task = this.write(job);
    this.running = task;
    try { return await task; }
    finally { this.running = undefined; }
  }

  async resolve(throughRevision?: number): Promise<boolean> {
    if (throughRevision !== undefined && this.latestRevision > throughRevision) return false;
    this.clearTimers();
    // A successful export or explicit discard supersedes the queued write for this revision.
    this.pending = undefined;
    await this.running;
    if (throughRevision !== undefined && this.latestRevision > throughRevision) return false;
    if (!this.mayExist) {
      this.pending = undefined;
      this.onStatus({ kind: 'idle' });
      return true;
    }
    this.pending = { kind: 'retire', throughRevision };
    return this.flush();
  }

  private async write(job: Job): Promise<boolean> {
    try {
      let status: ProtectionStatus;
      if (job.kind === 'retire') {
        const cleaned = await this.store.discard(this.draftId, job.throughRevision);
        this.draftId = newDraftId();
        this.mayExist = false;
        status = { kind: cleaned ? 'idle' : 'cleanup' };
      } else {
        this.mayExist = true;
        const { document, original, revision } = job.session;
        const receipt = await this.store.save({
          schemaVersion: 1, draftId: this.draftId, revision, fileName: document.fileName,
          format: 'srt', encoding: encodingSchema.parse(document.encoding), lineEnding: document.lineEnding,
          original: original.cues, cues: document.cues,
        }, this.sourceToken);
        status = { kind: 'saved', ...receipt };
      }
      if (!this.pending) this.onStatus(status);
      return true;
    } catch (error) {
      if (!this.pending) {
        this.pending = job;
        const message = typeof error === 'string' ? error : error instanceof Error && !(error instanceof z.ZodError)
          ? error.message : '无法验证草稿服务的返回结果。';
        this.onStatus({ kind: 'error', message });
      }
      return false;
    }
  }
}
