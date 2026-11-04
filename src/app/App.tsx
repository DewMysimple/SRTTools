import { version as appVersion } from '../../package.json';
import { useEffect, useRef, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { House, Grid2X2, Files, History, Settings2, Subtitles, ShieldCheck, Keyboard, X, ChevronRight } from 'lucide-react';
import { useAppStore } from '../stores/app-store';
import { NativeDropHandler, Toasts, useFileImport } from '../components/common';
import { Home } from '../pages/Home';
import { Toolbox, ToolDetail } from '../pages/Toolbox';
import { Batch } from '../pages/Batch';
import { HistoryPage } from '../pages/History';
import { SettingsPage } from '../pages/Settings';
import { TemplatePage } from '../pages/Template';

const navigation = [{ path: '/', label: '首页', icon: House }, { path: '/tools', label: '全部工具', icon: Grid2X2 }, { path: '/batch', label: '批量处理', icon: Files }, { path: '/history', label: '处理记录', icon: History }, { path: '/settings', label: '设置', icon: Settings2 }];
export function App() {
  const initialize = useAppStore(s => s.initialize); const initialized = useAppStore(s => s.initialized); const theme = useAppStore(s => s.settings.theme);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => { const media = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [theme]);
  return <HashRouter>{initialized ? <AppLayout /> : <div className="app-loading"><Subtitles size={35} /><p>正在打开工作空间…</p></div>}<Toasts /></HashRouter>;
}
function AppLayout() {
  const files = useAppStore(s => s.files); const busy = useAppStore(s => s.busy); const location = useLocation(); const navigate = useNavigate(); const { choose, loading } = useFileImport(); const [help, setHelp] = useState(false); const main = useRef<HTMLElement>(null);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [location.pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (busy || loading || event.altKey || event.metaKey) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); if (event.shiftKey) navigate('/batch'); void choose(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f') { const field = document.getElementById('tool-search') ?? document.getElementById('param-find'); if (field) { event.preventDefault(); field.focus(); } }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [busy, loading, navigate, choose]);
  const active = navigation.find(n => n.path !== '/' && location.pathname.startsWith(n.path)) ?? navigation[0];
  return <div className="app-shell" onClickCapture={event => { if (busy && event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault(); }}><aside className="sidebar"><LinkBrand /><span className="sidebar-caption">工作空间</span><nav aria-label="主导航">{navigation.map(n => { const Icon = n.icon; return <NavLink key={n.path} to={n.path} end={n.path === '/'} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'} aria-disabled={busy} onClick={e => { if (busy) e.preventDefault(); }}><Icon size={19} strokeWidth={1.8} /><span>{n.label}</span>{n.path === '/batch' && files.length > 0 && <span className="nav-count">{files.length}</span>}</NavLink>; })}</nav><div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={18} /><div><strong>安心在本地处理</strong><span>字幕内容不会离开你的电脑</span></div></div><button className="help-button" onClick={() => setHelp(true)}><Keyboard size={16} />使用指南与快捷键</button><div className="sidebar-version"><span>Subtitle Tools</span><span>v{appVersion}</span></div></div></aside><div className="main-shell"><header className="topbar"><span>工作空间<ChevronRight size={13} /><strong>{location.pathname === '/template' ? '空白模板' : active.label}</strong></span><span className="offline-status"><i />本地模式</span></header><main ref={main} className="main-content"><div className="content-container"><Routes><Route path="/" element={<Home />} /><Route path="/tools" element={<Toolbox />} /><Route path="/tools/:id" element={<ToolDetail />} /><Route path="/batch" element={<Batch />} /><Route path="/history" element={<HistoryPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="/template" element={<TemplatePage />} /><Route path="*" element={<Home />} /></Routes></div></main></div><NativeDropHandler />{help && <HelpDialog onClose={() => setHelp(false)} />}</div>;
}
function LinkBrand() { return <div className="brand"><span className="app-mark"><Subtitles size={25} strokeWidth={1.8} /></span><div><strong>Subtitle Tools</strong><span>本地字幕工具箱</span></div></div>; }
function HelpDialog({ onClose }: { onClose: () => void }) { const dialog = useRef<HTMLDialogElement>(null); useEffect(() => { dialog.current?.showModal(); }, []); return <dialog ref={dialog} onCancel={onClose} className="help-dialog"><div className="section-heading"><h2>使用指南与快捷键</h2><button className="icon-button" aria-label="关闭使用指南" onClick={onClose}><X size={19} /></button></div><p>选择或拖入字幕 → 选择工具 → 设置参数 → 预览 → 确认导出。</p><p>遇到异常字幕，先使用“字幕检测”查看原因；有歧义的时间问题需要你选择修复策略。原文件始终保留。</p><dl className="shortcut-list"><div><dt>打开文件</dt><dd><kbd>Ctrl O</kbd></dd></div><div><dt>批量添加文件</dt><dd><kbd>Ctrl Shift O</kbd></dd></div><div><dt>导出当前结果（多个文件为 ZIP）</dt><dd><kbd>Ctrl S</kbd></dd></div><div><dt>聚焦工具搜索或查找输入框</dt><dd><kbd>Ctrl F</kbd></dd></div><div><dt>关闭弹窗</dt><dd><kbd>Esc</kbd></dd></div></dl><button className="button primary" onClick={onClose}>知道了</button></dialog>; }
