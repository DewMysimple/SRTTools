import { useRef, useState } from 'react';
import { tools } from '../app/tool-registry';
import { confirmPresetImport, exportPresetSelection, listExportablePresets, PRESET_PRIVACY_NOTICE, previewPresetImport, type PresetConflictStrategy, type PresetImportPlan } from '../services/preset-exchange';
import { readBrowserPresetFile, readPresetImportFile } from '../services/preset-file-service';
import { isDesktop, saveOutput } from '../services/file-service';
import { useAppStore } from '../stores/app-store';
import { ActionDialog } from './action-dialog';
import { errorText } from './common';

type Exportable = Awaited<ReturnType<typeof listExportablePresets>>;

export function PresetExchange({ disabled, onChanged }: { disabled: boolean; onChanged?: () => void }) {
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const [available, setAvailable] = useState<Exportable>({ tools: [], workflows: [], warnings: [] });
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [strategy, setStrategy] = useState<PresetConflictStrategy>('skip');
  const [plan, setPlan] = useState<PresetImportPlan | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  const chooser = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const notify = useAppStore(state => state.notify);
  const locked = disabled || pending;
  const openExport = async () => {
    if (locked || useAppStore.getState().busy) return;
    setPending(true); setError('');
    try { setAvailable(await listExportablePresets()); setSelectedTools([]); setSelectedWorkflows([]); setConsent(false); setMode('export'); }
    catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  const readImport = async (selected: Uint8Array) => {
    setPending(true); setError(''); setPlan(null); setConsent(false); setOverwrite(false); setStrategy('skip');
    try { const preview = await previewPresetImport(selected, 'skip'); setBytes(selected); setPlan(preview); setMode('import'); }
    catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  const chooseImport = async () => {
    if (locked || useAppStore.getState().busy) return;
    if (!isDesktop()) { chooser.current?.click(); return; }
    setPending(true); setError('');
    try { const selected = await readPresetImportFile(); if (selected) await readImport(selected); }
    catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  const changeStrategy = async (next: PresetConflictStrategy) => {
    if (!bytes || locked) return;
    const id = ++generation.current;
    setStrategy(next); setPlan(null); setOverwrite(false); setError(''); setPending(true);
    try { const preview = await previewPresetImport(bytes, next); if (generation.current === id) setPlan(preview); }
    catch (error) { if (generation.current === id) setError(errorText(error)); }
    finally { if (generation.current === id) setPending(false); }
  };
  const close = () => { generation.current++; setMode(null); setBytes(null); setPlan(null); setError(''); };
  const confirm = async () => {
    if (disabled || pending || useAppStore.getState().busy) throw new Error('请等待当前任务结束。');
    setPending(true);
    try {
      if (mode === 'export') {
        if (!consent) throw new Error('请先确认已了解个人文字参数会包含在 JSON 中。');
        const output = await exportPresetSelection({ toolIds: selectedTools, workflowIds: selectedWorkflows });
        const path = await saveOutput('SRTTools-Presets.json', output);
        if (path) notify('已导出所选预设 JSON。', 'success');
      } else {
        if (!plan) throw new Error('请先生成有效导入预览。');
        const result = await confirmPresetImport(plan, { overwriteConfirmed: overwrite });
        window.dispatchEvent(new Event('subtitle-tools:presets-changed'));
        onChanged?.(); notify(`已导入 ${result.imported} 项，跳过 ${result.skipped} 项。`, 'success');
      }
    } finally { setPending(false); }
  };
  const toggle = (previous: string[], id: string) => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id];
  return <div className="preset-exchange">
    <div className="button-row"><button type="button" className="text-button" disabled={locked} onClick={() => void chooseImport()}>导入预设 JSON</button><button type="button" className="text-button" disabled={locked} onClick={() => void openExport()}>导出预设 JSON</button></div>
    <input ref={chooser} type="file" accept=".json,application/json" hidden aria-label="选择预设 JSON 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setPending(true); void readBrowserPresetFile(file).then(readImport).catch(error => setError(errorText(error))).finally(() => setPending(false)); }} />
    {error && !mode && <p className="field-error" role="alert">{error}</p>}
    {mode && <ActionDialog title={mode === 'export' ? '选择要分享的预设' : '预览预设导入'} confirmLabel={mode === 'export' ? '确认导出所选预设' : '确认导入预设'} onConfirm={confirm} onClose={close}>
      {mode === 'export' ? <><p>{PRESET_PRIVACY_NOTICE} 仅导出勾选配置，不包含字幕文件、处理历史或目录授权。</p><div className="button-row"><button type="button" className="text-button" disabled={pending} onClick={() => setSelectedTools(available.tools.map(preset => preset.id))}>全选工具预设</button><button type="button" className="text-button" disabled={pending} onClick={() => setSelectedWorkflows(available.workflows.map(preset => preset.id))}>全选流程预设</button><button type="button" className="text-button" disabled={pending} onClick={() => { setSelectedTools([]); setSelectedWorkflows([]); }}>清空选择</button></div>
        <div className="preset-exchange-list">{available.tools.map(preset => <label className="check-label" key={preset.id}><input type="checkbox" disabled={pending} checked={selectedTools.includes(preset.id)} onChange={() => setSelectedTools(ids => toggle(ids, preset.id))} />工具 · {tools.find(tool => tool.id === preset.toolId)?.name} · {preset.name}</label>)}{available.workflows.map(preset => <label className="check-label" key={preset.id}><input type="checkbox" disabled={pending} checked={selectedWorkflows.includes(preset.id)} onChange={() => setSelectedWorkflows(ids => toggle(ids, preset.id))} />流程 · {preset.name}</label>)}{!available.tools.length && !available.workflows.length && <p>还没有可导出的预设，请先保存工具参数或流程。</p>}</div>
        {available.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<label className="check-label"><input type="checkbox" disabled={pending} checked={consent} onChange={event => setConsent(event.target.checked)} />我已了解个人输入参数会随 JSON 分享</label><p>已选择 {selectedTools.length + selectedWorkflows.length} 项。文件采用 UTF-8，名为 SRTTools-Presets.json。</p>
      </> : <><p>这是配置导入入口，不会把 JSON 加入字幕队列。确认前存储保持不变；未知或无效项目不会执行，原文件保留。</p><div className="field"><label htmlFor="preset-conflict-strategy">同名冲突策略</label><select id="preset-conflict-strategy" disabled={pending} value={strategy} onChange={event => void changeStrategy(event.target.value as PresetConflictStrategy)}><option value="skip">跳过，保留已有项</option><option value="rename">自动改名后导入</option><option value="overwrite">覆盖已存在同名项</option></select></div>
        {plan && <><p role="status">将导入 {plan.importCount} 项 · 跳过 {plan.skipCount} 项 · 冲突 {plan.conflicts} 项 · 不兼容 {plan.incompatible} 项</p><ul className="preset-import-preview">{plan.items.map(row => <li key={row.index}>{row.kind === 'tool' ? '工具' : row.kind === 'workflow' ? '流程' : '未知类型'} · {row.name}{row.outputName && row.outputName !== row.name && ` → ${row.outputName}`} · {row.status === 'import' ? '将导入' : row.status === 'skip' ? '跳过' : '不兼容'}{row.reason && <p>{row.reason}</p>}</li>)}</ul>{plan.requiresOverwriteConfirmation && <label className="check-label"><input type="checkbox" disabled={pending} checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />我确认覆盖上述同名预设，替换其已保存配置</label>}</>}
      </>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </ActionDialog>}
  </div>;
}
