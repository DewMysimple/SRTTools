import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionDialog } from '../../components/action-dialog';
import { errorText, NoticeBox } from '../../components/common';
import { SubtitleDiffPreview } from '../../components/subtitle-diff-preview';
import type { SubtitleDocument } from '../../core/models';
import { isDesktop, nativePathKey } from '../../services/file-service';
import {
  listRecoverable, loadRecoverable, nativeDraftStore, pruneResolvedDrafts,
  type DraftList, type DraftSummary, type LoadedDraft,
} from './draft-recovery-service';

let deferred = new Set<string>();
const thirtyDays = 30 * 24 * 60 * 60 * 1000;
const healthLabels = {
  ready: '完整',
  fallback: '最近版本损坏，保留上一份完整快照',
  damaged: '损坏，无可用快照',
  incompatible: '来自较新的草稿版本，已保留',
  inaccessible: '暂时无法读取，请检查权限或文件占用',
  retired: '已处理，等待清理文件',
};
const sourceLabels = {
  unchanged: '已核对，原字幕字节未变化。',
  changed: '原字幕已在外部修改。可将草稿作为独立内容恢复，再另存为新的 SRT。',
  missing: '找不到原字幕。可将草稿作为独立内容恢复，再另存为新的 SRT。',
  unverified: '无法核对原字幕。可将草稿作为独立内容恢复，再另存为新的 SRT。',
};

function matchesDraftSource(row: DraftSummary, sourcePath?: string): boolean {
  return !!sourcePath && !!row.sourcePath && nativePathKey(sourcePath) === nativePathKey(row.sourcePath);
}

