import { useState } from 'react';
import { History as HistoryIcon, Search, Trash2, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../stores/app-store';
import { clearHistory } from '../services/history-service';
import { isDesktop } from '../services/file-service';
import { ConfirmDialog, EmptyState, OpenFolderButton, PageHeading, errorText } from '../components/common';

export function HistoryPage() {
  const history = useAppStore(s => s.history); const notify = useAppStore(s => s.notify); const [query, setQuery] = useState(''); const [confirming, setConfirming] = useState(false);
  const filtered = history.filter(h => `${h.toolName} ${h.summary}`.includes(query));
  const clear = async () => { try { await clearHistory(); await useAppStore.getState().refreshHistory(); notify('处理记录已清理。', 'success'); } catch (error) { notify(errorText(error), 'error'); } };
  return <><PageHeading eyebrow="每一次处理，都有迹可循" title="处理记录" description="仅保留最近 200 次任务的摘要，不保存字幕全文。" action={<button className="button secondary" disabled={!history.length} onClick={() => setConfirming(true)}><Trash2 size={16} />清理记录</button>} />
    {history.length > 0 && <div className="search-input history-search"><Search size={17} /><input aria-label="搜索处理记录" placeholder="搜索工具或处理摘要…" value={query} onChange={e => setQuery(e.target.value)} /></div>}
    {!filtered.length ? <div className="panel"><EmptyState icon={<HistoryIcon size={27} />} title={history.length ? '没有匹配的记录' : '还没有处理记录'} description={history.length ? '请尝试其他关键词。' : '选择一个工具完成处理，任务摘要会保存在这里。'} action={!history.length && <Link to="/tools" className="button primary">选择工具</Link>} /></div> : <div className="history-list">{filtered.map(h => <details className="panel history-item" key={h.id}><summary><div className="history-icon"><HistoryIcon size={20} /></div><div className="history-title"><h3>{h.toolName}</h3><time>{new Date(h.createdAt).toLocaleString('zh-CN')}</time></div><div className="history-counts"><span>{h.inputCount} 个文件</span><span className={h.failedCount ? 'error-text' : 'success-text'}>{h.successCount} 成功 / {h.failedCount} 失败</span></div><ChevronDown size={17} /></summary><div className="history-detail"><p>{h.summary}</p>{h.outputPaths?.length ? <ul>{h.outputPaths.map((p, i) => <li className="mono" key={i}>{p}</li>)}</ul> : <p className="muted">未导出文件。预览结果仅在本次工作空间内保留。</p>}{h.outputDirectory && isDesktop() && <OpenFolderButton path={h.outputDirectory} />}</div></details>)}</div>}
    {confirming && <ConfirmDialog title="清理全部处理记录？" description="此操作只删除任务摘要，不会删除任何输入或输出文件。" onConfirm={() => void clear()} onClose={() => setConfirming(false)} />}
  </>;
}
