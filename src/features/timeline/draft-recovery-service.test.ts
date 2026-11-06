import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../../core/models';
import { createSession, isDirty, markSaved, redo, undo, updateCue } from './core/editing-session';
import { DraftRecoveryService, type DraftStore } from './draft-recovery-service';

const receipt = { savedAtMs: 1234, bytes: 512, overSoftLimit: false };

function setup() {
  vi.useFakeTimers();
  const document = newDocument('原稿.srt', 'srt');
  document.cues = [{ id: 'one', index: 7, startMs: 1000, endMs: 3000, text: '原稿' }];
  const save = vi.fn<DraftStore['save']>().mockResolvedValue(receipt);
  const discard = vi.fn<DraftStore['discard']>().mockResolvedValue(true);
  const status = vi.fn();
  return { base: createSession(document), save, discard, status, service: new DraftRecoveryService(status, 'source-proof', undefined, { save, discard }) };
}

afterEach(() => vi.useRealTimers());

describe('timeline draft coordinator', () => {
  it('coalesces committed changes and carries a stable identity, text and original data', async () => {
    const { base, save, status, service } = setup();
    const first = updateCue(base, 'one', { text: '编辑\n猫 🐱' });
    service.scheduleSave(first);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    const second = updateCue(first, 'one', { startMs: 1100 });
    service.scheduleSave(second);
    await vi.advanceTimersByTimeAsync(1200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      draftId: service.activeId, revision: 2, original: base.original.cues, cues: second.document.cues,
    }), 'source-proof');
    expect(status).toHaveBeenLastCalledWith({ kind: 'saved', ...receipt });
    expect(service.needsFlush).toBe(false);
  });

  it('flushes sustained edits at the maximum wait and keeps undo/redo revisions ordered', async () => {
    const { base, save, service } = setup();
    let session = base;
    for (let i = 1; i <= 12; i++) {
      session = updateCue(session, 'one', { startMs: 1000 + i });
      service.scheduleSave(session);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save.mock.calls.map(([payload]) => payload.revision)).toEqual([12]);
    const undone = undo(session);
    const redone = redo(undone);
    service.scheduleSave(undone);
    service.scheduleSave(redone);
    await service.flush();
    expect(save.mock.calls.map(([payload]) => payload.revision)).toEqual([12, 14]);
    expect(save.mock.calls[1][0].cues).toEqual(session.document.cues);
  });

  it('serializes newer revisions behind a live write even when the old write fails', async () => {
    const { base, save, status, service } = setup();
    let fail!: (problem: string) => void;
    save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = updateCue(base, 'one', { text: '第一次' });
    const second = updateCue(first, 'one', { text: '第二次' });
    service.scheduleSave(first);
    const active = service.flush();
    service.scheduleSave(second);
    const queued = service.flush();
    expect(save).toHaveBeenCalledTimes(1);
    fail('写入中断');
    expect(await active).toBe(false);
    expect(await queued).toBe(true);
    expect(save.mock.calls.map(([payload]) => payload.revision)).toEqual([1, 2]);
    expect(status).toHaveBeenLastCalledWith({ kind: 'saved', ...receipt });
  });

  it('keeps a failed revision retryable and retires only the confirmed export revision', async () => {
    const { base, save, discard, status, service } = setup();
    const first = updateCue(base, 'one', { text: '一' });
    const second = updateCue(first, 'one', { text: '二' });
    service.scheduleSave(first);
    save.mockRejectedValueOnce('磁盘空间不足');
    expect(await service.flush()).toBe(false);
    expect(status).toHaveBeenLastCalledWith({ kind: 'error', message: '磁盘空间不足' });
    expect(service.needsFlush).toBe(true);
    expect(await service.flush()).toBe(true);
    service.scheduleSave(second);
    expect(await service.resolve(1)).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(await service.flush()).toBe(true);
    const originalId = service.activeId;
    expect(await service.resolve(2)).toBe(true);
    expect(discard).toHaveBeenCalledWith(originalId, 2);
    expect(service.activeId).not.toBe(originalId);
    expect(isDirty(markSaved(second))).toBe(false);
  });

  it('undo to a clean baseline cancels unwritten work and retires protected work', async () => {
    const { base, save, discard, service } = setup();
    const first = updateCue(base, 'one', { text: '一' });
    const clean = undo(first);
    service.scheduleSave(first);
    service.scheduleSave(clean);
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    const again = redo(clean);
    service.scheduleSave(again);
    await service.flush();
    const originalId = service.activeId;
    const afterUndo = undo(again);
    service.scheduleSave(afterUndo);
    await service.flush();
    expect(discard).toHaveBeenCalledWith(originalId, afterUndo.revision);
  });
});
