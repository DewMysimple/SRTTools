import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

/** Browser contract only; actual Windows dialogs, paths and byte protection have separate native gates. */
async function nativeOutputContract(page: Page, processingFailure = false, cancelExport = false) {
  await page.addInitScript(({ processingFailure, cancelExport }) => {
    const browser = window as unknown as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    const bytes = Array.from(new TextEncoder().encode('9\n00:00:01,000 --> 00:00:02,000\n  中文   正文  \n'));
    const files = [
      { name: 'E01.srt', path: 'C:\\甲\\剧集\\S01\\E01.srt', folderSource: { rootId: 'a', rootName: '字幕项目', relativePath: '剧集/S01/E01.srt' }, bytes, size: bytes.length },
      { name: 'E01.srt', path: 'C:\\甲\\剧集\\S02\\E01.srt', folderSource: { rootId: 'a', rootName: '字幕项目', relativePath: '剧集/S02/E01.srt' }, bytes, size: bytes.length },
      { name: 'Movie.srt', path: 'D:\\乙\\电影\\Movie.srt', folderSource: { rootId: 'b', rootName: '字幕项目', relativePath: '电影/Movie.srt' }, bytes, size: bytes.length },
    ];
    const prepared: Array<Array<{ id: string; relativePath: string; sourcePath: string }>> = [];
    const writes: Array<{ id: string; bytes: number[] }> = [];
    let failOnce = !processingFailure && !cancelExport;
    let heldWrite = false; let rejectWrite: ((error: Error) => void) | undefined;
    if (processingFailure) {
      const original = Worker.prototype.postMessage; let failed = false;
      Worker.prototype.postMessage = function(message: unknown) {
        const envelope = message as { request?: { files?: Array<{ name: string }> } };
        if (!failed && envelope.request?.files?.[0]?.name === 'Movie.srt') {
          failed = true; queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'Controlled first-attempt worker failure' }))); return;
        }
        return original.call(this, message);
      };
    }
    const sessions = new Map<string, Array<{ id: string; relativePath: string }>>();
    Object.assign(browser, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      outputContract: { prepared, writes, saved: [] as unknown[], finished: [] as string[], files },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => undefined,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          const state = browser.outputContract as { saved: unknown[]; finished: string[] };
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'take_external_imports') return { files: [], rejected: 0, duplicates: 0 };
          if (command === 'get_local_value') return values[String(args.key)] ?? null;
          if (command === 'set_local_value') { values[String(args.key)] = args.value; return null; }
          if (command === 'select_import_folder') {
            const channel = args.onEvent as { onmessage: (event: unknown) => void };
            const summary = { selected: true, visitedEntries: 3, scannedFiles: 3, added: 3, duplicates: 0, unsupported: 0, overLimit: 0, failed: 0, unreadableDirectories: 0, skippedLinks: 0, depthSkipped: 0, cancelledFiles: 0, limitStopped: false, cancelled: false };
            for (const file of files) channel.onmessage({ scanId: args.scanId, phase: 'reading', summary, file });
            channel.onmessage({ scanId: args.scanId, phase: 'complete', summary }); return null;
          }
          if (command === 'prepare_folder_export') {
            const entries = args.entries as Array<{ id: string; relativePath: string; sourcePath: string }>;
            prepared.push(structuredClone(entries));
            const actual = entries.map((entry, index) => ({ id: entry.id, relativePath: prepared.length === 1 && index === 0 ? entry.relativePath.replace('.srt', ' (1).srt') : entry.relativePath, renamed: prepared.length === 1 && index === 0 }));
            sessions.set(String(args.exportId), actual); return { exportId: args.exportId, directory: 'E:\\独立输出', entries: actual };
          }
          if (command === 'write_folder_export') {
            const entry = sessions.get(String(args.exportId))!.find(entry => entry.id === args.id)!;
            writes.push({ id: String(args.id), bytes: args.bytes as number[] });
            if (cancelExport && !heldWrite && writes.length === 2) { heldWrite = true; browser.exportWritePending = true; return new Promise((_resolve, reject) => { rejectWrite = reject; }); }
            if (failOnce && entry.relativePath.includes('S02')) { failOnce = false; throw '目标文件被锁定，其他结果仍可导出。'; }
            return { path: `E:\\独立输出\\${entry.relativePath.replaceAll('/', '\\')}`, relativePath: entry.relativePath };
          }
          if (command === 'finish_folder_export') { state.finished.push(String(args.exportId)); sessions.delete(String(args.exportId)); rejectWrite?.(new Error('目录导出已取消。')); rejectWrite = undefined; return null; }
          if (command === 'save_output') { state.saved.push(args); return `E:\\独立输出\\${String(args.name)}`; }
          if (command === 'open_output_directory') return null;
          throw new Error(`Unexpected native contract command: ${command}`);
        },
      },
    });
  }, { processingFailure, cancelExport });
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('folder workflow reviews multi-root tree, retains native collision names in ZIP and retries only failed writes', async ({ page }) => {
  await nativeOutputContract(page); await page.goto('/#/batch'); await button(page, '处理流程').click();
  await page.getByLabel('添加步骤类型', { exact: true }).selectOption('clean-spaces'); await button(page, '添加处理步骤').click(); await button(page, '添加文件夹').click();
  await button(page, '预览影响').click(); await expect(page.locator('.task-row .success')).toHaveCount(3);
  await expect(page.getByLabel('输出目录结构', { exact: true })).toHaveValue('preserve');
  const tree = page.getByRole('region', { name: '输出文件树预览', exact: true });
  await expect(tree).toContainText('字幕项目/剧集/S01/E01_processed.srt'); await expect(tree).toContainText('字幕项目 (2)/电影/Movie_processed.srt');
  await button(page, '选择输出目录并预览').click(); await expect(tree).toContainText('E01_processed (1).srt');
  await button(page, '确认导出到目录').click(); await expect(page.locator('.folder-export-panel')).toContainText('2 成功、1 失败'); await expect(tree).toContainText('目标文件被锁定');
  await expect(tree).toContainText('E01_processed (1).srt');
  await button(page, '导出 ZIP').click(); await expect(page.locator('.toasts')).toContainText('ZIP 已导出');
  const saved = await page.evaluate(() => (window as unknown as { outputContract: { saved: Array<{ bytes: number[] }> } }).outputContract.saved.at(-1)!.bytes);
  const archive = await JSZip.loadAsync(Uint8Array.from(saved));
  expect(Object.keys(archive.files)).toEqual(['字幕项目/剧集/S01/E01_processed (1).srt', '字幕项目/剧集/S02/E01_processed.srt', '字幕项目 (2)/电影/Movie_processed.srt']);
  for (const file of Object.values(archive.files)) expect(await file.async('string')).toContain('中文 正文');
  await button(page, '重试未导出项：选择目录').click(); await button(page, '确认导出到目录').click(); await expect(page.locator('.folder-export-panel')).toContainText('3 成功、0 失败');
  const state = await page.evaluate(() => (window as unknown as { outputContract: { prepared: Array<Array<{ id: string; sourcePath: string }>>; writes: Array<{ id: string }>; finished: string[] } }).outputContract);
  expect(state.prepared.map(entries => entries.length)).toEqual([3, 1]); expect(state.prepared[1][0].sourcePath).toContain('S02');
  expect(state.writes.filter(write => write.id === state.prepared[0][0].id)).toHaveLength(1); expect(state.finished).toHaveLength(2);
});

