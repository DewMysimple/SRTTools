import { useBlocker } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FolderOpen, Plus, Redo2, Save, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionDialog } from '../../components/action-dialog';
import { EmptyState, errorText, NoticeBox } from '../../components/common';
import { SubtitleDiffPreview } from '../../components/subtitle-diff-preview';
import type { ParseDiagnostic, SubtitleCue } from '../../core/models';
import { formatTimestamp, parseTimestamp } from '../../core/time';
import { validateDocument } from '../../core/validate';
import { isDesktop } from '../../services/file-service';
import { CueIndex } from './core/cue-index';
import {
  createSession, deleteCues, insertCue, isDirty, markSaved, redo, replaceCues, restoreOriginal, shiftCues, undo, updateCue,
  type EditingSession,
} from './core/editing-session';
import { layoutCues } from './core/interval-layout';
import { SubtitleList } from './SubtitleList';
import { openTimelineDocument, saveTimelineDocument, timelineEncodings } from './timeline-document-service';
import { TimelineView, type TimelineViewHandle } from './TimelineView';
import './timeline.css';

interface Fields {
  start: string;
  end: string;
  text: string;
}

type ExitAction = 'open' | 'navigate' | 'close';
const EMPTY_CUES: SubtitleCue[] = [];

function fieldsFor(cue: SubtitleCue): Fields {
  return { start: formatTimestamp(cue.startMs, '.'), end: formatTimestamp(cue.endMs, '.'), text: cue.text };
}

