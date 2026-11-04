import { expect, test, type Page } from '@playwright/test';

async function desktopFolderMock(page: Page, scenario: 'stream' | 'cancel' | 'picker-cancel' | 'visual', theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(({ scenario, theme }) => {
    const browser = window as unknown as Record<string, unknown>;
    const bytes = Array.from(new TextEncoder().encode('1\n00:00:01,123 --> 00:00:02,456\n  头发  \n'));
    const first = { name: 'same.srt', path: 'C:\\字幕\\same.srt', bytes, size: bytes.length };
    const next = { name: '第二份 (🐱).srt', path: 'D:\\字幕\\第二份 (🐱).srt', bytes, size: bytes.length };
    let pending: (() => void) | undefined;
    let scans = 0;
    const values: Record<string, unknown> = { settings: { theme } };
    Object.assign(browser, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args: {
          key?: string; value?: unknown; scanId?: string; recursive?: boolean; extensions?: string[];
          existingPaths?: string[]; existingCount?: number; existingBytes?: number;
          onEvent?: { onmessage: (event: unknown) => void };
        }) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_local_value') return values[args.key!] ?? null;
          if (command === 'set_local_value') { values[args.key!] = args.value; return null; }
          if (command === 'select_files') return [first];
          if (command === 'cancel_folder_import') { pending?.(); return null; }
          if (command !== 'select_import_folder') throw new Error(`Unexpected IPC ${command}`);
          scans++;
          browser.folderRequest = { recursive: args.recursive, extensions: args.extensions, existingPaths: args.existingPaths, existingCount: args.existingCount, existingBytes: args.existingBytes };
          const summary = {
            selected: true, visitedEntries: 1, scannedFiles: 1, added: 1, duplicates: 0,
            unsupported: 0, overLimit: 0, failed: 0, unreadableDirectories: 0,
            skippedLinks: 0, depthSkipped: 0, cancelledFiles: 0, limitStopped: false, cancelled: false,
          };
          const emit = (phase: string, file?: typeof first) => args.onEvent!.onmessage({ scanId: args.scanId, phase, summary: { ...summary }, file });
          if (scenario === 'picker-cancel') {
            Object.assign(summary, { selected: false, cancelled: true, visitedEntries: 0, scannedFiles: 0, added: 0 });
            emit('complete'); return null;
          }
          emit('reading', scenario === 'cancel' && scans === 1 ? first : next);
          if (scenario === 'cancel' && scans > 1) { emit('complete'); return null; }
          pending = () => {
            if (scenario === 'cancel') { summary.cancelled = true; summary.cancelledFiles = 1; }
            else {
              summary.visitedEntries = 5; summary.scannedFiles = 4; summary.duplicates = 1; summary.unsupported = 1; summary.failed = 1; summary.skippedLinks = 1;
              if (scenario === 'visual') {
                Object.assign(summary, {
                  visitedEntries: 4000, scannedFiles: 2000, unsupported: 1980, overLimit: 17,
                  unreadableDirectories: 3, skippedLinks: 12, depthSkipped: 2, limitStopped: true,
                });
              }
            }
            emit('complete');
          };
          browser.finishFolder = pending;
          // Deliberately return before the terminal Channel event to exercise the consumption barrier.
          return null;
        },
      },
    });
  }, { scenario, theme });
}

async function expectNoFolderOverflow(page: Page) {
  const sizes = await page.locator('body, .main-content, .folder-import, .folder-import-controls, .folder-import-status').evaluateAll(elements =>
    elements.map(element => ({
      name: element.className || element.tagName,
      client: element.clientWidth,
      scroll: element.scrollWidth,
    })),
  );
  for (const size of sizes) expect(size.scroll, size.name).toBeLessThanOrEqual(size.client + 1);
}

test('native folder streaming preserves the queue and keeps processing locked until terminal delivery', async ({ page }) => {
  await desktopFolderMock(page, 'stream');
  await page.goto('/#/tools/clean-spaces');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(1);
  const preview = page.getByRole('button', { name: '预览处理结果', exact: true });
  await preview.click();
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toBeVisible();
  await expect(page.getByLabel('包含子文件夹', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(preview).toBeDisabled();
  await expect(page.getByLabel('包含子文件夹', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await page.evaluate(() => ((window as unknown as Record<string, () => void>).finishFolder)());
  await expect(preview).toBeEnabled();
  await expect(page.locator('.folder-import-status')).toContainText('扫描完成');
  await expect(page.locator('.folder-import-status')).toContainText('已添加 1 · 重复 1 · 不支持 1');
  await expect(page.locator('.folder-import-status')).toContainText('读取失败 1');
  const request = await page.evaluate(() => (window as unknown as Record<string, unknown>).folderRequest);
  expect(request).toMatchObject({ recursive: false, existingCount: 1, existingPaths: ['C:\\字幕\\same.srt'] });
  await preview.click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(2);
});

test('cancelling a folder scan retains completed files and a new filtered recursive scan can run', async ({ page }) => {
  await desktopFolderMock(page, 'cancel');
  await page.goto('/#/tools/clean-spaces');
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(1);
  await page.getByRole('button', { name: '取消扫描', exact: true }).click();
  await expect(page.locator('.folder-import-status')).toContainText('已取消扫描');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '添加文件夹', exact: true })).toBeEnabled();
  await page.getByLabel('包含子文件夹', { exact: true }).check();
  await page.getByLabel('文件夹文件类型', { exact: true }).selectOption('srt');
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.locator('.folder-import-status')).toContainText('扫描完成');
  await expect(page.locator('.file-row')).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).folderRequest)).toMatchObject({ recursive: true, extensions: ['srt'], existingCount: 1 });
});

