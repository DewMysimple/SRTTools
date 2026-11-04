import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ShieldCheck, FolderOpen, Plus, Check, Files, Clock3 } from 'lucide-react';
import { FileSelector, FileList, PageHeading } from '../components/common';
import { useAppStore } from '../stores/app-store';
import { quickToolIds, tools } from '../app/tool-registry';

export function Home() {
  const files = useAppStore(s => s.files); const history = useAppStore(s => s.history);
  return <>
    <PageHeading eyebrow="你的本地字幕工作台" title="让字幕处理，简单一点。" description="从文字清理到格式转换，在这里轻松完成。" action={<span className="privacy-badge"><ShieldCheck size={15} />文件不上传云端</span>} />
    <FileSelector />
    {files.length > 0 && <div className="panel home-selected"><FileList /><div className="button-row end"><Link to="/batch" className="button secondary"><Files size={16} />批量处理</Link><Link to="/tools/detect" className="button primary">先检测一下<ArrowRight size={16} /></Link></div></div>}
    <section className="home-tools"><div className="section-heading"><div><h2>常用工具</h2><p>日常字幕处理，从这些工具开始</p></div><Link to="/tools" className="text-button">查看全部工具<ArrowRight size={15} /></Link></div><div className="tool-grid quick-grid">{quickToolIds.map(id => { const definition = tools.find(t => t.id === id)!; const Icon = definition.icon; return <Link to={`/tools/${id}`} className="tool-card" key={id}><span className={`tool-icon tint-${id}`}><Icon size={22} strokeWidth={1.7} /></span><ArrowUpRight className="card-arrow" size={17} /><h3>{definition.name}</h3><p>{definition.description}</p></Link>; })}</div></section>
    <div className="home-bottom-grid"><section className="panel recent-panel"><div className="section-heading"><h2>最近处理</h2><Link to="/history" className="text-button">全部记录<ArrowRight size={14} /></Link></div>{history.length ? <div className="recent-list">{history.slice(0, 3).map(item => <Link to="/history" key={item.id}><span className="recent-icon"><Clock3 size={18} /></span><div><strong>{item.toolName}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {item.inputCount} 个文件</small></div><span className="status-badge success">{item.successCount} 成功</span></Link>)}</div> : <div className="recent-empty"><FolderOpen size={27} strokeWidth={1.4} /><div><strong>还没有处理记录</strong><p>完成一次处理后，记录会显示在这里。</p></div></div>}</section><section className="batch-callout"><div className="batch-callout-icon"><Files size={23} /></div><h2>多个文件，一次完成</h2><p>相同操作无需重复设置。添加文件，批量预览，再统一导出。</p><Link to="/batch" className="text-button">进入批量处理<ArrowRight size={16} /></Link></section></div>
    <div className="home-footer"><span><Check size={14} />保留原文件</span><span><Check size={14} />支持批量导出</span><Link to="/template"><Plus size={14} />生成空白 SRT 模板</Link></div>
  </>;
}
