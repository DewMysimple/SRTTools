import { version as appVersion } from '../../package.json';
import { useState } from 'react';
import { Sun, Moon, Monitor, FolderOpen, Save, Trash2, X, Subtitles, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../stores/app-store';
import type { AppSettings } from '../services/settings-service';
import { clearHistory } from '../services/history-service';
import { isDesktop, pickDirectory } from '../services/file-service';
import { ExplorerIntegration } from '../components/explorer-integration';
import { BusyLabel, ConfirmDialog, NoticeBox, PageHeading, errorText } from '../components/common';
import { DraftRecoveryLink } from '../features/timeline/DraftRecoveryPanel';

export function SettingsPage() {
  const settings = useAppStore(s => s.settings); const update = useAppStore(s => s.updateSettings); const notify = useAppStore(s => s.notify);
  const [draft, setDraft] = useState<AppSettings>(settings); const [saving, setSaving] = useState(false); const [confirming, setConfirming] = useState(false);
  const save = async () => { setSaving(true); try { await update(draft); notify('设置已保存。', 'success'); } catch (error) { notify(errorText(error), 'error'); } finally { setSaving(false); } };
  const chooseDirectory = async () => { try { const path = await pickDirectory(); if (path) setDraft({ ...draft, outputDirectory: path }); } catch (error) { notify(errorText(error), 'error'); } };
  return <><PageHeading eyebrow="适合你的使用习惯" title="设置" description="调整外观与导出偏好，设置仅保存在本机。" action={<button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? <BusyLabel>保存中</BusyLabel> : <><Save size={16} />保存设置</>}</button>} />
    <div className="settings-stack"><section className="panel settings-section"><div><h2>外观</h2><p>选择适合当前环境的显示主题</p></div><div className="theme-options">{([['light', '浅色', Sun], ['dark', '深色', Moon], ['system', '跟随系统', Monitor]] as const).map(([value, label, Icon]) => <button className={draft.theme === value ? 'active' : ''} aria-pressed={draft.theme === value} key={value} onClick={() => setDraft({ ...draft, theme: value })}><Icon size={22} />{label}</button>)}</div><div className="field language-field"><label htmlFor="app-language">界面语言</label><select id="app-language" disabled value="zh-CN"><option value="zh-CN">简体中文</option></select></div></section>
    <section className="panel settings-section"><div><h2>导出偏好</h2><p>每次处理时仍可单独调整这些选项</p></div><div className="field"><label htmlFor="default-directory">默认输出目录</label><div className="directory-field"><input id="default-directory" readOnly value={draft.outputDirectory} placeholder="每次导出时选择" /><button className="button secondary" disabled={!isDesktop()} onClick={() => void chooseDirectory()}><FolderOpen size={16} />选择目录</button>{draft.outputDirectory && <button className="icon-button" aria-label="清除默认输出目录" onClick={() => setDraft({ ...draft, outputDirectory: '' })}><X size={17} /></button>}</div>{!isDesktop() && <small>浏览器预览模式使用下载；桌面版可选择本地目录。</small>}</div><div className="parameter-grid"><div className="field"><label htmlFor="default-name">默认文件名规则</label><input id="default-name" value={draft.fileNamePattern} onChange={e => setDraft({ ...draft, fileNamePattern: e.target.value })} /><small>{'{name} 为原文件名，{index} 为文件序号。默认 {name}_processed'}</small></div><div className="field"><label htmlFor="default-encoding">默认输出编码</label><select id="default-encoding" value={draft.outputEncoding} onChange={e => setDraft({ ...draft, outputEncoding: e.target.value as AppSettings['outputEncoding'] })}><option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gbk">GBK（严格无损）</option><option value="gb18030">GB18030（严格无损）</option></select></div><div className="field"><label htmlFor="default-line-ending">默认换行符</label><select id="default-line-ending" value={draft.lineEnding} onChange={e => setDraft({ ...draft, lineEnding: e.target.value as AppSettings['lineEnding'] })}><option value="CRLF">CRLF · Windows</option><option value="LF">LF · Unix</option></select></div></div><label className="check-label"><input type="checkbox" checked={draft.autoOpenDirectory} onChange={e => setDraft({ ...draft, autoOpenDirectory: e.target.checked })} />导出完成后自动打开输出目录（桌面版）</label><label className="check-label"><input type="checkbox" checked={draft.showPreview} onChange={e => setDraft({ ...draft, showPreview: e.target.checked })} />默认展开处理前后预览</label><NoticeBox>导出时始终保留原文件。目标文件重名时，自动添加序号。</NoticeBox></section>
    <section className="panel settings-section"><div><h2>本地数据</h2><p>历史记录只保存任务摘要，不保存字幕内容</p></div><div className="settings-inline"><span>清理全部处理记录，不会删除文件</span><button className="button secondary" onClick={() => setConfirming(true)}><Trash2 size={15} />清理记录</button></div></section>
    {isDesktop() && <section className="panel settings-section">
      <div><h2>时间轴草稿保护</h2><p>已应用的编辑和原稿对比内容保存在此应用的 Windows 本地数据目录 timeline-drafts。</p></div>
      <label className="check-label"><input type="checkbox" checked={draft.protectTimelineDrafts}
        onChange={event => setDraft({ ...draft, protectTimelineDrafts: event.target.checked })} />自动保护未保存字幕草稿</label>
      <p>关闭后停止自动写入，已有草稿仍可恢复。草稿含字幕正文，请及时另存为并按需清理。</p>
      <DraftRecoveryLink settings />
    </section>}
    <ExplorerIntegration /><section className="panel about-panel"><div className="app-mark"><Subtitles size={25} /></div><div><h2>Subtitle Tools <span className="version">v{appVersion}</span></h2><p>极简、轻量的本地字幕工具箱</p></div><span className="privacy-badge"><ShieldCheck size={15} />本地优先</span></section></div>
    {confirming && <ConfirmDialog title="清理全部处理记录？" description="只清理历史摘要，设置和字幕文件都会保留。" onClose={() => setConfirming(false)} onConfirm={() => { void clearHistory().then(() => useAppStore.getState().refreshHistory()).then(() => notify('处理记录已清理。', 'success')).catch(error => notify(errorText(error), 'error')); }} />}
  </>;
}
