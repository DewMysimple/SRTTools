import { expect, test, type Download, type Page } from '@playwright/test';

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