test('browser preview keeps native folder access hidden', async ({ page }) => {
  await page.goto('/#/tools/clean-spaces');
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加文件夹', exact: true })).toHaveCount(0);
});

test('cancelling the native folder picker leaves a valid earlier result available', async ({ page }) => {
  await desktopFolderMock(page, 'picker-cancel');
  await page.goto('/#/tools/clean-spaces');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  const save = page.getByRole('button', { name: '另存为', exact: true });
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.locator('.folder-import-status')).toContainText('已取消扫描');
  await expect(save).toBeEnabled();
  await expect(page.locator('.file-row')).toHaveCount(1);
});

for (const viewport of [{ width: 900, height: 620 }, { width: 1200, height: 800 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`folder desktop contract stays visible at ${viewport.width}×${viewport.height} in ${theme} theme`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await desktopFolderMock(page, 'visual', theme);
      await page.goto('/#/tools/clean-spaces');
      const folder = page.locator('.folder-import');
      const add = folder.getByRole('button', { name: '添加文件夹', exact: true });
      const recursive = folder.getByLabel('包含子文件夹', { exact: true });
      const format = folder.getByLabel('文件夹文件类型', { exact: true });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(recursive).not.toBeChecked();
      await expect(format).toHaveValue('all');
      await expect(add).toBeEnabled();
      await expectNoFolderOverflow(page);

      await add.click();
      await expect(folder.getByRole('button', { name: '取消扫描', exact: true })).toBeVisible();
      await expect(folder.getByRole('status')).toContainText('正在读取');
      await expect(format).toBeDisabled();
      await expect(recursive).toBeDisabled();
      await folder.scrollIntoViewIfNeeded();
      await expectNoFolderOverflow(page);
      await folder.screenshot({ path: testInfo.outputPath('folder-contract-reading.png'), animations: 'disabled' });
      await page.evaluate(() => ((window as unknown as Record<string, () => void>).finishFolder)());
      await expect(folder.getByRole('status')).toContainText('扫描完成');
      await expect(folder.getByRole('status')).toContainText('文件 2000 · 已添加 1 · 重复 1 · 不支持 1980 · 超限 17 · 读取失败 1 · 目录失败 3');
      await expect(folder.getByRole('status')).toContainText('已跳过链接 12 项、过深目录 2 项');
      await expect(folder.getByRole('status')).toContainText('已达到扫描或队列上限');
      await expect(add).toBeEnabled();
      await expectNoFolderOverflow(page);
      await folder.screenshot({ path: testInfo.outputPath('folder-contract-complete.png'), animations: 'disabled' });
    });
  }
}

test('folder desktop contract supports keyboard recursion, format choice and scan cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await desktopFolderMock(page, 'cancel', 'dark');
  await page.goto('/#/tools/clean-spaces');
  const folder = page.locator('.folder-import');
  const recursive = folder.getByLabel('包含子文件夹', { exact: true });
  const format = folder.getByLabel('文件夹文件类型', { exact: true });
  await recursive.focus();
  await recursive.press('Space');
  await expect(recursive).toBeChecked();
  await recursive.press('Tab');
  await expect(format).toBeFocused();
  await format.press('Home');
  await format.press('ArrowDown');
  await expect(format).toHaveValue('srt');
  const add = folder.getByRole('button', { name: '添加文件夹', exact: true });
  await add.focus();
  await add.press('Enter');
  await expect(page.locator('.file-row')).toHaveCount(1);
  const cancel = folder.getByRole('button', { name: '取消扫描', exact: true });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await expect(cancel).toBeInViewport();
  await cancel.press('Enter');
  await expect(folder.getByRole('status')).toContainText('已取消扫描');
  await expect(folder.getByRole('status')).toContainText('此前成功加入的文件已保留');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect(add).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).folderRequest))
    .toMatchObject({ recursive: true, extensions: ['srt'] });
  await expectNoFolderOverflow(page);
});
