import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileArchive, FolderOpen, Square } from 'lucide-react';
import { createPlannedZip, planFolderOutputs, type NamedOutput, type PlannedOutput } from '../services/export-service';
import { finishFolderExport, isDesktop, openOutputDirectory, prepareFolderExport, saveOutput, writeFolderExport, type ImportedFile, type PreparedFolderExport } from '../services/file-service';
import { useAppStore } from '../stores/app-store';
import { BusyLabel, errorText, formatSize, NoticeBox } from './common';

export interface FolderOutputEntry { id: string; input: ImportedFile; output: NamedOutput }
export interface FolderExportState { mode?: 'flat' | 'preserve'; paths: string[]; written: string[]; overrides: Record<string, string> }

/** The reviewed plan is shared by ZIP and native output; neither export recomputes its tree. */
export function FolderExportPanel({ entries, onExported, initialState, onStateChange }: { entries: FolderOutputEntry[]; onExported?: (paths: string[]) => Promise<void> | void; initialState?: FolderExportState; onStateChange?: (state: FolderExportState) => void }) {
  const [mode, setMode] = useState<'flat' | 'preserve'>(() => initialState?.mode ?? (entries.some(entry => entry.input.folderSource) ? 'preserve' : 'flat'));
  const [prepared, setPrepared] = useState<PreparedFolderExport | null>(null);
  const [paths, setPaths] = useState<string[]>(initialState?.paths ?? []);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [written, setWritten] = useState<string[]>(initialState?.written ?? []);
  const [overrides, setOverrides] = useState<Record<string, string>>(initialState?.overrides ?? {});
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState('');
  const session = useRef<PreparedFolderExport | null>(null);
  const cancelled = useRef(false);
  const zipController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busy = useAppStore(state => state.busy);
  const notify = useAppStore(state => state.notify);
  const plan = useMemo(() => {
    try { return { outputs: planFolderOutputs(entries, mode), error: '' }; }
    catch (error) { return { outputs: [], error: errorText(error) }; }
  }, [entries, mode]);
  const displayed = plan.outputs.map(output => {
    const relativePath = overrides[output.id];
    return relativePath ? { ...output, relativePath, renamed: output.renamed || relativePath !== output.relativePath } : output;
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelled.current = true; zipController.current?.abort(); if (session.current) void finishFolderExport(session.current.exportId).catch(() => undefined); };
  }, []);
  const closeSession = async () => {
    const current = session.current;
    session.current = null;
    if (current) await finishFolderExport(current.exportId);
    if (mounted.current) setPrepared(null);
  };
  const reportPaths = async (next: string[]) => {
    if (!mounted.current) return;
    setPaths(next);
    await onExported?.(next);
  };
  const zip = async () => {
    if (useAppStore.getState().busy || !displayed.length) return;
    useAppStore.getState().setBusy(true); setWorking(true); setProgress('正在生成 ZIP'); zipController.current = new AbortController();
    try {
      const bytes = await createPlannedZip(displayed, { signal: zipController.current.signal, onProgress: percent => { if (mounted.current) setProgress(`正在生成 ZIP · ${Math.floor(percent)}%`); } });
      const path = await saveOutput('subtitle-tools_results.zip', bytes);
      if (path) { const nextPaths = [...paths, path]; await reportPaths(nextPaths); onStateChange?.({ mode, paths: nextPaths, written, overrides }); notify('ZIP 已导出，源文件保持不变。', 'success'); }
    } catch (error) { notify(error instanceof Error && error.name === 'AbortError' ? 'ZIP 导出已取消，处理结果仍保留。' : `ZIP 导出失败：${errorText(error)}`, error instanceof Error && error.name === 'AbortError' ? 'info' : 'error'); }
    finally { zipController.current = null; useAppStore.getState().setBusy(false); if (mounted.current) { setWorking(false); setProgress(''); } }
  };
  const prepare = async () => {
    if (useAppStore.getState().busy) return;
    useAppStore.getState().setBusy(true); setWorking(true);
    try {
      await closeSession();
      const pending = displayed.filter(output => !written.includes(output.id));
      if (!pending.length) { notify('本轮结果均已写入；重新处理后可再次导出。'); return; }
      const next = await prepareFolderExport(pending);
      if (!mounted.current) { if (next) await finishFolderExport(next.exportId); return; }
      session.current = next; setPrepared(next);
      if (next) { const nextOverrides = { ...overrides, ...Object.fromEntries(next.entries.map(entry => [entry.id, entry.relativePath])) }; setOverrides(nextOverrides); onStateChange?.({ mode, paths, written, overrides: nextOverrides }); }
      if (next) setProgress('已检查目标目录，请核对下方路径后确认写入');
    } catch (error) { notify(`无法准备输出目录：${errorText(error)}`, 'error'); }
    finally { useAppStore.getState().setBusy(false); if (mounted.current) setWorking(false); }
  };
  const write = async () => {
    const current = session.current;
    if (!current || useAppStore.getState().busy) return;
    useAppStore.getState().setBusy(true); setWorking(true); cancelled.current = false;
    const completed = [...written]; const nextPaths = [...paths]; const errors: Record<string, string> = {}; const nextOverrides = { ...overrides };
    try {
      for (const reservation of current.entries) {
        if (cancelled.current || !mounted.current) break;
        const output = displayed.find(item => item.id === reservation.id);
        if (!output || completed.includes(output.id)) continue;
        setProgress(`正在导出 ${completed.length + 1} / ${displayed.length} · ${reservation.relativePath}`);
        if (reservation.error) { errors[reservation.id] = reservation.error; continue; }
        try {
          const result = await writeFolderExport(current.exportId, output.id, output.bytes);
          completed.push(output.id); nextPaths.push(result.path);
          nextOverrides[output.id] = result.relativePath;
          if (result.relativePath !== output.relativePath) notify(`目标出现重名，已避让为 ${result.relativePath}。`);
          if (mounted.current) { setWritten([...completed]); setOverrides({ ...nextOverrides }); onStateChange?.({ mode, paths: [...nextPaths], written: [...completed], overrides: { ...nextOverrides } }); }
        } catch (error) { if (!cancelled.current) errors[output.id] = errorText(error); }
      }
      await reportPaths(nextPaths);
      if (mounted.current) { setFailures(errors); setProgress(cancelled.current ? '已取消导出，已写入的完整文件保留，可重试未完成项' : `目录导出结束：${completed.length} 成功、${Object.keys(errors).length} 失败`); }
    } finally {
      try { await closeSession(); } catch (error) { notify(`输出会话释放失败：${errorText(error)}`, 'error'); }
      useAppStore.getState().setBusy(false); if (mounted.current) setWorking(false);
    }
  };
  const changeMode = async (value: 'flat' | 'preserve') => {
    try { await closeSession(); setMode(value); setFailures({}); setWritten([]); setOverrides({}); onStateChange?.({ mode: value, paths, written: [], overrides: {} }); setProgress(''); }
    catch (error) { notify(errorText(error), 'error'); }
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); if (displayed.length > 1) void zip(); else if (isDesktop()) void prepare(); else if (!useAppStore.getState().busy && displayed[0]) { void saveOutput(displayed[0].name, displayed[0].bytes).then(path => { if (path) return reportPaths([...paths, path]); }).catch(error => notify(errorText(error), 'error')); } }
      if (event.key === 'Escape' && working) { cancelled.current = true; zipController.current?.abort(); if (session.current) void finishFolderExport(session.current.exportId).catch(error => notify(errorText(error), 'error')); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  return <div className="export-panel folder-export-panel">
    <div className="section-heading"><div><h3>确认并导出</h3><p className="small-copy muted">执行成功不代表已写入磁盘。核对路径后导出；源文件保持不变，重名自动避让。</p></div></div>
    <div className="field"><label htmlFor="folder-output-mode">输出目录结构</label><select id="folder-output-mode" disabled={busy || written.length > 0} value={mode} onChange={event => void changeMode(event.target.value as 'flat' | 'preserve')}><option value="flat">全部平铺输出</option><option value="preserve">保持输入目录层级</option></select><small>多输入根目录使用可见根别名分组；浏览器使用 ZIP 保持目录。</small></div>
    {plan.error && <NoticeBox kind="error">{plan.error}</NoticeBox>}
    {prepared && <NoticeBox>目标目录：<span className="path-text">{prepared.directory}</span>目录与源根重叠时拒绝写入。下列路径包含磁盘已有文件的重名避让结果。</NoticeBox>}
    <div className="output-tree" role="region" aria-label="输出文件树预览" tabIndex={0}>
      <p>输出 {displayed.length} 个文件 · {formatSize(displayed.reduce((size, output) => size + output.bytes.byteLength, 0))}</p>
      <ul>{displayed.map((output: PlannedOutput) => <li key={output.id}><span className="path-text">{output.inputRelativePath} → <strong>{output.relativePath}</strong></span><small>{output.renamed && '已规范化或避让重名 · '}{written.includes(output.id) ? '已写入' : failures[output.id] || prepared?.entries.find(entry => entry.id === output.id)?.error || '待导出'}</small></li>)}</ul>
    </div>
    <div className="button-row">
      <button type="button" className="button secondary" disabled={busy || !displayed.length} onClick={() => void zip()}><FileArchive size={16} />导出 ZIP</button>
      {isDesktop() ? <><button type="button" className="button secondary" disabled={busy || !displayed.length || written.length === displayed.length} onClick={() => void prepare()}><FolderOpen size={16} />{written.length ? '重试未导出项：选择目录' : '选择输出目录并预览'}</button>{prepared && <button type="button" className="button primary" disabled={busy} onClick={() => void write()}><Download size={16} />确认导出到目录</button>}</> : displayed.length === 1 && <button type="button" className="button primary" disabled={busy} onClick={() => { void saveOutput(displayed[0].name, displayed[0].bytes).then(path => { if (path) return reportPaths([...paths, path]); }).catch(error => notify(errorText(error), 'error')); }}><Download size={16} />另存为</button>}
      {working && (session.current || zipController.current) && <button type="button" className="button secondary" onClick={() => { cancelled.current = true; zipController.current?.abort(); if (session.current) void finishFolderExport(session.current.exportId).catch(error => notify(errorText(error), 'error')); }}><Square size={14} />取消导出</button>}
    </div>
    {progress && <p role="status" aria-live="polite">{working ? <BusyLabel>{progress}</BusyLabel> : progress}</p>}
    {paths.length > 0 && <NoticeBox kind="success"><div className="export-success"><span>已导出 {paths.length} 个文件。{isDesktop() && <span className="path-text">{paths.at(-1)}</span>}</span>{isDesktop() && <button type="button" className="button secondary small" disabled={busy} onClick={() => { void openOutputDirectory(paths.at(-1)!).catch(error => notify(errorText(error), 'error')); }}><FolderOpen size={14} />打开输出目录</button>}</div></NoticeBox>}
  </div>;
}
