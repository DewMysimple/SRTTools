import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import { tools, validateParameters } from '../app/tool-registry';
import { workflowOperations, type WorkflowOperationId } from '../core/operation-registry';
import { analyzeWorkflow, createWorkflowStep, MAX_WORKFLOW_STEPS, type WorkflowDefinition, type WorkflowStep } from '../core/workflow';
import { processWorkflowFiles, initialTask, type ProcessedTask, type ProcessingOptions } from '../services/processing-service';
import { createWorkflowPreset, deleteWorkflowPreset, duplicateWorkflowPreset, listWorkflowPresets, readWorkflowPreset, updateWorkflowPreset, type WorkflowPreset } from '../services/workflow-preset-service';
import { appendHistory, type HistoryRecord } from '../services/history-service';
import { validateFileNamePattern } from '../services/settings-service';
import { useAppStore } from '../stores/app-store';
import { ActionDialog } from './action-dialog';
import { BusyLabel, errorText, FileList, FileSelector, NoticeBox } from './common';
import { FolderExportPanel, type FolderOutputEntry, type FolderExportState } from './folder-export-panel';
import { ParameterForm, ResultDetails } from './tool-workspace';
import { ToolPresets } from './tool-presets';
import { PresetExchange } from './preset-exchange';
import { emptyWorkflow, type WorkflowDraft } from './workflow-draft';

