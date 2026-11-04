import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Search, ArrowUpRight, ArrowLeft, Plus, LayoutGrid } from 'lucide-react';
import { categories, categoryIcons, tools } from '../app/tool-registry';
import { EmptyState, PageHeading } from '../components/common';
import { ToolWorkspace } from '../components/tool-workspace';

export function Toolbox() {
  const [query, setQuery] = useState(''); const [category, setCategory] = useState('全部工具');
  const filtered = tools.filter(t => (category === '全部工具' || t.category === category) && `${t.name} ${t.description} ${t.keywords.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading eyebrow="实用工具，触手可及" title="全部工具" description={`${tools.length} 个实用工具，覆盖字幕处理的每一步。`} action={<Link to="/template" className="button secondary"><Plus size={16} />空白字幕模板</Link>} />
    <div className="toolbox-toolbar"><div className="search-input"><Search size={17} /><input id="tool-search" aria-label="搜索工具" placeholder="搜索工具名称或关键词…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>Ctrl F</kbd></div></div>
    <div className="category-tabs" aria-label="工具分类">{['全部工具', ...categories].map(c => { const Icon = categoryIcons[c] ?? LayoutGrid; return <button key={c} className={c === category ? 'active' : ''} onClick={() => setCategory(c)}><Icon size={15} />{c}</button>; })}</div>
    {filtered.length ? <div className="tool-grid full-grid">{filtered.map(t => { const Icon = t.icon; return <Link key={t.id} className="tool-card" to={`/tools/${t.id}`}><span className="tool-icon"><Icon size={22} strokeWidth={1.7} /></span><span className="tool-category">{t.category}</span><ArrowUpRight className="card-arrow" size={17} /><h3>{t.name}</h3><p>{t.description}</p></Link>; })}</div> : <EmptyState icon={<Search size={25} />} title="没有找到匹配的工具" description="试试“时间”“合并”或“文本”等关键词。" action={<button className="button secondary" onClick={() => { setQuery(''); setCategory('全部工具'); }}>清除筛选</button>} />}
  </>;
}
export function ToolDetail() {
  const { id } = useParams(); const definition = tools.find(t => t.id === id);
  if (!definition) return <EmptyState title="找不到这个工具" description="请从工具列表中选择一个工具。" action={<Link className="button primary" to="/tools">查看全部工具</Link>} />;
  return <><Link className="back-link" to="/tools"><ArrowLeft size={15} />全部工具</Link><PageHeading eyebrow={definition.category} title={definition.name} description={definition.description} /><ToolWorkspace key={id} definition={definition} /></>;
}
