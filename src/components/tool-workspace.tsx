import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Eye, RotateCcw, Square, Check, ChevronDown, ChevronRight, FileArchive, AlertTriangle, Files, ArrowRight, FolderOpen } from 'lucide-react';
import type { ToolDefinition } from '../app/tool-registry';
import { defaultParameters, validateParameters } from '../app/tool-registry';
import { useAppStore } from '../stores/app-store';
import { processFiles, processCombinedFiles, initialTask, type ProcessedTask, type ProcessedOutput, type ProcessingOptions } from '../services/processing-service';
import { createZip, uniqueOutputNames } from '../services/export-service';
import { appendHistory, type HistoryRecord } from '../services/history-service';
import { isDesktop, pickDirectory, saveOutput, openOutputDirectory } from '../services/file-service';
import { validateFileNamePattern } from '../services/settings-service';
import { FileSelector, FileList, NoticeBox, BusyLabel, errorText, formatSize, OpenFolderButton } from './common';
import { PagedCuePreview, Pagination, PREVIEW_PAGE_SIZE, SubtitleDiffPreview } from './subtitle-diff-preview';
import { ToolPresets } from './tool-presets';

const encodingChoices = [['utf-8', 'UTF-8'], ['utf-8-bom', 'UTF-8 BOM'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['gbk', 'GBK（严格无损）'], ['gb18030', 'GB18030（严格无损）']];
const inputEncodingChoices = [...encodingChoices.slice(0, 4), ['gbk', 'GBK（仅手动选择）'], ['gb18030', 'GB18030（仅手动选择）']];
const statusNames = { queued: '等待处理', processing: '处理中', success: '已处理', failed: '失败', cancelled: '已取消' };

function savedOutputDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separator < 0) return '';
  // Preserve the separator in drive roots: D: alone is a drive-relative path.
  return path.slice(0, separator === 0 || separator === 2 && path[1] === ':' ? separator + 1 : separator);
}

export function ParameterForm({ definition, params, onChange, errors, disabled }: { definition: ToolDefinition; params: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; errors: Record<string, string>; disabled: boolean }) {
  return <div className="parameter-grid">{definition.parameters.map(field => <div className={`field ${field.type === 'checkbox' ? 'checkbox-field' : ''}`} key={field.key}>
    {field.type === 'checkbox' ? <label className="check-label"><input type="checkbox" checked={params[field.key] === true} disabled={disabled} onChange={e => onChange({ ...params, [field.key]: e.target.checked })} />{field.label}</label> : <><label htmlFor={`param-${field.key}`}>{field.label}</label>{field.type === 'select' ? <select id={`param-${field.key}`} value={String(params[field.key] ?? '')} disabled={disabled} onChange={e => onChange({ ...params, [field.key]: e.target.value })}>{field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input id={`param-${field.key}`} type={field.type} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} value={typeof params[field.key] === 'number' && Number.isNaN(params[field.key]) ? '' : String(params[field.key] ?? '')} disabled={disabled} aria-invalid={!!errors[field.key]} onChange={e => onChange({ ...params, [field.key]: field.type === 'number' ? e.target.value === '' ? NaN : Number(e.target.value) : e.target.value })} />}</>}
    {field.help && <small>{field.help}</small>}{errors[field.key] && <span className="field-error">{errors[field.key]}</span>}
  </div>)}</div>;
}

