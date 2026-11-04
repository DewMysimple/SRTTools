import { create } from 'zustand';
import type { ImportedFile } from '../services/file-service';
import { defaultSettings, loadSettings, saveSettings, type AppSettings } from '../services/settings-service';
import { loadHistory, type HistoryRecord } from '../services/history-service';

interface Notice { id: string; message: string; kind: 'success' | 'error' | 'info' }
interface AppState {
  files: ImportedFile[];
  settings: AppSettings;
  history: HistoryRecord[];
  notices: Notice[];
  busy: boolean;
  initialized: boolean;
  addFiles: (files: ImportedFile[]) => void;
  removeFile: (id: string) => void;
  moveFile: (id: string, direction: -1 | 1) => void;
  clearFiles: () => void;
  setBusy: (busy: boolean) => void;
  notify: (message: string, kind?: Notice['kind']) => void;
  dismiss: (id: string) => void;
  initialize: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  refreshHistory: () => Promise<void>;
}
export const useAppStore = create<AppState>((set, get) => ({
  files: [], settings: defaultSettings, history: [], notices: [], busy: false, initialized: false,
  addFiles: incoming => {
    const existing = get().files;
    const all = [...existing];
    for (const file of incoming) {
      if (file.path && all.some(f => f.path === file.path)) continue;
      if (all.length >= 100 || all.reduce((n, f) => n + f.bytes.byteLength, 0) + file.bytes.byteLength > 128 * 1024 * 1024) { get().notify('当前队列最多 100 个文件、总计 128 MB，请分批处理。', 'error'); break; }
      all.push(file);
    }
    set({ files: all });
  },
  removeFile: id => set(state => ({ files: state.files.filter(f => f.id !== id) })),
  moveFile: (id, direction) => set(state => { const files = [...state.files]; const index = files.findIndex(f => f.id === id); const target = index + direction; if (index >= 0 && target >= 0 && target < files.length) [files[index], files[target]] = [files[target], files[index]]; return { files }; }),
  clearFiles: () => set({ files: [] }), setBusy: busy => set({ busy }),
  notify: (message, kind = 'info') => set(state => ({ notices: [...state.notices.slice(-3), { id: crypto.randomUUID(), message, kind }] })),
  dismiss: id => set(state => ({ notices: state.notices.filter(n => n.id !== id) })),
  initialize: async () => {
    try { const [settings, history] = await Promise.all([loadSettings(), loadHistory()]); set({ settings, history, initialized: true }); }
    catch (error) { set({ initialized: true }); get().notify(`本地设置读取失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
  },
  updateSettings: async settings => { await saveSettings(settings); set({ settings }); },
  refreshHistory: async () => set({ history: await loadHistory() }),
}));