type ManagementAction = 'create' | 'update' | 'rename' | 'duplicate' | 'delete' | 'lossy';
const statusNames = { queued: '等待处理', processing: '处理中', success: '已处理', failed: '失败', cancelled: '已取消' };
const encodings = [['utf-8', 'UTF-8'], ['utf-8-bom', 'UTF-8 BOM'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['gbk', 'GBK（严格无损）'], ['gb18030', 'GB18030（严格无损）']];

export function WorkflowWorkspace({ draft, onChange }: { draft: WorkflowDraft; onChange: (draft: WorkflowDraft) => void }) {
  const files = useAppStore(state => state.files);
  const settings = useAppStore(state => state.settings);
  const busy = useAppStore(state => state.busy);
  const notify = useAppStore(state => state.notify);
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [quarantined, setQuarantined] = useState<unknown[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [storageWarning, setStorageWarning] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState(draft.id ?? '');
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState<WorkflowOperationId>('remove-empty');
  const [action, setAction] = useState<ManagementAction | null>(null);
  const [actionName, setActionName] = useState('');
  const [options, setOptions] = useState<ProcessingOptions>(() => ({ lineEnding: settings.lineEnding, outputEncoding: settings.outputEncoding, fileNamePattern: settings.fileNamePattern }));
  const [tasks, setTasks] = useState<ProcessedTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [stepFilter, setStepFilter] = useState('all');
  const [processing, setProcessing] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const history = useRef<HistoryRecord | null>(null);
  const exportedState = useRef<FolderExportState>({ paths: [], written: [], overrides: {} });
  const definition = useMemo<WorkflowDefinition>(() => ({ schemaVersion: 1, steps: draft.steps, lossyMode: draft.lossyMode }), [draft.steps, draft.lossyMode]);
  const analysis = useMemo(() => analyzeWorkflow(definition, files), [definition, files]);
  const locked = busy || pending;
  const selectedPreset = presets.find(preset => preset.id === selectedPresetId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (!processing) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) controller.current?.abort(); };
    window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel);
  }, [processing]);
  useEffect(() => {
    let current = true;
    void listWorkflowPresets().then(result => {
      if (!current) return;
      setPresets(result.presets); setQuarantined(result.quarantined); setReadOnly(result.readOnly); setStorageWarning(result.warning ?? '');
    }).catch(error => { if (current) { setReadOnly(true); setStorageWarning(errorText(error)); } });
    return () => { current = false; };
  }, [revision]);
  const invalidate = () => { setTasks([]); setSelectedTaskId(''); setStepFilter('all'); history.current = null; exportedState.current = { paths: [], written: [], overrides: {} }; };
  const previousFiles = useRef(files);
  useEffect(() => { if (previousFiles.current !== files) { previousFiles.current = files; setTasks([]); setSelectedTaskId(''); history.current = null; exportedState.current = { paths: [], written: [], overrides: {} }; } }, [files]);
  const edit = (next: WorkflowDraft) => { if (useAppStore.getState().busy) return; onChange(next); invalidate(); };
  const editStep = (id: string, changes: Partial<WorkflowStep>) => edit({ ...draft, steps: draft.steps.map(step => step.id === id ? { ...step, ...changes } : step) });
  const moveStep = (index: number, direction: -1 | 1) => {
    const steps = [...draft.steps]; const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]]; edit({ ...draft, steps });
    notify(`步骤已移至第 ${target + 1} 位。`);
  };
  const apply = async () => {
    if (locked || !selectedPreset) return;
    setPending(true);
    try { const preset = await readWorkflowPreset(selectedPreset.id); if (mounted.current && !useAppStore.getState().busy) { edit({ ...preset, steps: structuredClone(preset.steps) }); notify('已应用流程配置，预览需要重新执行。', 'success'); } }
    catch (error) { notify(errorText(error), 'error'); }
    finally { if (mounted.current) setPending(false); }
  };
  const manage = async () => {
    if (locked) throw new Error('请等待当前任务结束。');
    if (action === 'lossy') { edit({ ...draft, lossyMode: 'normalize' }); return; }
    setPending(true);
    try {
      let next: WorkflowPreset | undefined;
      if (action === 'create') next = await createWorkflowPreset({ name: actionName, description: draft.description, steps: draft.steps, lossyMode: draft.lossyMode });
      else if (action === 'update' && draft.id) next = await updateWorkflowPreset(draft.id, { name: draft.name, description: draft.description, steps: draft.steps, lossyMode: draft.lossyMode });
      else if (selectedPreset && action === 'rename') next = await updateWorkflowPreset(selectedPreset.id, { name: actionName });
      else if (selectedPreset && action === 'duplicate') next = await duplicateWorkflowPreset(selectedPreset.id, actionName);
      else if (selectedPreset && action === 'delete') {
        await deleteWorkflowPreset(selectedPreset.id);
        if (draft.id === selectedPreset.id) onChange({ ...draft, id: undefined });
        setSelectedPresetId('');
      } else throw new Error('请先选择已保存的流程。');
      if (next) {
        setSelectedPresetId(next.id);
        if (action === 'create' || action === 'update' || action === 'rename' && draft.id === next.id) onChange({ ...draft, id: next.id, name: next.name });
      }
      setRevision(value => value + 1); notify(action === 'delete' ? '已删除流程，编辑区配置仍保留。' : '流程已保存到本机。', 'success');
    } finally { if (mounted.current) setPending(false); }
  };
  const saveHistory = async (current: ProcessedTask[], paths: string[] = []) => {
    const next: HistoryRecord = {
      id: history.current?.id ?? crypto.randomUUID(), createdAt: history.current?.createdAt ?? new Date().toISOString(),
      toolName: `处理流程 · ${draft.name || '未命名流程'}`, inputCount: files.length,
      successCount: current.filter(task => task.status === 'success').length, failedCount: current.filter(task => task.status === 'failed').length,
      outputDirectory: '', outputPaths: paths, summary: paths.length ? `已导出 ${paths.length} 个文件，源文件保持不变。` : '流程已计算，结果尚未写入磁盘。',
    };
    history.current = next;
    try { await appendHistory(next); await useAppStore.getState().refreshHistory(); }
    catch (error) { notify(`结果已保留，但处理记录保存失败：${errorText(error)}`, 'error'); }
  };
  const run = async (retry = false) => {
    if (locked || !files.length) return;
    if (!analysis.executable) { notify(analysis.issues.find(issue => issue.severity === 'error')?.message ?? '请先配置启用的有效步骤。', 'error'); return; }
    try { validateFileNamePattern(options.fileNamePattern); } catch (error) { notify(errorText(error), 'error'); return; }
    const selectedFiles = retry ? files.filter(file => tasks.some(task => task.id === file.id && (task.status === 'failed' || task.status === 'cancelled'))) : files;
    if (!selectedFiles.length) return;
    const retained = retry ? tasks.filter(task => task.status === 'success') : [];
    const abort = new AbortController(); controller.current = abort;
    useAppStore.getState().setBusy(true); setProcessing(true); setSelectedTaskId('');
    if (!retry) { setTasks(files.map(initialTask)); history.current = null; exportedState.current = { paths: [], written: [], overrides: {} }; }
    try {
      const results = await processWorkflowFiles(selectedFiles, definition, { ...options, fileIndexes: Object.fromEntries(files.map((file, index) => [file.id, index + 1])) }, next => {
        if (mounted.current) setTasks(previous => [...previous.filter(task => task.id !== next.id), next].sort((a, b) => files.findIndex(file => file.id === a.id) - files.findIndex(file => file.id === b.id)));
      }, abort.signal);
      const finalTasks = [...retained, ...results].sort((a, b) => files.findIndex(file => file.id === a.id) - files.findIndex(file => file.id === b.id));
      if (mounted.current) { setTasks(finalTasks); setSelectedTaskId(finalTasks.find(task => task.status === 'success')?.id ?? finalTasks[0]?.id ?? ''); await saveHistory(finalTasks, retry ? history.current?.outputPaths : []); }
    } catch (error) { if (mounted.current) notify(errorText(error), 'error'); }
    finally { useAppStore.getState().setBusy(false); controller.current = null; if (mounted.current) setProcessing(false); }
  };
  const outputEntries = useMemo<FolderOutputEntry[]>(() => tasks.filter(task => task.status === 'success').flatMap(task => {
    const input = files.find(file => file.id === task.id);
    return input ? task.outputs.map((output, index) => ({ id: `${task.id}:${index}`, input, output })) : [];
  }), [tasks, files]);
  const visibleTasks = tasks.filter(task => taskFilter === 'all' || task.status === taskFilter);
  const activeTask = visibleTasks.find(task => task.id === selectedTaskId) ?? visibleTasks[0];
  const operationName = (id: string) => workflowOperations.find(operation => operation.id === id)?.name ?? id;
  const openAction = (next: ManagementAction) => { setActionName(next === 'create' ? draft.name : next === 'duplicate' ? `${selectedPreset?.name ?? ''} 副本` : selectedPreset?.name ?? ''); setAction(next); };
  const skippedSteps = tasks.reduce((count, task) => count + (task.workflow?.stepSummaries.filter(step => step.status === 'skipped').length ?? 0), 0);
  return <div className="workspace workflow-workspace">
    <section className="panel"><div className="panel-heading"><span className="step-number">1</span><h2>我的流程</h2><span className="panel-hint">只保存配置，不保存字幕或路径</span></div>
      <div className="preset-toolbar"><div className="field"><label htmlFor="saved-workflow">已保存流程</label><select id="saved-workflow" value={selectedPreset?.id ?? ''} disabled={locked} onChange={event => setSelectedPresetId(event.target.value)}><option value="">选择流程</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></div><div className="button-row">
        <button className="button secondary small" disabled={locked || !selectedPreset} onClick={() => void apply()}>应用流程</button><button className="button secondary small" disabled={locked} onClick={() => { edit(emptyWorkflow()); setSelectedPresetId(''); }}>新建流程</button>
        <button className="button secondary small" disabled={locked || readOnly} onClick={() => openAction('create')}>保存流程</button><button className="text-button" disabled={locked || readOnly || !draft.id} onClick={() => openAction('update')}>更新当前流程</button>
      </div></div>
      {selectedPreset && <><p className="small-copy muted">创建：<time>{selectedPreset.createdAt}</time> · 更新：<time>{selectedPreset.updatedAt}</time> · 启用 {selectedPreset.steps.filter(step => step.enabled).length} / {selectedPreset.steps.length} 步</p><div className="button-row"><button className="text-button" disabled={locked || readOnly} onClick={() => openAction('rename')}>重命名流程</button><button className="text-button" disabled={locked || readOnly} onClick={() => openAction('duplicate')}>复制流程</button><button className="text-button" disabled={locked || readOnly} onClick={() => openAction('delete')}>删除流程</button></div></>}
      {storageWarning && <NoticeBox kind="warning">{storageWarning} 编辑区内容保留。</NoticeBox>}
      {quarantined.length > 0 && <details className="quarantine-view"><summary>查看隔离项目（{quarantined.length} 项，仅供核对）</summary><p>未知或损坏配置原样保留，不会执行。</p><pre className="text-preview">{JSON.stringify(quarantined, null, 2).slice(0, 12_000)}{JSON.stringify(quarantined).length > 12_000 && '\n… 显示已截断，存储原数据保持完整。'}</pre></details>}
      <PresetExchange disabled={locked} onChanged={() => setRevision(value => value + 1)} />
    </section>
    <section className="panel"><div className="panel-heading"><span className="step-number">2</span><h2>编辑处理步骤</h2><span className="panel-hint">{draft.steps.length} / {MAX_WORKFLOW_STEPS} 步</span></div>
      <div className="parameter-grid"><div className="field"><label htmlFor="workflow-name">流程名称</label><input id="workflow-name" value={draft.name} disabled={locked} onChange={event => edit({ ...draft, name: event.target.value })} placeholder="例如：中文字幕标准清理" /></div><div className="field"><label htmlFor="workflow-description">流程描述</label><input id="workflow-description" value={draft.description} disabled={locked} onChange={event => edit({ ...draft, description: event.target.value })} placeholder="可选，说明适用字幕和用途" /></div></div>
      {!draft.steps.length && <NoticeBox>还没有步骤。先添加一项操作，再按顺序组合；可以保存未完成的草稿。</NoticeBox>}
      <ol className="workflow-steps">{draft.steps.map((step, index) => {
        const tool = tools.find(tool => tool.id === step.operation)!;
        const errors = validateParameters(tool, step.params);
        return <li key={step.id} className={`workflow-step ${step.enabled ? '' : 'disabled-step'}`} aria-label={`步骤 ${index + 1} ${tool.name}`}>
          <div className="workflow-step-heading"><strong>{index + 1} · {tool.name}</strong><label className="check-label"><input type="checkbox" checked={step.enabled} disabled={locked} onChange={event => editStep(step.id, { enabled: event.target.checked })} />启用</label><div className="button-row"><button className="icon-button" aria-label={`上移步骤 ${index + 1} ${tool.name}`} disabled={locked || index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label={`下移步骤 ${index + 1} ${tool.name}`} disabled={locked || index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={16} /></button><button className="icon-button" aria-label={`移除步骤 ${index + 1} ${tool.name}`} disabled={locked} onClick={() => edit({ ...draft, steps: draft.steps.filter(item => item.id !== step.id) })}><Trash2 size={15} /></button></div></div>
          <p className="small-copy muted">{tool.description}{tool.parameters.length ? ` · ${tool.parameters.map(field => `${field.label}：${(field.type === 'checkbox' ? step.params[field.key] ? '是' : '否' : field.options?.find(option => option.value === step.params[field.key])?.label ?? String(step.params[field.key] ?? '')).slice(0, 50)}`).join('；')}` : ' · 无需额外参数'}</p>
          {tool.parameters.length > 0 && <details className="workflow-step-params" open><summary>步骤参数与工具预设</summary><ToolPresets definition={tool} params={step.params} disabled={locked} exchange={false} onApply={params => editStep(step.id, { params: structuredClone(params) })} /><ParameterForm definition={tool} params={step.params} disabled={locked} errors={errors} idPrefix={`step-${step.id}`} onChange={params => editStep(step.id, { params })} /></details>}
          {step.operation === 'strip-html' && <p className="small-copy">HTML 清理会改变标签与实体，请复核正文含义。</p>}
        </li>;
      })}</ol>
      <div className="workflow-add"><div className="field"><label htmlFor="add-workflow-operation">添加步骤类型</label><select id="add-workflow-operation" value={adding} disabled={locked} onChange={event => setAdding(event.target.value as WorkflowOperationId)}>{workflowOperations.map(operation => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</select></div><button className="button secondary" disabled={locked || draft.steps.length >= MAX_WORKFLOW_STEPS} onClick={() => edit({ ...draft, steps: [...draft.steps, createWorkflowStep(adding)] })}><Plus size={16} />添加处理步骤</button></div>
      <p className="small-copy muted">支持 SRT、CSV、含时间行 TXT；纯简繁步骤保留原布局。ASS/SSA/VTT 混合流程默认拦截，明确同意后规范化为 SRT。末端序列化可能统一编号，预览会显示实际变化。</p>
      <label className="check-label"><input type="checkbox" checked={draft.lossyMode === 'normalize'} disabled={locked} onChange={event => { if (event.target.checked) openAction('lossy'); else edit({ ...draft, lossyMode: 'reject' }); }} />允许 ASS/SSA/VTT 混合流程规范化为 SRT（需确认格式损失）</label>
    </section>
    <section className="panel"><div className="panel-heading"><span className="step-number">3</span><h2>输入与预执行检查</h2></div><FileSelector compact /><FileList disabled={locked} />
      <div className="workflow-analysis" role="status"><p>预估执行 {analysis.enabledStepCount} 步 · 输入 {files.length} 个文件 · 适用 {analysis.files.filter(file => file.applicable).length} · 不适用 {analysis.files.filter(file => !file.applicable).length}</p><p className="small-copy muted">可能影响：{Object.entries(analysis.effects).filter(([, value]) => value).map(([key]) => ({ text: '正文', time: '时间', index: '编号', count: '条目数' })[key]).join('、') || '无启用步骤'}。处理前不估算精确变化条数。</p></div>
      {analysis.issues.map((issue, index) => <p key={index} className={issue.severity === 'error' ? 'field-error' : 'small-copy'}>{issue.stepIndex !== undefined && `步骤 ${issue.stepIndex + 1} · `}{issue.message}</p>)}
      {analysis.files.length > 0 && <details className="workflow-applicability"><summary>查看文件适用性与警告</summary><ul>{analysis.files.map(file => <li key={file.id}><strong>{file.name}</strong> · {file.applicable ? `适用 → ${file.outputFormat?.toUpperCase() ?? '原格式'}` : `不适用：${file.reason}`}{file.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul></details>}
      <details className="export-options"><summary>输入与导出选项 · {options.outputEncoding.toUpperCase()}</summary><div className="parameter-grid"><div className="field"><label htmlFor="workflow-input-encoding">输入文件编码</label><select id="workflow-input-encoding" disabled={locked} value={options.encoding ?? ''} onChange={event => { setOptions({ ...options, encoding: event.target.value || undefined }); invalidate(); }}><option value="">自动检测（不确定时会提示）</option>{encodings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="field"><label htmlFor="workflow-output-encoding">输出编码</label><select id="workflow-output-encoding" disabled={locked} value={options.outputEncoding} onChange={event => { setOptions({ ...options, outputEncoding: event.target.value }); invalidate(); }}>{encodings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="field"><label htmlFor="workflow-output-newline">输出换行符</label><select id="workflow-output-newline" disabled={locked} value={options.lineEnding} onChange={event => { setOptions({ ...options, lineEnding: event.target.value as 'LF' | 'CRLF' }); invalidate(); }}><option value="CRLF">CRLF · Windows</option><option value="LF">LF · Unix</option></select><small>纯简繁流程使用原文布局写回，保留原文件换行。</small></div><div className="field"><label htmlFor="workflow-filename-pattern">输出文件名规则</label><input id="workflow-filename-pattern" disabled={locked} value={options.fileNamePattern} onChange={event => { setOptions({ ...options, fileNamePattern: event.target.value }); invalidate(); }} /><small>{'{name} 原文件名 · {index} 原队列序号'}</small></div></div></details>
      <div className="run-bar"><span>预览不是保存；预览与执行均使用真实流程引擎。</span><div className="button-row"><button className="button secondary" disabled={locked || !files.length || !analysis.executable} onClick={() => void run()}><Eye size={16} />预览影响</button><button className="button primary" disabled={locked || !files.length || !analysis.executable} onClick={() => void run()}>开始处理</button></div></div>
    </section>
    {tasks.length > 0 && <section className="panel results-panel"><div className="panel-heading"><h2>流程处理结果</h2><span className="panel-hint">完成 {tasks.filter(task => ['success', 'failed', 'cancelled'].includes(task.status)).length} / {tasks.length}</span></div>
      <div className="result-stats"><span><strong>{tasks.filter(task => task.status === 'success').length}</strong> 成功</span><span><strong>{tasks.filter(task => task.status === 'failed').length}</strong> 失败</span><span><strong>{tasks.filter(task => task.status === 'cancelled').length}</strong> 已取消</span><span>跳过 {skippedSteps} 个禁用步骤</span>{processing ? <button className="button secondary small" onClick={() => controller.current?.abort()}><Square size={14} />取消处理</button> : tasks.some(task => task.status === 'failed' || task.status === 'cancelled') && <button className="button secondary small" disabled={locked} onClick={() => void run(true)}><RotateCcw size={14} />重试未完成项</button>}</div>
      <div className="parameter-grid"><div className="field"><label htmlFor="workflow-task-filter">筛选文件状态</label><select id="workflow-task-filter" value={taskFilter} onChange={event => setTaskFilter(event.target.value)}><option value="all">全部文件</option><option value="success">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></div><div className="field"><label htmlFor="workflow-step-filter">筛选步骤诊断</label><select id="workflow-step-filter" value={stepFilter} onChange={event => setStepFilter(event.target.value)}><option value="all">全部步骤</option>{draft.steps.map((step, index) => <option key={step.id} value={step.id}>步骤 {index + 1} · {operationName(step.operation)}</option>)}</select></div></div>
      <div className="task-list">{visibleTasks.map(task => <button className={`task-row ${activeTask?.id === task.id ? 'selected' : ''}`} key={task.id} onClick={() => setSelectedTaskId(task.id)}><span className="task-name">{task.inputName}<small>{task.workflow?.currentStep && task.status === 'processing' ? `步骤 ${task.workflow.currentStep.stepIndex + 1} / ${task.workflow.currentStep.totalSteps} · ${operationName(task.workflow.currentStep.operation)}` : task.errorMessage ?? task.summary}</small></span><span className={`status-badge ${task.status}`}>{task.status === 'processing' ? <BusyLabel>处理中</BusyLabel> : statusNames[task.status]}</span></button>)}</div>
      {activeTask && <><div className="workflow-step-summaries" aria-label="每一步实际变化摘要"><h3>每一步实际变化</h3><ul>{activeTask.workflow?.stepSummaries.filter(step => stepFilter === 'all' || step.stepId === stepFilter).map(step => <li key={step.stepId}>步骤 {step.stepIndex + 1} · {operationName(step.operation)} · {step.status === 'skipped' ? '已跳过' : step.status === 'failed' ? '失败' : `变化 ${step.changedCount}，移除 ${step.removedCount}，警告 ${step.warningCount}`}<p>{step.summary}</p></li>)}</ul></div><ResultDetails key={`${activeTask.id}-${activeTask.status}-${stepFilter}`} task={stepFilter === 'all' ? activeTask : { ...activeTask, diagnostics: activeTask.diagnostics.filter(diagnostic => diagnostic.stepId === stepFilter) }} combined={false} showPreview={showPreview} onToggle={() => setShowPreview(value => !value)} /></>}
      {!processing && outputEntries.length > 0 && <FolderExportPanel entries={outputEntries} initialState={exportedState.current} onStateChange={state => { exportedState.current = state; }} onExported={paths => saveHistory(tasks, paths)} />}
    </section>}
    {action && <ActionDialog title={{ create: '保存为新流程', update: '更新当前流程', rename: '重命名流程', duplicate: '复制流程', delete: '删除流程', lossy: '确认格式布局损失' }[action]} confirmLabel={action === 'lossy' ? '同意规范化为 SRT' : action === 'delete' ? '确认删除流程' : '确认保存流程'} danger={action === 'delete'} onClose={() => setAction(null)} onConfirm={manage}>
      {action === 'lossy' ? <p>仅对 ASS/SSA/VTT 的混合步骤流程生效：将丢失样式、位置、特效或 cue 设置，输出统一为 SRT。请核对差异后导出。纯简繁流程仍保留原文布局。</p> : action === 'delete' ? <p>删除「{selectedPreset?.name}」？当前编辑内容和用户字幕仍保留。</p> : <><p>仅保存配置；查找和替换等个人文字参数将保存在本机。保存失败时编辑内容保持完整。</p>{['create', 'rename', 'duplicate'].includes(action) && <div className="field"><label htmlFor="workflow-save-name">保存名称</label><input id="workflow-save-name" value={actionName} onChange={event => setActionName(event.target.value)} /></div>}</>}
    </ActionDialog>}
  </div>;
}
