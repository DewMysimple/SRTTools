import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
import { getExplorerIntegration, onExternalImport, setExplorerIntegration, takeExternalImports } from './explorer-service';

beforeEach(() => { invoke.mockReset(); listen.mockReset(); });
describe('Explorer bridge', () => {
  it('sends queue limits and comparison hints, never renderer-selected paths to read', async () => {
    invoke.mockResolvedValue({ files: [{ name: '字幕.srt', path: 'C:\\字幕.srt', size: 2, bytes: [65, 66] }], rejected: 1, duplicates: 2 });
    const result = await takeExternalImports([{ id: 'existing', name: 'old.srt', path: 'C:\\old.srt', bytes: new Uint8Array(3), size: 3 }]);
    expect(invoke).toHaveBeenCalledWith('take_external_imports', { existingPaths: ['C:\\old.srt'], existingCount: 1, existingBytes: 3 });
    expect(result.files[0].bytes).toEqual(new Uint8Array([65, 66]));
    expect(result.files[0].id).toBeTruthy(); expect(result.rejected).toBe(1); expect(result.duplicates).toBe(2);
  });
  it('makes enable explicit and propagates native ownership conflicts', async () => {
    invoke.mockResolvedValueOnce({ available: true, enabled: false, conflict: false, otherInstallation: false });
    await getExplorerIntegration(); expect(invoke).toHaveBeenLastCalledWith('get_explorer_integration', undefined);
    invoke.mockRejectedValueOnce('同名菜单由其他程序管理，未作修改。');
    await expect(setExplorerIntegration(true)).rejects.toThrow('其他程序');
    expect(invoke).toHaveBeenLastCalledWith('set_explorer_integration', { enabled: true });
  });
  it('subscribes to the native pending signal', async () => {
    const handler = vi.fn(); await onExternalImport(handler);
    expect(listen).toHaveBeenCalledWith('subtitle-tools:external-import-pending', handler);
  });
});