test('cancelling an active directory IPC releases its session and retains successful outputs for retry', async ({ page }) => {
  await nativeOutputContract(page, false, true); await page.goto('/#/batch'); await button(page, '处理流程').click();
  await page.getByLabel('添加步骤类型', { exact: true }).selectOption('clean-spaces'); await button(page, '添加处理步骤').click(); await button(page, '添加文件夹').click(); await button(page, '开始处理').click();
  await expect(page.locator('.task-row .success')).toHaveCount(3); await button(page, '选择输出目录并预览').click(); await button(page, '确认导出到目录').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { exportWritePending?: boolean }).exportWritePending)).toBe(true);
  await expect(button(page, '处理流程')).toBeDisabled(); await button(page, '取消导出').click(); await expect(page.locator('.folder-export-panel')).toContainText('已取消导出');
  await expect(button(page, '处理流程')).toBeEnabled(); await expect(page.getByRole('region', { name: '输出文件树预览', exact: true })).toContainText('已写入');
  await button(page, '重试未导出项：选择目录').click(); await button(page, '确认导出到目录').click(); await expect(page.locator('.folder-export-panel')).toContainText('3 成功、0 失败');
  const state = await page.evaluate(() => (window as unknown as { outputContract: { prepared: unknown[][]; writes: Array<{ id: string }> } }).outputContract);
  expect(state.prepared.map(entries => entries.length)).toEqual([3, 2]); expect(state.writes.filter(write => write.id === state.writes[0].id)).toHaveLength(1);
});

