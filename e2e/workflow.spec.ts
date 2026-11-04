import { expect, test, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeBytes, parseSubtitle } from '../src/core';

interface TestFile { name: string; mimeType: string; buffer: Buffer }
function subtitle(name: string, text: string, start = '00:00:01,000', end = '00:00:03,000'): TestFile {
  return { name, mimeType: 'text/plain', buffer: Buffer.from(`1\n${start} --> ${end}\n${text}\n`) };
}
async function importFiles(page: Page, files: TestFile[]) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await picker).setFiles(files);
}
async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('real worker blocks suspected encoding loss, provides original preview, and accepts a manual override with warning', async ({ page }) => {
  await page.goto('/#/tools/renumber');
  await importFiles(page, [subtitle('suspect.srt', 'Hel\ufffdo 世界')]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '原文预览', exact: true })).toBeVisible();
  await expect(page.locator('.cue-preview')).toContainText('Hel\ufffdo 世界');
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输入文件编码', { exact: true }).selectOption('utf-8');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  await page.locator('.diagnostics > summary').click();
  await expect(page.locator('.diagnostics')).toContainText('可能已有编码损失');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  expect(await downloadText(await downloading)).toContain('Hel\ufffdo 世界');
});

test('real worker repair displays current diagnostics rather than resolved input errors', async ({ page }) => {
  await page.goto('/#/tools/repair');
  await importFiles(page, [subtitle('invalid.srt', 'Repair me', '00:00:03,000', '00:00:02,000')]);
  await page.getByLabel('无效时间策略', { exact: true }).selectOption('extend');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  await expect(page.locator('.diagnostics li.error')).toHaveCount(0);
  await expect(page.locator('.preview-grid > div').nth(1)).toContainText('00:00:03,000 → 00:00:04,000');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  expect(await downloadText(await downloading)).toContain('00:00:03,000 --> 00:00:04,000');
});

