import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { defaultParameters, type ToolDefinition } from '../app/tool-registry';
import {
  createPreset, deletePreset, listPresets, PresetError, readPreset, recoverPresetStore,
  updatePreset, type ToolPreset,
} from '../services/preset-service';
import { useAppStore } from '../stores/app-store';
import { errorText } from './common';

type Action = 'create' | 'update' | 'rename' | 'delete' | 'recover';

const dialogCopy = {
  create: { title: '保存为新预设', confirm: '确认保存', description: '预设可能包含你输入的文字，只保存在本机。' },
  update: { title: '更新预设', confirm: '确认更新', description: '用当前表单参数替换此预设。' },
  rename: { title: '重命名预设', confirm: '确认重命名', description: '仅更改预设名称。' },
  delete: { title: '删除预设', confirm: '确认删除', description: '删除后仍保留表单中的当前参数。' },
  recover: { title: '清理损坏预设', confirm: '确认清理', description: '清空无法读取的预设数据，应用设置和处理记录会保留。' },
} satisfies Record<Action, { title: string; confirm: string; description: string }>;

export function ToolPresets({ definition, params, disabled, onApply }: {
  definition: ToolDefinition;
  params: Record<string, unknown>;
  disabled: boolean;
  onApply: (params: Record<string, unknown>) => void;
}) {
  const inputId = useId();
  const mounted = useRef(false);
  const notify = useAppStore(state => state.notify);
  const [presets, setPresets] = useState<ToolPreset[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [appliedId, setAppliedId] = useState('');
  const [managing, setManaging] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const toolId = definition.id;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void listPresets(toolId).then(({ presets, ignoredCount }) => {
      if (!active) return;
      setPresets(presets);
      setIgnoredCount(ignoredCount);
      setLoadError(null);
    }).catch((error: unknown) => {
      if (active) setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [toolId, loadAttempt]);

  const selected = presets.find(preset => preset.id === selectedId);
  const applied = presets.find(preset => preset.id === appliedId);
  const changed = applied && definition.parameters.some(({ key }) => !Object.is(applied.parameters[key], params[key]));
  const locked = disabled || pending;
  const available = !locked && !loading && !loadError;
  const recoverable = loadError instanceof PresetError && loadError.code === 'corrupt-store';

  const refresh = () => {
    setLoading(true);
    setLoadAttempt(attempt => attempt + 1);
  };

  const apply = async () => {
    if (!available || !selected || useAppStore.getState().busy) return;
    setPending(true);
    try {
      const current = await readPreset(toolId, selected.id);
      if (!mounted.current) return;
      if (useAppStore.getState().busy) {
        notify('请等待当前任务结束后再应用预设。');
        return;
      }
      onApply(current.parameters);
      setAppliedId(current.id);
      setPresets(items => items.map(item => item.id === current.id ? current : item));
      notify('已应用预设。', 'success');
    } catch (error) {
      notify(`无法应用预设：${errorText(error)}`, 'error');
    } finally {
      setPending(false);
    }
  };

  const confirm = async (mode: Action, name: string) => {
    if (locked || useAppStore.getState().busy) throw new Error('请等待当前任务结束后重试。');
    setPending(true);
    try {
      if (mode === 'recover') {
        await recoverPresetStore();
        setLoadError(null);
        setSelectedId('');
        setAppliedId('');
      } else if (mode === 'create') {
        const created = await createPreset({ toolId, name, parameters: params });
        setSelectedId(created.id);
        setAppliedId(created.id);
      } else if (selected) {
        if (mode === 'delete') {
          await deletePreset(toolId, selected.id);
          setSelectedId('');
          if (appliedId === selected.id) setAppliedId('');
        } else {
          await updatePreset(toolId, selected.id, mode === 'rename' ? { name } : { parameters: params });
          if (mode === 'update') setAppliedId(selected.id);
        }
      } else {
        throw new Error('请先选择预设。');
      }
      setAction(null);
      refresh();
      notify(mode === 'delete' ? '已删除预设。' : mode === 'recover' ? '已清理损坏预设。' : '已保存预设。', 'success');
    } finally {
      setPending(false);
    }
  };

  return <div className="tool-presets">
    <div className="preset-toolbar">
      <div className="field">
        <label htmlFor={inputId}>参数预设</label>
        <select id={inputId} disabled={!available} value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>
          <option value="">{loading ? '正在加载…' : '选择预设'}</option>
          {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </div>
      <div className="button-row">
        <button type="button" className="button secondary small" disabled={!available || !selected} onClick={() => void apply()}>应用预设</button>
        <button type="button" className="button secondary small" disabled={!available} onClick={() => setAction('create')}>保存为新预设</button>
        <button type="button" className="text-button" disabled={!available || !selected} aria-expanded={managing} onClick={() => setManaging(open => !open)}>管理预设</button>
        <button type="button" className="text-button" disabled={locked} onClick={() => {
          onApply(defaultParameters(definition));
          setAppliedId('');
        }}><RotateCcw size={14} />重置</button>
      </div>
    </div>
    {managing && selected && <div className="button-row preset-actions" role="group" aria-label="管理所选预设">
      <button type="button" className="text-button" disabled={!available} onClick={() => setAction('update')}>更新预设</button>
      <button type="button" className="text-button" disabled={!available} onClick={() => setAction('rename')}>重命名预设</button>
      <button type="button" className="text-button" disabled={!available} onClick={() => setAction('delete')}>删除预设</button>
    </div>}
    <p className="small-copy muted">预设仅保存在本机。保存前请确认表单中的查找与替换文字。</p>
    {applied && <p className="small-copy muted" role="status">当前预设：{applied.name}{changed && <> · <strong>已修改</strong></>}</p>}
    {ignoredCount > 0 && <p className="small-copy muted" role="status">已跳过 {ignoredCount} 项无效或不兼容的预设。</p>}
    {!!loadError && <div className="preset-actions">
      <p className="field-error" role="alert">{errorText(loadError)}</p>
      <div className="button-row">
        <button type="button" className="text-button" disabled={locked || loading} onClick={refresh}>重新读取</button>
        {recoverable && <button type="button" className="text-button" disabled={locked || loading} onClick={() => setAction('recover')}>清理损坏预设</button>}
      </div>
    </div>}
    {action && <PresetDialog action={action} presetName={selected?.name} disabled={locked} pending={pending}
      onConfirm={name => confirm(action, name)} onClose={() => setAction(null)} />}
  </div>;
}

function PresetDialog({ action, presetName, disabled, pending, onConfirm, onClose }: {
  action: Action;
  presetName?: string;
  disabled: boolean;
  pending: boolean;
  onConfirm: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(action === 'rename' ? presetName ?? '' : '');
  const [error, setError] = useState('');
  const copy = dialogCopy[action];
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={ref} className="confirm-dialog preset-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    if (!pending) onClose();
  }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      setError('');
      void onConfirm(name).catch((problem: unknown) => setError(errorText(problem)));
    }}>
      <h2 id={titleId}>{copy.title}</h2>
      <p>{copy.description}{action !== 'create' && action !== 'recover' && presetName && `「${presetName}」`}</p>
      {(action === 'create' || action === 'rename') && <div className="field">
        <label htmlFor={nameId}>预设名称</label>
        <input id={nameId} autoComplete="off" value={name} disabled={disabled} onChange={event => setName(event.target.value)} />
      </div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="button-row end">
        <button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button>
        <button type="submit" className={`button ${action === 'delete' || action === 'recover' ? 'danger' : 'primary'}`} disabled={disabled}>{copy.confirm}</button>
      </div>
    </form>
  </dialog>;
}