for (const mode of ['workflow', 'single']) {
  test(`${mode} processing retry retains flat output mode, written IDs and native collision paths`, async ({ page }) => {
    await nativeOutputContract(page, true); await page.goto('/#/batch');
    if (mode === 'workflow') {
      await button(page, '处理流程').click(); await page.getByLabel('添加步骤类型', { exact: true }).selectOption('clean-spaces'); await button(page, '添加处理步骤').click();
    } else await page.getByLabel('选择批量操作', { exact: true }).selectOption('clean-spaces');
    await button(page, '添加文件夹').click(); await button(page, mode === 'workflow' ? '预览影响' : '预览处理结果').click();
    await expect(page.locator('.task-row .success')).toHaveCount(2); await expect(page.locator('.task-row .failed')).toHaveCount(1);
    await page.getByLabel('输出目录结构', { exact: true }).selectOption('flat'); await button(page, '选择输出目录并预览').click(); await button(page, '确认导出到目录').click();
    await expect(page.locator('.folder-export-panel')).toContainText('2 成功、0 失败');
    await button(page, '重试未完成项').click(); await expect(page.locator('.task-row .success')).toHaveCount(3);
    await expect(page.getByLabel('输出目录结构', { exact: true })).toHaveValue('flat'); await expect(page.getByLabel('输出目录结构', { exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: '输出文件树预览', exact: true })).toContainText('E01_processed (1).srt');
    await button(page, '重试未导出项：选择目录').click(); await button(page, '确认导出到目录').click(); await expect(page.locator('.folder-export-panel')).toContainText('3 成功、0 失败');
    const state = await page.evaluate(() => (window as unknown as { outputContract: { prepared: Array<Array<{ relativePath: string }>>; writes: Array<{ id: string }> } }).outputContract);
    expect(state.prepared.map(entries => entries.length)).toEqual([2, 1]); expect(state.prepared[1][0].relativePath).toBe('Movie_processed.srt'); expect(state.writes).toHaveLength(3);
  });
}

test('single-operation batch reuses folder output planning and changing inputs invalidates its tree', async ({ page }) => {
  await nativeOutputContract(page); await page.goto('/#/batch'); await page.getByLabel('选择批量操作', { exact: true }).selectOption('clean-spaces'); await button(page, '添加文件夹').click(); await button(page, '预览处理结果').click();
  await expect(page.locator('.task-row .success')).toHaveCount(3); await expect(page.getByLabel('输出目录结构', { exact: true })).toHaveValue('preserve');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as unknown as { outputContract: { saved: unknown[] } }).outputContract.saved.length)).toBe(1);
  const saved = await page.evaluate(() => (window as unknown as { outputContract: { saved: Array<{ bytes: number[] }> } }).outputContract.saved[0].bytes);
  expect(Object.keys((await JSZip.loadAsync(Uint8Array.from(saved))).files)).toContain('字幕项目/剧集/S01/E01_processed.srt');
  await page.getByLabel('输出目录结构', { exact: true }).selectOption('flat'); await expect(page.getByRole('region', { name: '输出文件树预览', exact: true })).toContainText('E01_processed (2).srt');
  await page.getByRole('button', { name: '移除 Movie.srt', exact: true }).click(); await expect(page.locator('.results-panel')).toHaveCount(0);
});