test('original input indices and exported history paths remain stable after retrying failed batch items', async ({ page }) => {
  await page.goto('/#/tools/shift');
  await importFiles(page, [
    subtitle('early.srt', 'Cannot shift before zero', '00:00:00,500', '00:00:01,500'),
    subtitle('later.srt', 'Valid after shift', '00:00:03,000', '00:00:05,000'),
  ]);
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('-1000');
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输出文件名规则', { exact: true }).fill('subtitle_{index}');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  await expect(page.locator('.output-list')).toContainText('subtitle_2.srt');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('subtitle_2.srt');
  await expect(page.locator('.export-success')).toContainText('已导出 1 个文件');
  await page.getByRole('button', { name: '重试未完成项', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  await expect(page.locator('.output-list')).toContainText('subtitle_2.srt');
  await expect(page.locator('.export-success')).toContainText('已导出 1 个文件');
  await expect.poll(async () => page.evaluate(() => {
    const records = JSON.parse(localStorage.getItem('subtitle-tools:history') ?? '[]') as { outputPaths?: string[] }[];
    return records[0]?.outputPaths ?? [];
  })).toEqual(['subtitle_2.srt']);
  const historyCount = await page.evaluate(() => (JSON.parse(localStorage.getItem('subtitle-tools:history') ?? '[]') as unknown[]).length);
  expect(historyCount).toBe(1);
});

test('combined failures preserve input provenance and never create partial merged output', async ({ page }) => {
  await page.goto('/#/tools/merge');
  const first = subtitle('first.srt', 'Keep me');
  first.buffer = Buffer.from(first.buffer.toString('utf8').replace(/^1/u, '5'));
  await importFiles(page, [first, { name: 'broken.srt', mimeType: 'text/plain', buffer: Buffer.from('unparseable subtitle') }]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.locator('.diagnostics')).toContainText('first.srt');
  await expect(page.locator('.diagnostics')).toContainText('broken.srt');
  await expect(page.locator('.cue-preview')).toContainText('Keep me');
  await expect(page.locator('.output-list')).toHaveCount(0);
});

test('a cancelled file picker keeps the queue and current export, but editing inputs invalidates the result', async ({ page }) => {
  await page.goto('/#/tools/replace');
  const input = subtitle('first.srt', '原始文本');
  await importFiles(page, [input]);
  const preview = page.getByRole('button', { name: '预览处理结果', exact: true });
  const save = page.getByRole('button', { name: '另存为', exact: true });
  const replacement = page.getByLabel('替换为', { exact: true });
  await page.getByLabel('查找内容', { exact: true }).fill('原始');
  await replacement.fill('修改');
  await preview.click();
  await expect(save).toBeEnabled();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).element().dispatchEvent('cancel');
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled();
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect(save).toBeEnabled();

  const downloads: Download[] = [];
  page.on('download', download => downloads.push(download));
  await replacement.fill('再次修改');
  await expect(save).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await preview.click();
  await expect(save).toBeEnabled();
  await expect(page.locator('.results-panel')).toContainText('再次修改文本');

  await page.locator('.export-options > summary').click();
  await page.getByLabel('输入文件编码', { exact: true }).selectOption('utf-8');
  await expect(save).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await preview.click();
  await expect(save).toBeEnabled();
  await importFiles(page, [subtitle('second.srt', '另一条字幕')]);
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(save).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await preview.click();
  await expect(page.getByRole('button', { name: '导出全部文件', exact: true })).toBeEnabled();
  await page.goto('/#/tools/renumber');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  expect(downloads).toHaveLength(0);
});

test('desktop batch export reuses the canonical directory selected while authorizing the first file', async ({ page }) => {
  const bytes = [...subtitle('unused.srt', '保留原文').buffer];
  const preferred = 'C:\\默认输出';
  const actual = 'D:\\';
  await page.addInitScript(({ bytes, preferred, actual }) => {
    let history: unknown = null;
    const requests: unknown[] = [];
    Object.assign(window, {
      isTauri: true,
      saveRequests: requests,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: { key?: string; value?: unknown; directory?: string; name?: string }) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_local_value') return args.key === 'settings' ? { outputDirectory: preferred } : history;
          if (command === 'set_local_value') { history = args.value; return null; }
          if (command === 'select_files') {
            return ['第一集 (😀).srt', '第二集.srt'].map(name => ({ name, path: `C:\\字幕\\${name}`, bytes, size: bytes.length }));
          }
          if (command === 'save_output') {
            requests.push(args.directory);
            if (requests.length === 1 || args.directory === actual) return actual + args.name;
            return null;
          }
          throw new Error(`Unexpected mock IPC: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    });
  }, { bytes, preferred, actual });
  await page.goto('/#/tools/renumber');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(2);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await page.getByRole('button', { name: '导出全部文件', exact: true }).click();
  await expect(page.locator('.export-success')).toContainText('已导出 2 个文件');
  const requests = await page.evaluate(() => Reflect.get(window, 'saveRequests'));
  expect(requests).toEqual([preferred, actual]);
});

test('synthetic Unicode and legacy fixtures preserve body and timing, while unsafe inputs stay isolated', async ({ page }) => {
  const unicodeName = '第一集 (测试 😀).srt';
  const unicode = await readFile(new URL(`../examples/回归/${unicodeName}`, import.meta.url));
  const duplicateName = '重复编号.srt';
  const duplicate = await readFile(new URL(`../examples/回归/${duplicateName}`, import.meta.url));
  const invalidName = '非法时间.srt';
  const invalid = await readFile(new URL(`../examples/回归/${invalidName}`, import.meta.url));
  await page.goto('/#/tools/renumber');
  await importFiles(page, [
    { name: unicodeName, mimeType: 'text/plain', buffer: unicode },
    { name: duplicateName, mimeType: 'text/plain', buffer: duplicate },
    { name: invalidName, mimeType: 'text/plain', buffer: invalid },
    { name: 'empty.srt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(2);
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(2);
  await expect(page.locator('.task-list')).toContainText('非法时间');

  const downloading = page.waitForEvent('download');
  await page.locator('.output-list > div').filter({ hasText: '重复编号_processed.srt' }).getByRole('button', { name: '导出', exact: true }).click();
  const output = await downloadText(await downloading);
  const expected = parseSubtitle(decodeBytes(duplicate).text, duplicateName).document.cues;
  expect(expected.map(cue => cue.index)).toEqual([3, 3]);
  const actual = parseSubtitle(output, duplicateName).document.cues;
  expect(actual.map(({ index, text, startMs, endMs }) => ({ index, text, startMs, endMs })))
    .toEqual(expected.map(({ text, startMs, endMs }, index) => ({ index: index + 1, text, startMs, endMs })));
  expect(output).toContain('\r\n');
  expect(await readFile(new URL(`../examples/回归/${duplicateName}`, import.meta.url))).toEqual(duplicate);

  await page.getByRole('button', { name: '清空', exact: true }).click();
  const legacyName = '旧编码 (GBK).srt';
  const legacy = await readFile(new URL(`../examples/回归/${legacyName}`, import.meta.url));
  await importFiles(page, [{ name: legacyName, mimeType: 'text/plain', buffer: legacy }]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输入文件编码', { exact: true }).selectOption('gb18030');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  const legacyDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  expect(await downloadText(await legacyDownload)).toContain('合成示例：中文字幕');
});
