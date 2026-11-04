import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { isDesktop } from '../services/file-service';
import { getExplorerIntegration, onExternalImport, setExplorerIntegration, takeExternalImports, type ExplorerStatus } from '../services/explorer-service';
import { useAppStore } from '../stores/app-store';
import { BusyLabel, errorText } from './common';

export function ExplorerIntegration() {
  const [status, setStatus] = useState<ExplorerStatus>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (isDesktop()) void getExplorerIntegration().then(value => { if (mounted.current) setStatus(value); }).catch(error => { if (mounted.current) setError(errorText(error)); });
    return () => { mounted.current = false; };
  }, []);
  if (!isDesktop() || status?.available === false) return null;
  const update = async (enabled: boolean) => {
    setWorking(true); setError('');
    try { setStatus(await setExplorerIntegration(enabled)); }
    catch (error) { setError(errorText(error)); }
    finally { setWorking(false); }
  };
  return <section className="panel settings-section"><div><h2>Explorer 右键菜单（实验性）</h2><p>在字幕文件上选择“使用 Subtitle Tools 打开”，添加到当前队列</p></div>
    <p>实验功能，默认关闭。仅为当前 Windows 用户登记菜单；登记成功不代表菜单在所有 Windows 环境中可见。菜单未出现时，请移除登记并使用选择文件或拖放。支持 SRT、VTT、ASS、SSA、TXT、CSV；Explorer 传统菜单最多选择 15 个文件。Windows 11 可在“显示更多选项”中找到。</p>
    <div className="settings-inline"><span role="status">{status ? status.enabled ? '菜单已登记，请在 Explorer 中验证' : '菜单未登记（默认关闭）' : '正在读取菜单状态…'}</span><button className="button secondary" disabled={!status || working || status.conflict} onClick={() => void update(!status?.enabled)}>{working ? <BusyLabel>更新菜单</BusyLabel> : <><FolderOpen size={16} />{status?.enabled ? '禁用右键菜单' : status?.otherInstallation ? '修复到当前程序路径' : '启用右键菜单'}</>}</button></div>
    {status?.conflict && <p role="alert">同名菜单由其他程序管理，已保留原设置。</p>}
    {status?.otherInstallation && <p>菜单指向另一个程序路径。修复后将使用当前程序；另一个安装的卸载不会删除此入口。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

/** Subscribe before the first drain; requests stay native-side until this UI is ready and idle. */
export function ExternalImportHandler() {
  useEffect(() => {
    if (!isDesktop()) return;
    let active = true; let requested = true; let draining = false;
    let unlisten: (() => void) | undefined;
    const drain = async () => {
      if (!active || draining || !requested || useAppStore.getState().busy) return;
      requested = false; draining = true;
      const state = useAppStore.getState(); state.setBusy(true);
      try {
        const result = await takeExternalImports(state.files);
        if (active) {
          useAppStore.getState().addFiles(result.files);
          if (result.files.length) state.notify(`已从 Explorer 添加 ${result.files.length} 个文件。`, 'success');
          if (result.rejected) state.notify(`${result.rejected} 个外部文件未导入：文件已移动、不可读取、格式不支持、链接或超出导入限额。`, 'error');
          if (result.duplicates) state.notify(`已跳过 ${result.duplicates} 个重复文件。`);
        }
      } catch (error) { if (active) state.notify(errorText(error), 'error'); }
      finally { draining = false; state.setBusy(false); if (active && requested) void drain(); }
    };
    const unsubscribe = useAppStore.subscribe((state, previous) => { if (!state.busy && previous.busy) void drain(); });
    void onExternalImport(() => { requested = true; void drain(); }).then(stop => {
      if (!active) stop(); else { unlisten = stop; void drain(); }
    }).catch(error => { if (active) useAppStore.getState().notify(errorText(error), 'error'); });
    return () => { active = false; unsubscribe(); unlisten?.(); };
  }, []);
  return null;
}
