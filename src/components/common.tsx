import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X, LoaderCircle, FileText, ArrowUp, ArrowDown, Trash2, Upload, Plus, FolderOpen, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../stores/app-store';
import { isDesktop, pickFiles, readBrowserFiles, subscribeFileDrop, openOutputDirectory } from '../services/file-service';
import { FolderImport } from './folder-import';

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export function formatSize(n: number): string { return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`; }
export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon ?? <FileText size={25} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function NoticeBox({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warning' | 'error' | 'success' }) { const Icon = kind === 'error' || kind === 'warning' ? AlertCircle : kind === 'success' ? CheckCircle2 : Info; return <div className={`notice-box ${kind}`}><Icon size={17} /><div>{children}</div></div>; }
export function BusyLabel({ children }: { children: ReactNode }) { return <><LoaderCircle size={17} className="spin" />{children}</>; }
export function Toasts() {
  const notices = useAppStore(s => s.notices); const dismiss = useAppStore(s => s.dismiss);
  return <div className="toasts" aria-live="polite">{notices.map(n => <div className={`toast ${n.kind}`} key={n.id}><span>{n.message}</span><button className="icon-button" aria-label="关闭提示" onClick={() => dismiss(n.id)}><X size={16} /></button></div>)}</div>;
}
export function ConfirmDialog({ title, description, onConfirm, onClose }: { title: string; description: string; onConfirm: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onCancel={onClose} className="confirm-dialog"><h2>{title}</h2><p>{description}</p><div className="button-row end"><button className="button secondary" onClick={onClose}>取消</button><button className="button danger" onClick={() => { onConfirm(); onClose(); }}>确认清理</button></div></dialog>;
}
export function useFileImport() {
  const [loading, setLoading] = useState(false); const addFiles = useAppStore(s => s.addFiles); const notify = useAppStore(s => s.notify);
  const choose = async () => { setLoading(true); try { const files = await pickFiles(); if (useAppStore.getState().busy) notify('当前处理尚未完成，请完成后重新添加文件。'); else addFiles(files); } catch (error) { notify(errorText(error), 'error'); } finally { setLoading(false); } };
  return { choose, loading };
}
export function FileSelector({ compact = false }: { compact?: boolean }) {
  const { choose, loading } = useFileImport(); const busy = useAppStore(s => s.busy); const addFiles = useAppStore(s => s.addFiles); const notify = useAppStore(s => s.notify); const [dragging, setDragging] = useState(false);
  return <div className={`dropzone ${compact ? 'compact' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={async event => {
    event.preventDefault(); setDragging(false); if (busy || isDesktop()) return;
    try { const imported = await readBrowserFiles(event.dataTransfer.files); if (useAppStore.getState().busy) notify('当前处理尚未完成，请完成后重新添加文件。'); else addFiles(imported); } catch (error) { notify(errorText(error), 'error'); }
  }}><div className="upload-mark"><Upload size={compact ? 22 : 30} strokeWidth={1.6} /></div><div className="dropzone-copy"><h2>{compact ? '添加要处理的字幕文件' : '把字幕文件拖到这里'}</h2><p>{compact ? '支持多选，也可以继续拖入文件' : '一次导入一份或多份字幕，所有处理都在本地完成'}</p></div><button className="button primary" disabled={loading || busy} onClick={() => void choose()}>{loading ? <BusyLabel>读取中</BusyLabel> : <><Plus size={17} />选择文件</>}</button>{isDesktop() && <FolderImport />}<span className="supported-formats">SRT · VTT · ASS · SSA · CSV · 带时间的 TXT</span>{!compact && <span className="dropzone-privacy"><ShieldCheck size={14} /> 本地处理，保护你的内容</span>}</div>;
}
export function NativeDropHandler() {
  const addFiles = useAppStore(s => s.addFiles); const notify = useAppStore(s => s.notify);
  useEffect(() => {
    if (!isDesktop()) return;
    let stopped = false; let unlisten: (() => void) | undefined;
    void subscribeFileDrop(imported => { if (!stopped && !useAppStore.getState().busy) addFiles(imported); }, error => { if (!stopped) notify(errorText(error), 'error'); }).then(cleanup => { if (stopped) cleanup(); else unlisten = cleanup; }).catch(error => notify(errorText(error), 'error'));
    return () => { stopped = true; unlisten?.(); };
  }, [addFiles, notify]);
  return null;
}
export function FileList({ disabled = false }: { disabled?: boolean }) {
  const files = useAppStore(s => s.files); const remove = useAppStore(s => s.removeFile); const move = useAppStore(s => s.moveFile); const clear = useAppStore(s => s.clearFiles);
  if (!files.length) return null;
  return <section className="file-list"><div className="section-heading"><h3>已选文件 <span className="count">{files.length}</span></h3><button className="text-button" disabled={disabled} onClick={clear}><Trash2 size={14} />清空</button></div><div className="file-rows">{files.map((f, i) => <div className="file-row" key={f.id}><div className="file-symbol"><FileText size={19} /></div><div className="file-description"><strong title={f.name}>{f.name}</strong><span>{formatSize(f.size)} <span className="muted-dot">·</span> {f.name.split('.').at(-1)?.toUpperCase() ?? '未知格式'}{f.error && <span className="error-text"> · {f.error}</span>}</span></div><div className="file-actions"><button className="icon-button" disabled={disabled || i === 0} aria-label={`上移 ${f.name}`} title="上移" onClick={() => move(f.id, -1)}><ArrowUp size={15} /></button><button className="icon-button" disabled={disabled || i === files.length - 1} aria-label={`下移 ${f.name}`} title="下移" onClick={() => move(f.id, 1)}><ArrowDown size={15} /></button><button className="icon-button" disabled={disabled} aria-label={`移除 ${f.name}`} title="移除" onClick={() => remove(f.id)}><X size={16} /></button></div></div>)}</div></section>;
}
export function OpenFolderButton({ path }: { path: string }) { const notify = useAppStore(s => s.notify); return <button className="button secondary small" onClick={() => { void openOutputDirectory(path).catch(error => notify(errorText(error), 'error')); }}><FolderOpen size={15} />打开目录</button>; }