export function shouldOfferDraft(row: DraftSummary, sourcePath?: string): boolean {
  return !deferred.has(row.draftId) && row.health !== 'retired' && matchesDraftSource(row, sourcePath);
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function useDraftInventory() {
  const request = useRef(0);
  const [inventory, setInventory] = useState<DraftList>();
  const [problem, setProblem] = useState('');
  const refresh = useCallback(async () => {
    if (!isDesktop()) return undefined;
    const generation = ++request.current;
    try {
      const current = await listRecoverable();
      if (generation === request.current) {
        setInventory(current);
        setProblem('');
      }
      return current;
    } catch (error) {
      if (generation === request.current) setProblem(errorText(error));
      return undefined;
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { inventory, problem, refresh };
}

export function DraftRecoveryLink({ settings = false }: { settings?: boolean }) {
  const { inventory, problem } = useDraftInventory();
  if (!isDesktop()) return null;
  const count = inventory?.drafts.filter(row => row.health !== 'retired' && !deferred.has(row.draftId)).length ?? 0;
  if (!settings && count === 0) return null;
  return <div className="settings-inline">
    {settings ? <span>{inventory
      ? <>{sizeLabel(inventory.usedBytes)} / {sizeLabel(inventory.budgetBytes)} · 最多 {inventory.draftLimit} 份</>
      : problem ? '无法读取草稿占用，请在时间轴重试。' : '正在读取草稿占用…'}</span>
      : <span>发现 {count} 份待处理的本地字幕草稿。</span>}
    <Link className="button secondary small" to="/timeline" state={{ manageDrafts: true }}>管理本地草稿</Link>
  </div>;
}

export function DraftRecoveryPanel({ inventory, problem, refresh, document, activeId, dirty, busy, onRecover }: {
  inventory?: DraftList;
  problem: string;
  refresh: () => Promise<DraftList | undefined>;
  document?: SubtitleDocument;
  activeId?: string;
  dirty: boolean;
  busy: boolean;
  onRecover: (draft: LoadedDraft) => Promise<LoadedDraft | boolean | undefined>;
}) {
  const [detail, setDetail] = useState<{ row: DraftSummary; loaded: LoadedDraft; diff: boolean }>();
  const [confirming, setConfirming] = useState<DraftSummary>();
  const [showDeferred, setShowDeferred] = useState(false);
  const [deferredIds, setDeferredIds] = useState(deferred);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  const [openedAt] = useState(Date.now);
  const rows = (inventory?.drafts ?? []).filter(row => row.draftId !== activeId && (showDeferred || !deferredIds.has(row.draftId)));
  const visible = rows.sort((a, b) => Number(matchesDraftSource(b, document?.sourcePath)) - Number(matchesDraftSource(a, document?.sourcePath)));

  async function work(action: () => Promise<void>) {
    setWorking(true);
    setFeedback('');
    setFailure('');
    try { await action(); }
    catch (error) { setFailure(errorText(error)); }
    finally { setWorking(false); }
  }

  function inspect(row: DraftSummary, diff: boolean) {
    void work(async () => setDetail({ row, diff, loaded: await loadRecoverable(row.draftId) }));
  }

  function restore() {
    if (!detail || dirty) return;
    void work(async () => {
      const result = await onRecover(detail.loaded);
      if (result && typeof result !== 'boolean') {
        setDetail({ ...detail, loaded: result });
        setFeedback('草稿或来源状态已变化，请核对后再次确认。');
      } else if (result) {
        setDetail(undefined);
        await refresh();
      }
    });
  }

  function defer(row: DraftSummary) {
    deferred = new Set(deferred).add(row.draftId);
    setDeferredIds(deferred);
    setShowDeferred(false);
    setDetail(undefined);
    setFeedback('已保留草稿，本次会话稍后可在这里查看。');
  }

  const detailMatches = !!detail && detail.loaded.sourceStatus === 'changed' && matchesDraftSource(detail.row, document?.sourcePath);
  const disabled = busy || working;
  return <section className="timeline-card timeline-recovery" aria-label="本地草稿恢复">
    <div className="timeline-panel-heading">
      <h2>本地草稿</h2>
      {inventory && <span>{sizeLabel(inventory.usedBytes)} / {sizeLabel(inventory.budgetBytes)}</span>}
    </div>
    <p className="timeline-inline-note">只有已完成本地保护的编辑可以恢复。恢复内容仍需另存为 SRT。</p>
    {problem && <NoticeBox kind="error">无法检查本地草稿。{problem}</NoticeBox>}
    <div className="button-row">
      <button type="button" className="button secondary small" disabled={disabled} onClick={() => void work(async () => {
        setDetail(undefined);
        await refresh();
      })}>刷新草稿</button>
      <button type="button" className="button secondary small" disabled={disabled} aria-pressed={showDeferred}
        onClick={() => setShowDeferred(value => !value)}>显示稍后处理项</button>
      <button type="button" className="button secondary small" disabled={disabled} onClick={() => void work(async () => {
        const pending = await pruneResolvedDrafts();
        await refresh();
        setFeedback(pending ? pending + ' 项仍被占用，可稍后重试清理。' : '已清理已处理草稿和中断写入的暂存文件。');
      })}>清理已处理草稿</button>
    </div>
    {inventory && !visible.length && <p className="timeline-inline-note">没有待显示的草稿。</p>}
    {visible.map(row => {
      const readable = row.health === 'ready' || row.health === 'fallback';
      const old = row.savedAtMs !== null && openedAt - row.savedAtMs >= thirtyDays;
      return <article key={row.draftId} className="timeline-recovery-row" aria-label={row.fileName ?? '未识别的草稿'}>
        <strong>{row.fileName ?? '草稿 ' + row.draftId.slice(0, 8)}</strong>
        <p className="timeline-inline-note">
          {row.savedAtMs !== null && new Date(row.savedAtMs).toLocaleString('zh-CN') + ' · '}{sizeLabel(row.bytes)} · {healthLabels[row.health]}
          {old && ' · 旧草稿'}{matchesDraftSource(row, document?.sourcePath) && ' · 与当前文件路径匹配'}
        </p>
        {readable && <p className="timeline-inline-note">{detail?.row.draftId === row.draftId ? sourceLabels[detail.loaded.sourceStatus] : '恢复或查看差异时核对原字幕。'}</p>}
        <div className="button-row">
          {readable && <>
            <button type="button" className="button primary small" disabled={disabled} onClick={() => inspect(row, false)}>恢复草稿</button>
            <button type="button" className="button secondary small" disabled={disabled} onClick={() => inspect(row, true)}>查看差异</button>
            <button type="button" className="button secondary small" disabled={disabled} onClick={() => defer(row)}>稍后处理</button>
          </>}
          {row.health !== 'retired' && <button type="button" className="button secondary small" disabled={disabled} onClick={() => setConfirming(row)}>丢弃草稿</button>}
        </div>
      </article>;
    })}
    {detail && <section aria-label="草稿恢复详情" className="timeline-recovery-detail">
      <h3>{detail.loaded.draft.fileName}</h3>
      {detail.loaded.health === 'fallback' && <NoticeBox kind="warning">最近版本校验失败。将使用上一份通过校验的草稿。</NoticeBox>}
      <p>{sourceLabels[detail.loaded.sourceStatus]}</p>
      {dirty && <NoticeBox kind="warning">请先导出当前编辑，再恢复其他草稿。</NoticeBox>}
      {detail.diff && <SubtitleDiffPreview
        key={detail.row.draftId} before={detailMatches ? document!.cues : detail.loaded.draft.original} after={detail.loaded.draft.cues}
        trustIds={!detailMatches} beforeLabel={detailMatches ? '本次打开时的源字幕' : '开始编辑时的原稿'}
        afterLabel="本地保护草稿" partialOutput={false} />}
      <div className="button-row">
        <button type="button" className="button primary small" disabled={disabled || dirty} onClick={restore}>
          {detail.loaded.sourceStatus === 'unchanged' ? '确认恢复到时间轴' : '独立恢复并另存为'}
        </button>
        {!detail.diff && <button type="button" className="button secondary small" disabled={disabled}
          onClick={() => setDetail({ ...detail, diff: true })}>展开字幕差异</button>}
        <button type="button" className="button secondary small" disabled={disabled} onClick={() => setDetail(undefined)}>关闭详情</button>
      </div>
    </section>}
    {feedback && <p role="status">{feedback}</p>}
    {failure && <p className="field-error" role="alert">{failure}</p>}
    {confirming && <ActionDialog title="永久丢弃本地草稿？" confirmLabel="确认丢弃草稿" danger
      onClose={() => setConfirming(undefined)} onConfirm={async () => {
        const removed = await nativeDraftStore.discard(confirming.draftId);
        setDetail(undefined);
        setFeedback(removed ? '已丢弃选中的草稿。' : '已确认丢弃。文件暂时被占用，可稍后清理。');
        await refresh();
      }}>
      <p>将永久丢弃「{confirming.fileName ?? '此未识别的草稿'}」的本地编辑。源字幕和视频会保留。</p>
    </ActionDialog>}
  </section>;
}