export function ToolWorkspace({ definition, batch = false }: { definition: ToolDefinition; batch?: boolean }) {
  const files = useAppStore(s => s.files); const settings = useAppStore(s => s.settings); const notify = useAppStore(s => s.notify); const globalBusy = useAppStore(s => s.busy); const setBusy = useAppStore(s => s.setBusy);
  const [params, setParams] = useState(() => defaultParameters(definition)); const [errors, setErrors] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<ProcessingOptions>(() => ({ lineEnding: settings.lineEnding, outputEncoding: settings.outputEncoding, fileNamePattern: settings.fileNamePattern }));
  const [outputDirectory, setOutputDirectory] = useState(settings.outputDirectory);
  const [tasks, setTasks] = useState<ProcessedTask[]>([]); const [selectedId, setSelectedId] = useState(''); const [processing, setProcessing] = useState(false); const [exporting, setExporting] = useState(false); const [showPreview, setShowPreview] = useState(settings.showPreview); const [exportedPaths, setExportedPaths] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null); const record = useRef<HistoryRecord | null>(null); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const invalidate = () => { setTasks([]); setExportedPaths([]); setSelectedId(''); record.current = null; };
  // A result belongs to the exact input objects and ordering, never to a subsequently changed queue.
  const previousFiles = useRef(files);
  useEffect(() => { if (previousFiles.current !== files) { previousFiles.current = files; setTasks([]); setExportedPaths([]); setSelectedId(''); record.current = null; } }, [files]);
  const changeParams = (next: Record<string, unknown>) => { setParams(next); setErrors({}); invalidate(); };
  const changeOptions = (next: ProcessingOptions) => { setOptions(next); invalidate(); };
  const persistRecord = async (current: ProcessedTask[], paths: string[] = []) => {
    const successes = current.filter(t => t.status === 'success').length; const failures = current.filter(t => t.status === 'failed').length;
    const next: HistoryRecord = { id: record.current?.id ?? crypto.randomUUID(), createdAt: record.current?.createdAt ?? new Date().toISOString(), toolName: definition.name, inputCount: files.length, successCount: definition.combined && successes ? files.length : successes, failedCount: definition.combined && failures ? files.length : failures, outputDirectory: paths.length && isDesktop() ? savedOutputDirectory(paths[0]) : '', outputPaths: paths, summary: paths.length ? `已导出 ${paths.length} 个文件；处理成功 ${successes} 项，失败 ${failures} 项。` : `已处理 ${successes} 项，失败 ${failures} 项；结果尚未导出。` };
    record.current = next;
    try { await appendHistory(next); await useAppStore.getState().refreshHistory(); } catch (error) { notify(`处理结果已保留，但记录保存失败：${errorText(error)}`, 'error'); }
  };
  const run = async (retry = false) => {
    if (useAppStore.getState().busy) return;
    const fieldErrors = validateParameters(definition, params); setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;
    try { validateFileNamePattern(options.fileNamePattern); } catch (error) { notify(errorText(error), 'error'); return; }
    if (!files.length) { notify('请先添加字幕文件。'); return; }
    if (definition.combined && (files.length < 2 || definition.id !== 'merge' && files.length !== 2)) { notify(definition.id === 'merge' ? '合并至少需要两份字幕。' : '此工具需要恰好两份字幕，请调整文件列表。', 'error'); return; }
    const toProcess = retry ? files.filter(f => tasks.some(t => t.id === f.id && (t.status === 'failed' || t.status === 'cancelled'))) : files;
    if (!toProcess.length) return;
    const retained = retry ? tasks.filter(t => t.status === 'success') : [];
    const retainedPaths = retry ? exportedPaths : [];
    const jobOptions = { ...options, fileIndexes: Object.fromEntries(files.map((file, index) => [file.id, index + 1])) };
    setProcessing(true); setBusy(true); if (!retry) setExportedPaths([]); controller.current = new AbortController();
    if (!retry) { setTasks(files.map(initialTask)); record.current = null; }
    let finalTasks: ProcessedTask[];
    try {
      if (definition.combined) {
        setTasks([{ ...initialTask(files[0]), inputName: `${files.length} 个文件 · ${definition.name}`, status: 'processing' }]);
        finalTasks = [await processCombinedFiles(files, definition.id as 'merge' | 'bilingual' | 'compare', params, jobOptions, controller.current.signal)];
      } else {
        const results = await processFiles(toProcess, definition.id, params, jobOptions, next => {
          if (mounted.current) setTasks(previous => {
            const rest = previous.filter(t => t.id !== next.id); return [...rest, next].sort((a, b) => files.findIndex(f => f.id === a.id) - files.findIndex(f => f.id === b.id));
          });
        }, controller.current.signal);
        finalTasks = [...retained, ...results].sort((a, b) => files.findIndex(f => f.id === a.id) - files.findIndex(f => f.id === b.id));
      }
      if (mounted.current) { setTasks(finalTasks); setSelectedId(finalTasks.find(t => t.status === 'success')?.id ?? finalTasks[0]?.id ?? ''); await persistRecord(finalTasks, retainedPaths); }
    } catch (error) {
      const cancelled = controller.current.signal.aborted;
      if (mounted.current) { finalTasks = [{ ...initialTask(files[0]), inputName: definition.combined ? `${files.length} 个文件` : files[0].name, status: cancelled ? 'cancelled' : 'failed', errorMessage: cancelled ? undefined : errorText(error), summary: cancelled ? '处理已取消' : '处理失败' }]; setTasks(finalTasks); await persistRecord(finalTasks, retainedPaths); if (!cancelled) notify(errorText(error), 'error'); }
    } finally { setBusy(false); if (mounted.current) setProcessing(false); }
  };
  const outputs = uniqueOutputNames(tasks.filter(t => t.status === 'success').flatMap(t => t.outputs));
  const exportResults = useCallback(async (zip = false, only?: ProcessedOutput) => {
    if (useAppStore.getState().busy) return;
    const ready = only ? [only] : uniqueOutputNames(tasks.filter(t => t.status === 'success').flatMap(t => t.outputs));
    if (!ready.length || processing || exporting) return;
    setExporting(true); setBusy(true); const paths: string[] = [...exportedPaths];
    const desktop = isDesktop();
    try {
      if (zip) {
        const bytes = await createZip(ready);
        const path = await saveOutput('subtitle-tools_results.zip', bytes, outputDirectory || undefined);
        if (path) {
          paths.push(path);
          if (desktop && outputDirectory) setOutputDirectory(savedOutputDirectory(path));
        }
      } else {
        let directory = outputDirectory || undefined;
        if (ready.length > 1 && desktop && !directory) { directory = await pickDirectory() ?? undefined; if (!directory) return; }
        for (const output of ready) {
          const path = await saveOutput(output.name, output.bytes, directory);
          if (!path) break;
          paths.push(path);
          if (desktop && directory) {
            // A startup authorization dialog can select a different directory.
            directory = savedOutputDirectory(path);
            if (outputDirectory) setOutputDirectory(directory);
          }
        }
      }
      if (paths.length > exportedPaths.length) {
        setExportedPaths(paths); await persistRecord(tasks, paths); notify(`已导出 ${paths.length - exportedPaths.length} 个文件。`, 'success');
        if (settings.autoOpenDirectory && desktop) await openOutputDirectory(paths.at(-1)!);
      }
    } catch (error) { if (paths.length > exportedPaths.length) { setExportedPaths(paths); await persistRecord(tasks, paths); } notify(`导出失败，处理结果已保留：${errorText(error)}`, 'error'); }
    finally { setBusy(false); if (mounted.current) setExporting(false); }
  // persistRecord captures the current queue and definition and is used only within this render's export action.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, processing, exporting, exportedPaths, settings, outputDirectory, notify, setBusy]);
  useEffect(() => { const save = (event: KeyboardEvent) => { if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); if (!document.querySelector('dialog[open]')) void exportResults(outputs.length > 1); } }; window.addEventListener('keydown', save); return () => window.removeEventListener('keydown', save); }, [exportResults, outputs.length]);
  useEffect(() => { if (!processing) return; const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) controller.current?.abort(); }; window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel); }, [processing]);
  const activeTask = tasks.find(t => t.id === selectedId) ?? tasks[0];
  const finished = tasks.filter(t => ['success', 'failed', 'cancelled'].includes(t.status)).length;
  return <div className="workspace">
    <section className="panel"><div className="panel-heading"><span className="step-number">1</span><h2>选择文件</h2><span className="panel-hint">{definition.combined ? '按列表顺序处理' : batch ? '所有文件执行相同操作' : '支持单个或多个文件'}</span></div><FileSelector compact /><FileList disabled={globalBusy} /></section>
    <section className="panel"><div className="panel-heading"><span className="step-number">2</span><h2>设置处理参数</h2></div>
      <NoticeBox>{definition.note}</NoticeBox>
      {definition.parameters.length > 0 ? <>
        <ToolPresets definition={definition} params={params} disabled={globalBusy} onApply={changeParams} />
        <ParameterForm definition={definition} params={params} onChange={changeParams} errors={errors} disabled={globalBusy} />
      </> : <p className="muted small-copy">此工具无需额外参数，添加文件后即可预览。</p>}
      <details className="export-options"><summary><ChevronDown size={16} />输入与导出选项 <span>{options.outputEncoding.toUpperCase()} · {definition.id === 'chinese' ? '保留原换行' : options.lineEnding}</span></summary><div className="parameter-grid"><div className="field"><label htmlFor="input-encoding">输入文件编码</label><select id="input-encoding" value={options.encoding ?? ''} disabled={globalBusy} onChange={e => changeOptions({ ...options, encoding: e.target.value || undefined })}><option value="">自动检测（不确定时会提示）</option>{inputEncodingChoices.map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select><small>解码不正确时请手动指定，避免将乱码导出。</small></div><div className="field"><label htmlFor="output-encoding">输出编码</label><select id="output-encoding" disabled={globalBusy} value={options.outputEncoding} onChange={e => changeOptions({ ...options, outputEncoding: e.target.value })}>{encodingChoices.map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select></div><div className="field"><label htmlFor="output-newline">输出换行符</label><select id="output-newline" disabled={globalBusy || definition.id === 'chinese'} value={definition.id === 'chinese' ? 'preserve' : options.lineEnding} onChange={e => changeOptions({ ...options, lineEnding: e.target.value as 'LF' | 'CRLF' })}><option value="CRLF">CRLF · Windows</option><option value="LF">LF · Unix</option>{definition.id === 'chinese' && <option value="preserve">保留原文件换行</option>}</select>{definition.id === 'chinese' && <small>简繁转换保留原换行、编号与格式布局。</small>}</div><div className="field"><label htmlFor="filename-pattern">输出文件名规则</label><input id="filename-pattern" disabled={globalBusy} value={options.fileNamePattern} onChange={e => changeOptions({ ...options, fileNamePattern: e.target.value })} /><small>{'{name} 原文件名 · {index} 文件序号；自动追加正确扩展名'}</small></div></div></details>
      <div className="run-bar"><span><Check size={15} />原文件始终保留，预览不会写入磁盘</span><button className="button primary" disabled={!files.length || globalBusy} onClick={() => void run()}><Eye size={17} />{settings.showPreview ? '预览处理结果' : '开始处理'}</button></div>
    </section>
    {(tasks.length > 0 || processing) && <section className="panel results-panel"><div className="panel-heading"><span className="step-number">3</span><h2>{processing ? '正在处理' : '处理结果'}</h2><span className="panel-hint">完成 {finished} / {tasks.length}</span></div><div className="progress-track"><div style={{ width: `${tasks.length ? finished / tasks.length * 100 : 0}%` }} /></div>
      <div className="result-stats"><span><strong>{tasks.filter(t => t.status === 'success').length}</strong> 已处理</span><span><strong>{tasks.filter(t => t.status === 'failed').length}</strong> 失败</span><span><strong>{outputs.length}</strong> 结果文件</span>{processing ? <button className="button secondary small" onClick={() => controller.current?.abort()}><Square size={13} />取消处理</button> : tasks.some(t => t.status === 'failed' || t.status === 'cancelled') && !definition.combined && <button className="button secondary small" disabled={globalBusy} onClick={() => void run(true)}><RotateCcw size={14} />重试未完成项</button>}</div>
      <div className="task-list">{tasks.map(t => <button className={`task-row ${activeTask?.id === t.id ? 'selected' : ''}`} key={t.id} onClick={() => setSelectedId(t.id)}><Files size={17} /><span className="task-name">{t.inputName}<small>{t.errorMessage ?? t.summary}</small></span><span className={`status-badge ${t.status}`}>{t.status === 'processing' ? <BusyLabel>处理中</BusyLabel> : statusNames[t.status]}</span><ChevronRight size={15} /></button>)}</div>
      {activeTask && <ResultDetails key={`${activeTask.id}-${activeTask.status}`} task={activeTask} combined={!!definition.combined} showPreview={showPreview} onToggle={() => setShowPreview(s => !s)} />}
      {outputs.length > 0 && !processing && <div className="export-panel"><div className="section-heading"><div><h3>确认并导出</h3><p className="muted small-copy">{isDesktop() ? outputDirectory || '导出时选择保存位置；重名文件自动追加序号。' : '浏览器预览模式：导出为下载文件。桌面版支持本地输出目录。'}</p></div><div className="button-row">{isDesktop() && <button className="button secondary" disabled={globalBusy} onClick={() => { void pickDirectory().then(path => { if (path) setOutputDirectory(path); }).catch(error => notify(errorText(error), 'error')); }}><FolderOpen size={16} />更改保存目录</button>}<button className="button secondary" disabled={globalBusy} onClick={() => void exportResults(true)}>{exporting ? <BusyLabel>导出中</BusyLabel> : <><FileArchive size={16} />导出 ZIP</>}</button><button className="button primary" disabled={globalBusy} onClick={() => void exportResults(false)}><Download size={16} />{outputs.length === 1 ? '另存为' : '导出全部文件'}</button></div></div><div className="output-list">{outputs.map((o, i) => <div key={`${o.name}-${i}`}><span className="mono">{o.name}</span><small>{formatSize(o.bytes.length)}</small><button className="text-button" disabled={globalBusy} onClick={() => void exportResults(false, o)}>导出<ArrowRight size={13} /></button></div>)}</div></div>}
      {exportedPaths.length > 0 && <NoticeBox kind="success"><div className="export-success"><span>已导出 {exportedPaths.length} 个文件。{isDesktop() && <span className="path-text">{exportedPaths.at(-1)}</span>}</span>{isDesktop() && <OpenFolderButton path={exportedPaths.at(-1)!} />}</div></NoticeBox>}
    </section>}
    {tasks.length === 0 && <div className="workspace-footnote"><FolderOpen size={14} /><span>选择文件 <ChevronRight size={12} />设置参数 <ChevronRight size={12} />预览结果 <ChevronRight size={12} />安全导出</span></div>}
  </div>;
}

function ResultDetails({ task, combined, showPreview, onToggle }: { task: ProcessedTask; combined: boolean; showPreview: boolean; onToggle: () => void }) {
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [outputIndex, setOutputIndex] = useState(0);
  const diagnostics = task.diagnostics;
  const diagnosticPageCount = Math.ceil(diagnostics.length / PREVIEW_PAGE_SIZE);
  const safeDiagnosticPage = Math.min(diagnosticPage, Math.max(0, diagnosticPageCount - 1));
  const diagnosticStart = safeDiagnosticPage * PREVIEW_PAGE_SIZE;
  const output = task.outputs[outputIndex] ?? task.outputs[0];
  if (task.status === 'queued' || task.status === 'processing') return null;
  if (task.status === 'cancelled') return <NoticeBox>处理已取消，没有可预览的结果。</NoticeBox>;
  return <div className="result-details">
    {task.errorMessage && <NoticeBox kind="error">{task.errorMessage}<details><summary>查看错误详情</summary><code>{task.errorCode ?? 'PROCESSING_FAILED'}</code></details></NoticeBox>}
    {task.comparisonUnavailable && <NoticeBox kind="warning">{task.comparisonUnavailable === 'input-errors' ? '源文件存在解析错误，逻辑对比暂不可用。请先根据诊断修正源文件，仍可导出诊断报告。' : '输入编码尚未确认，逻辑对比暂不可用。请核对原文并手动选择输入编码。'}</NoticeBox>}
    {task.comparison ? <div className="document-meta"><span>第一份 {task.comparison.before.cues.length} 条字幕</span><span>第二份 {task.comparison.after.cues.length} 条字幕</span><span>时间容差 {task.comparison.toleranceMs} 毫秒</span></div> : task.document && <div className="document-meta">
      <span>输入 {task.document.cues.length} 条字幕</span><span>{task.document.encoding.toUpperCase()}</span><span>{task.document.lineEnding}</span>
      {output?.document && <span>输出 {output.document.cues.length} 条字幕</span>}
    </div>}
    {diagnostics.length > 0 && <details className="diagnostics" open={diagnostics.some(d => d.severity === 'error')}><summary><AlertTriangle size={15} />诊断与提示 <span className="count">{diagnostics.length}</span></summary><ul>{diagnostics.slice(diagnosticStart, diagnosticStart + PREVIEW_PAGE_SIZE).map((d, i) => <li key={i} className={d.severity}><span className="diagnostic-level">{d.severity === 'error' ? '错误' : d.severity === 'warning' ? '注意' : '提示'}</span><span>{d.cueIndex !== undefined && `第 ${d.cueIndex} 条 · `}{d.line !== undefined && `行 ${d.line} · `}{d.message}</span></li>)}</ul>{diagnosticPageCount > 1 && <Pagination page={safeDiagnosticPage} count={diagnosticPageCount} onChange={setDiagnosticPage} />}</details>}
    {task.status === 'failed' && task.document && <>
      <div className="section-heading preview-heading"><h3>原文预览</h3><button className="text-button" aria-expanded={showPreview} onClick={onToggle}>{showPreview ? '收起预览' : '查看原文'}</button></div>
      {showPreview && <PagedCuePreview cues={task.document.cues} />}
    </>}
    {task.status === 'success' && <>
      <div className="section-heading preview-heading"><h3>处理预览 <span className="muted">每页最多 {PREVIEW_PAGE_SIZE} 条</span></h3><button className="text-button" aria-expanded={showPreview} onClick={onToggle}>{showPreview ? '收起预览' : '查看预览'}<ChevronDown size={14} /></button></div>
      {showPreview && <>
        {task.outputs.length > 1 && <div className="field"><label htmlFor="preview-output">预览输出文件</label><select id="preview-output" value={outputIndex} onChange={e => setOutputIndex(Number(e.target.value))}>{task.outputs.map((o, i) => <option value={i} key={i}>{o.name}</option>)}</select></div>}
        {task.comparison ? <>
          <NoticeBox>原有列表对比按条目位置比较，允许的时间差为 {task.comparison.toleranceMs} 毫秒。{task.summary}。下方按正文与时间证据显示逻辑差异，编号与顺序另行标记。</NoticeBox>
          <SubtitleDiffPreview before={task.comparison.before.cues} after={task.comparison.after.cues} partialOutput={false} trustIds={false} timeToleranceMs={task.comparison.toleranceMs} documentComparison beforeLabel={`第一份 · ${task.comparison.before.fileName}`} afterLabel={`第二份 · ${task.comparison.after.fileName}`} />
          {output && <details className="comparison-report"><summary>查看 JSON 差异报告</summary><pre className="text-preview">{output.text.slice(0, 12_000)}{output.text.length > 12_000 && '\n… 预览已截断，导出包含完整报告。'}</pre></details>}
        </> : <PreviewPanel key={outputIndex} input={task.document} output={output} combined={combined} partialOutput={task.outputs.length > 1} />}
      </>}
    </>}
  </div>;
}

function PreviewPanel({ input, output, combined, partialOutput }: {
  input: ProcessedTask['document']; output: ProcessedOutput | undefined; combined: boolean; partialOutput: boolean;
}) {
  if (!output) return <NoticeBox>此任务没有可预览的输出。</NoticeBox>;
  if (!output.document) {
    const report = output.name.toLowerCase().endsWith('.json');
    return <>
      <p className="diff-note">{report ? '此结果为报告预览。' : '此结果为纯文本预览。'}</p>
      <pre className="text-preview">{output.text.slice(0, 12_000) || '输出为空。'}{output.text.length > 12_000 && '\n… 预览已截断，导出包含完整结果。'}</pre>
    </>;
  }
  if (combined || !input) return <>
    <NoticeBox>{combined ? '此结果由多个输入合成，以下显示所选输出的字幕概览。' : '以下显示所选输出的字幕概览。'}</NoticeBox>
    <PagedCuePreview cues={output.document.cues} />
  </>;
  return <SubtitleDiffPreview before={input.cues} after={output.document.cues} partialOutput={partialOutput} />;
}
