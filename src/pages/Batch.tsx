import { useState } from 'react';
import { tools } from '../app/tool-registry';
import { ToolWorkspace } from '../components/tool-workspace';
import { PageHeading } from '../components/common';
import { useAppStore } from '../stores/app-store';

export function Batch() {
  const [toolId, setToolId] = useState('replace'); const busy = useAppStore(s => s.busy); const definition = tools.find(t => t.id === toolId)!;
  return <><PageHeading eyebrow="少一点重复，多一点效率" title="批量处理" description="为多个文件执行同一操作，逐个预览，统一导出。" /><section className="panel batch-settings"><div className="field"><label htmlFor="batch-tool">选择批量操作</label><select id="batch-tool" disabled={busy} value={toolId} onChange={e => setToolId(e.target.value)}>{tools.filter(t => !t.combined).map(t => <option key={t.id} value={t.id}>{t.category} · {t.name}</option>)}</select></div><p>{definition.description}。单个文件处理失败不会中断其余文件。{definition.parameters.length > 0 && '下方可应用此工具已保存的预设；确认参数后再预览。'}</p></section><ToolWorkspace key={toolId} definition={definition} batch /></>;
}
