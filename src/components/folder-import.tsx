import { useEffect, useId, useRef, useState } from 'react';
import { FolderPlus, LoaderCircle, Square } from 'lucide-react';
import { importFolder, SUBTITLE_EXTENSIONS, type FolderImportSummary } from '../services/file-service';
import { useAppStore } from '../stores/app-store';

export function FolderImport() {
  const busy = useAppStore(state => state.busy);
  const [recursive, setRecursive] = useState(false);
  const [extension, setExtension] = useState('all');
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [phase, setPhase] = useState('');
  const [summary, setSummary] = useState<FolderImportSummary | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const filterId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const choose = async () => {
    const store = useAppStore.getState();
    if (store.busy) return;
    const abort = new AbortController();
    controller.current = abort;
    store.setBusy(true);
    setRunning(true); setCancelling(false); setSummary(null); setPhase('等待选择文件夹');
    try {
      await importFolder({
        recursive, extensions: extension === 'all' ? SUBTITLE_EXTENSIONS : [extension],
        existingFiles: store.files, signal: abort.signal,
        onFile: file => { if (mounted.current) useAppStore.getState().addFiles([file]); },
        onProgress: (next, currentPhase) => {
          if (!mounted.current) return;
          setSummary(next);
          setPhase(currentPhase === 'complete' ? next.cancelled ? '已取消扫描' : '扫描完成' : currentPhase === 'reading' ? '正在读取' : '正在扫描');
        },
      });
    } catch (error) {
      useAppStore.getState().notify(`文件夹导入失败，已加入的文件仍保留：${error instanceof Error ? error.message : String(error)}`, 'error');
      if (mounted.current) setPhase('扫描未完成');
    } finally {
      controller.current = null;
      useAppStore.getState().setBusy(false);
      if (mounted.current) { setRunning(false); setCancelling(false); }
    }
  };

  return <div className="folder-import">
    <div className="folder-import-controls">
      <button className="button secondary" disabled={busy} onClick={() => void choose()}><FolderPlus size={17} />添加文件夹</button>
      <label className="check-label"><input type="checkbox" disabled={busy} checked={recursive} onChange={event => setRecursive(event.target.checked)} />包含子文件夹</label>
      <label className="sr-only" htmlFor={filterId}>文件夹文件类型</label>
      <select id={filterId} disabled={busy} value={extension} onChange={event => setExtension(event.target.value)}>
        <option value="all">全部支持格式</option>
        {SUBTITLE_EXTENSIONS.map(value => <option value={value} key={value}>{value.toUpperCase()}</option>)}
      </select>
      {running && <button className="button secondary small" disabled={cancelling} onClick={() => { setCancelling(true); controller.current?.abort(); }}>
        {cancelling ? <LoaderCircle size={14} className="spin" /> : <Square size={14} />}{cancelling ? '正在取消…' : '取消扫描'}
      </button>}
    </div>
    {phase && <div className="folder-import-status" role="status" aria-live="polite">
      <strong>{running && <LoaderCircle size={13} className="spin" />}{phase}</strong>
      {summary && <>
        <span>已检查 {summary.visitedEntries} 项 · 文件 {summary.scannedFiles} · 已添加 {summary.added} · 重复 {summary.duplicates} · 不支持 {summary.unsupported} · 超限 {summary.overLimit} · 读取失败 {summary.failed} · 目录失败 {summary.unreadableDirectories}</span>
        {(summary.skippedLinks > 0 || summary.depthSkipped > 0) && <span>已跳过链接 {summary.skippedLinks} 项、过深目录 {summary.depthSkipped} 项。</span>}
        {summary.limitStopped && <span>已达到扫描或队列上限，后续内容未扫描。请分批选择更小的文件夹。</span>}
        {summary.cancelled && <span>此前成功加入的文件已保留，未读完的文件未加入。</span>}
      </>}
    </div>}
  </div>;
}
