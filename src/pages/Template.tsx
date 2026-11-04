import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import { encodeText, formatTimestamp } from '../core';
import { saveOutput } from '../services/file-service';
import { useAppStore } from '../stores/app-store';
import { BusyLabel, NoticeBox, PageHeading, errorText } from '../components/common';

export function TemplatePage() {
  const [count, setCount] = useState(10); const [duration, setDuration] = useState(2000); const [gap, setGap] = useState(500); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const notify = useAppStore(s => s.notify); const settings = useAppStore(s => s.settings);
  const generate = () => { if (![count, duration, gap].every(Number.isSafeInteger) || count < 1 || count > 1000 || duration < 1 || gap < 0 || (duration + gap) * count > Number.MAX_SAFE_INTEGER) { notify('条目数应为 1–1000，显示时长应为正整数，间隔应为非负整数。', 'error'); return; } const newline = settings.lineEnding === 'CRLF' ? '\r\n' : '\n'; setText(Array.from({ length: count }, (_, i) => `${i + 1}${newline}${formatTimestamp(i * (duration + gap))} --> ${formatTimestamp(i * (duration + gap) + duration)}${newline}`).join(newline + newline) + newline); };
  const save = async () => { setBusy(true); try { const path = await saveOutput('subtitle_template.srt', encodeText(text, settings.outputEncoding), settings.outputDirectory || undefined); if (path) notify('空白模板已导出。', 'success'); } catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); } };
  return <><PageHeading eyebrow="文件处理" title="生成空白 SRT 模板" description="按你提供的时间规则生成空白条目，再用文本编辑器填写正文。" /><section className="panel settings-section"><NoticeBox>时间由下方规则明确生成。模板正文留空，使用“删除空白字幕”会移除这些条目。</NoticeBox><div className="parameter-grid">{([['条目数量', count, setCount], ['每条显示时长（毫秒）', duration, setDuration], ['条目间隔（毫秒）', gap, setGap]] as const).map(([label, value, setter], i) => <div className="field" key={label}><label htmlFor={`template-${i}`}>{label}</label><input id={`template-${i}`} type="number" step="1" value={Number.isNaN(value) ? '' : value} onChange={e => { setter(e.target.value ? Number(e.target.value) : NaN); setText(''); }} /></div>)}</div><div className="button-row"><button className="button primary" onClick={generate}><Eye size={16} />生成预览</button>{text && <button className="button secondary" disabled={busy} onClick={() => void save()}>{busy ? <BusyLabel>导出中</BusyLabel> : <><Download size={16} />导出模板</>}</button>}</div>{text && <pre className="text-preview">{text.slice(0, 8000)}{text.length > 8000 && '\n… 预览已截断，导出包含全部条目。'}</pre>}</section></>;
}