function Modal({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog className="confirm-dialog timeline-modal" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id={titleId}>{title}</h2>{children}
  </dialog>;
}

export default function TimelineWorkspace() {
  const [session, setSession] = useState<EditingSession>();
  const [inputDiagnostics, setInputDiagnostics] = useState<ParseDiagnostic[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [inputEncoding, setInputEncoding] = useState('auto');
  const [outputEncoding, setOutputEncoding] = useState('UTF-8');
  const [draft, setDraft] = useState<Fields | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [exitAction, setExitAction] = useState<ExitAction>();
  const [restoring, setRestoring] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const [leftWidth, setLeftWidth] = useState(37);
  const [step, setStep] = useState(50);
  const view = useRef<TimelineViewHandle>(null);

  const document = session?.document;
  const cues = document?.cues ?? EMPTY_CUES;
  const dirty = !!draft || !!session && isDirty(session);
  const unrecoverable = inputDiagnostics.some(issue => issue.severity === 'error' && issue.code !== 'INVALID_CUE_TIME');
  const numbers = useMemo(() => new Map(cues.map((cue, i) => [cue.id, i + 1])), [cues]);
  const index = useMemo(() => new CueIndex(cues), [cues]);
  const layout = useMemo(() => layoutCues(index.sorted), [index]);
  const cue = selectedIds.length === 1 ? cues[(numbers.get(selectedIds[0]) ?? 0) - 1] : undefined;
  const diagnostics = useMemo(() => {
    if (!document) return [];
    const current = validateDocument({ ...document, cues: document.cues.map((item, i) => ({ ...item, index: i + 1 })) });
    return [...inputDiagnostics.filter(issue => issue.code !== 'INVALID_CUE_TIME'), ...current];
  }, [document, inputDiagnostics]);
  const diagnosticErrors = diagnostics.filter(issue => issue.severity === 'error').length;
  const fields = draft ?? (cue ? fieldsFor(cue) : null);

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    currentLocation.pathname !== nextLocation.pathname && (dirty || busyRef.current));
  const action = exitAction ?? (blocker.state === 'blocked' ? 'navigate' : undefined);
  const closeRequested = useEffectEvent((prevent: () => void) => {
    if (dirty || busyRef.current) {
      prevent();
      if (!busyRef.current) setExitAction('close');
    }
  });
  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => closeRequested(() => event.preventDefault()))
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(problem => setError(errorText(problem)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (isDesktop() || !dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);

  const select = useCallback((id: string, extend: boolean, range: boolean, reveal = false) => {
    if (draft || busyRef.current) return;
    const position = numbers.get(id);
    if (!position) return;
    if (range) {
      const from = numbers.get(selectionAnchor.current ?? '') ?? position;
      const rangeIds = cues.slice(Math.min(position, from) - 1, Math.max(position, from)).map(item => item.id);
      if (position < from) rangeIds.reverse();
      setSelectedIds(current => extend ? [...new Set([...current, ...rangeIds])] : rangeIds);
    } else {
      selectionAnchor.current = id;
      setSelectedIds(current => extend ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]);
    }
    if (reveal) view.current?.reveal(cues[position - 1].startMs, id);
  }, [cues, numbers, draft]);
  const listSelect = useCallback((id: string, extend: boolean, range: boolean) => select(id, extend, range, true), [select]);

  function applySession(next: EditingSession) {
    setSession(next);
    const ids = new Set(next.document.cues.map(item => item.id));
    setSelectedIds(current => current.every(id => ids.has(id)) ? current : current.filter(id => ids.has(id)));
    setDiagnosticPage(0);
    setError('');
  }

  function edit(change: (current: EditingSession) => EditingSession) {
    if (!session || busyRef.current || unrecoverable || draft) return;
    try { applySession(change(session)); }
    catch (problem) { setError(errorText(problem)); }
  }

  function applyFields(current: EditingSession) {
    if (!draft || !cue) return current;
    const next = updateCue(current, cue.id, { startMs: parseTimestamp(draft.start), endMs: parseTimestamp(draft.end), text: draft.text });
    setDraft(null);
    applySession(next);
    return next;
  }

  function updateFields(patch: Partial<Fields>) {
    if (!cue || !fields) return;
    const original = fieldsFor(cue);
    const next = { ...fields, ...patch };
    setDraft(next.start === original.start && next.end === original.end && next.text === original.text ? null : next);
    setError('');
  }

  async function runIO<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try { return await work(); }
    catch (problem) { setError(errorText(problem)); return undefined; }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function openDocument() {
    await runIO(async () => {
      const opened = await openTimelineDocument(inputEncoding);
      if (!opened) return;
      setSession(createSession(opened.document));
      setInputDiagnostics(opened.diagnostics);
      setOutputEncoding(opened.document.encoding);
      setSelectedIds(opened.document.cues.length ? [opened.document.cues[0].id] : []);
      selectionAnchor.current = opened.document.cues[0]?.id ?? null;
      setPlayheadMs(0);
      setDraft(null);
      setSavedPath('');
      setShowDiagnostics(false);
      setDiagnosticPage(0);
      setShowDiff(false);
    });
  }

  function requestOpen() {
    if (busyRef.current) return;
    if (dirty) setExitAction('open');
    else void openDocument();
  }

  async function saveDocument() {
    if (!session || unrecoverable) return false;
    return runIO(async () => {
      const current = applyFields(session);
      const path = await saveTimelineDocument(current.document, outputEncoding);
      if (!path) return false;
      setSession(markSaved(current));
      setSavedPath(path);
      return true;
    });
  }

  function cancelExit() {
    if (busyRef.current) return;
    if (blocker.state === 'blocked') blocker.reset();
    setExitAction(undefined);
  }

  async function continueExit(save: boolean) {
    if (busyRef.current || (save && !await saveDocument())) return;
    if (action === 'open') {
      setExitAction(undefined);
      await openDocument();
    } else if (action === 'close') {
      await runIO(async () => getCurrentWindow().destroy());
    } else if (blocker.state === 'blocked') {
      blocker.proceed();
    }
  }

  const handleKeys = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || busyRef.current ||
      globalThis.document.querySelector('dialog[open]')) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const input = target?.closest('input, textarea, select, [contenteditable="true"]');
    const key = event.key.toLowerCase();
    const primary = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape' && draft) {
      event.preventDefault();
      setDraft(null);
      setError('');
    } else if (primary && key === 'o' && !event.shiftKey) {
      event.preventDefault();
      requestOpen();
    } else if (primary && key === 's' && session) {
      event.preventDefault();
      void saveDocument();
    } else if (primary && key === 'f') {
      const search = globalThis.document.getElementById('timeline-search');
      if (search) { event.preventDefault(); search.focus(); }
    } else if (!input && !draft && session && !unrecoverable) {
      if (primary && (key === 'z' || key === 'y')) {
        event.preventDefault();
        edit(key === 'y' || event.shiftKey ? redo : undo);
      } else if (!primary && selectedIds.length && (key === 'delete' || key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault();
        edit(current => key === 'delete' ? deleteCues(current, selectedIds) : shiftCues(current, selectedIds, key === 'arrowleft' ? -step : step));
      }
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeys(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const controlsDisabled = busy || unrecoverable || !!draft;
  const diagStart = diagnosticPage * 20;
  return <section className="timeline-workspace" aria-label="字幕校时工作区">
    <div className="timeline-heading">
      <div><h1>字幕时间轴</h1><p>本地 SRT 校时与编辑 · 单文件独立草稿</p></div>
      <div className="button-row timeline-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={requestOpen}><FolderOpen size={16} />打开字幕</button>
        <button type="button" className="button secondary" disabled={controlsDisabled || !session?.past.length} onClick={() => edit(undo)}><Undo2 size={16} />撤销</button>
        <button type="button" className="button secondary" disabled={controlsDisabled || !session?.future.length} onClick={() => edit(redo)}><Redo2 size={16} />重做</button>
        <button type="button" className="button primary" disabled={busy || !session || unrecoverable} onClick={() => void saveDocument()}><Save size={16} />另存为</button>
      </div>
    </div>
    <div className="timeline-options">
      <label>读取编码 <select value={inputEncoding} disabled={busy} onChange={event => setInputEncoding(event.target.value)}>
        <option value="auto">自动检测</option>{timelineEncodings.map(encoding => <option key={encoding}>{encoding}</option>)}
      </select></label>
      {session && <>
        <label>导出编码 <select value={outputEncoding} disabled={busy} onChange={event => setOutputEncoding(event.target.value)}>
          {timelineEncodings.map(encoding => <option key={encoding}>{encoding}</option>)}
        </select></label>
        <label className="timeline-slider">列表宽度<input type="range" min={28} max={52} value={leftWidth} onChange={event => setLeftWidth(Number(event.target.value))} /></label>
        <button type="button" className="button secondary small" disabled={busy || unrecoverable || (!draft && session.document === session.original)}
          onClick={() => setRestoring(true)}>恢复原稿</button>
      </>}
    </div>
    {busy && <p className="timeline-inline-note" role="status">正在读取或保存字幕…</p>}
    {error && <div role="alert"><NoticeBox kind="error">{error}</NoticeBox></div>}
    {unrecoverable && <NoticeBox kind="error">文件包含无法恢复的 SRT 结构。请修正源文件后重新打开。下方可查看已识别的字幕和诊断。</NoticeBox>}
    {!session ? <div className="timeline-card"><EmptyState title="打开 SRT 开始校时" description="可拖动字幕、修剪入点或出点，也可直接输入毫秒时间。其他格式请先在工具箱中显式转换成 SRT。" /></div> : <>
      <div key={`editor-${document?.id}`} className="timeline-editor" style={{ gridTemplateColumns: `minmax(0, ${leftWidth}fr) minmax(0, ${100 - leftWidth}fr)` }}>
        <section className="timeline-card timeline-list-panel" aria-label="字幕列表与搜索">
          <div className="timeline-panel-heading"><h2>字幕列表</h2><span>{cues.length} 条</span></div>
          <SubtitleList cues={cues} selectedIds={selectedIds} overlapping={layout.overlapping} disabled={busy || !!draft} onSelect={listSelect} />
          <div className="button-row">
            <button type="button" className="button secondary small" disabled={controlsDisabled} onClick={() => edit(current => {
              const next = insertCue(current, playheadMs);
              setSelectedIds([next.document.cues.at(-1)!.id]);
              return next;
            })}><Plus size={15} />插入字幕</button>
            <button type="button" className="button secondary small" disabled={controlsDisabled || !selectedIds.length} onClick={() => edit(current => deleteCues(current, selectedIds))}>
              <Trash2 size={15} />删除字幕
            </button>
          </div>
        </section>
        <section className="timeline-card timeline-inspector" aria-label="字幕检查器">
          <div className="timeline-panel-heading"><h2>字幕检查器</h2>
            {cue && <span>#{numbers.get(cue.id)} · {cue.endMs - cue.startMs} ms</span>}
            {selectedIds.length > 1 && <span>已选 {selectedIds.length} 条</span>}
          </div>
          {cue && fields ? <form className="timeline-cue-form" onSubmit={event => {
            event.preventDefault();
            try { applyFields(session); }
            catch (problem) { setError(errorText(problem)); }
          }}>
            <div className="timeline-time-fields">
              <label className="field">开始时间<input value={fields.start} disabled={busy || unrecoverable} onChange={event => updateFields({ start: event.target.value })} /></label>
              <label className="field">结束时间<input value={fields.end} disabled={busy || unrecoverable} onChange={event => updateFields({ end: event.target.value })} /></label>
            </div>
            <label className="field">字幕正文<textarea rows={2} value={fields.text} disabled={busy || unrecoverable} onChange={event => updateFields({ text: event.target.value })} /></label>
            <div className="button-row">
              <button type="submit" className="button primary small" disabled={!draft || busy || unrecoverable}>应用编辑</button>
              <button type="button" className="button secondary small" disabled={!draft || busy} onClick={() => { setDraft(null); setError(''); }}>取消编辑</button>
              <button type="button" className="button secondary small" disabled={busy} onClick={() => { setPlayheadMs(cue.startMs); view.current?.reveal(cue.startMs, cue.id); }}>定位字幕</button>
            </div>
          </form> : <p className="timeline-inline-note">{selectedIds.length > 1 ? '可拖动或按方向键将选中的字幕一起平移。' : '在列表或轨道上选择一条字幕进行编辑。'}</p>}
          <label className="timeline-step">微调步长 <select value={step} onChange={event => setStep(Number(event.target.value))}>
            {[10, 50, 100].map(value => <option value={value} key={value}>{value} ms</option>)}
          </select></label>
        </section>
      </div>
      <TimelineView key={`track-${document?.id}`} ref={view} index={index} layout={layout} numbers={numbers} selectedIds={selectedIds}
        playheadMs={playheadMs} disabled={busy || !!draft} editDisabled={unrecoverable} onSelect={select} onSeek={setPlayheadMs}
        onCommit={changes => edit(current => replaceCues(current, changes))} onError={setError} />
      <div className="timeline-summary" role="status">
        <strong>{document?.fileName}</strong><span>{cues.length} 条 · SRT · {document?.encoding} · {document?.lineEnding}</span>
        <span>{formatTimestamp(playheadMs, '.')}</span><span>{dirty ? '有未保存修改' : '无未保存修改'}</span>
        <span>{layout.overlapping.size} 条重叠 · {diagnosticErrors} 个错误</span>
      </div>
      {savedPath && <p className="timeline-inline-note" role="status">最近已导出 {savedPath}</p>}
      <div className="button-row">
        <button type="button" className="button secondary small" aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(value => !value)}>保存前检查（{diagnostics.length}）</button>
        <button type="button" className="button secondary small" aria-expanded={showDiff} onClick={() => setShowDiff(value => !value)}>与上次保存对比</button>
      </div>
      {showDiagnostics && <section className="timeline-card timeline-diagnostics" aria-label="字幕诊断">
        {diagnostics.length ? <ul>{diagnostics.slice(diagStart, diagStart + 20).map((issue, i) => <li key={i}>
          <strong>{issue.severity === 'error' ? '错误' : '提示'} · {issue.code}</strong> {issue.line ? `第 ${issue.line} 行 · ` : issue.cueIndex ? `第 ${issue.cueIndex} 条 · ` : ''}{issue.message}
        </li>)}</ul> : <p>当前没有校验提示。</p>}
        {diagnostics.length > 20 && <div className="button-row">
          <button type="button" className="button secondary small" disabled={!diagnosticPage} onClick={() => setDiagnosticPage(diagnosticPage - 1)}>上一页</button>
          <span>{diagnosticPage + 1} / {Math.ceil(diagnostics.length / 20)}</span>
          <button type="button" className="button secondary small" disabled={diagStart + 20 >= diagnostics.length} onClick={() => setDiagnosticPage(diagnosticPage + 1)}>下一页</button>
        </div>}
      </section>}
      {showDiff && <SubtitleDiffPreview before={session.saved} after={cues} partialOutput={false} />}
    </>}
    {restoring && <ActionDialog title="恢复原稿" confirmLabel="恢复并清除撤销记录" danger onClose={() => setRestoring(false)} onConfirm={() => {
      if (session) applySession(restoreOriginal(session));
      setDraft(null);
    }}>恢复到打开字幕时的内容。已导出的文件会保留。</ActionDialog>}
    {action && <Modal title={dirty ? '有未保存修改' : '正在处理字幕文件'} onCancel={cancelExit}>
      <p>{dirty ? '可以另存为新的 SRT，再继续当前操作。' : '请等待文件操作结束。'}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="button-row end">
        <button type="button" className="button secondary" disabled={busy} onClick={cancelExit}>取消</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void continueExit(false)}>放弃修改</button>
        <button type="button" className="button primary" disabled={busy || unrecoverable} onClick={() => void continueExit(true)}>保存并继续</button>
      </div>
    </Modal>}
  </section>;
}
