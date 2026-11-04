import { expect, test, type Download, type Page } from '@playwright/test';
import JSZip from 'jszip';

function subtitle(text: string, newline = '\n') {
  return `8${newline}00:00:01,234 --> 00:00:02,345${newline}${text}${newline}`;
}

async function addFiles(page: Page, files: { name: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).setFiles(files.map(file => ({ ...file, mimeType: 'text/plain' })));
}

async function bytes(download: Download) {
  const chunks: Buffer[] = [];
  const stream = await download.createReadStream();
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('GBK download contains the exact legacy bytes and chosen LF line endings', async ({ page }) => {
  await page.goto('/#/tools/encoding');
  await addFiles(page, [{ name: '中文.srt', buffer: Buffer.from(subtitle('中文', '\r\n')) }]);
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输出编码', { exact: true }).selectOption('gbk');
  await page.getByLabel('输出换行符', { exact: true }).selectOption('LF');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge')).toHaveText('已处理');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('中文_processed.srt');
  expect(await bytes(download)).toEqual(Buffer.concat([
    Buffer.from('1\n00:00:01,234 --> 00:00:02,345\n'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n'),
  ]));
});

test('GBK rejection identifies the cue and emoji, while GB18030 single and ZIP output agree byte for byte', async ({ page }) => {
  await page.goto('/#/batch');
  await page.getByLabel('选择批量操作', { exact: true }).selectOption('encoding');
  await addFiles(page, [
    { name: '表情.srt', buffer: Buffer.from(subtitle('😀')) },
    { name: '继续.srt', buffer: Buffer.from(subtitle('中文')) },
  ]);
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输出编码', { exact: true }).selectOption('gbk');
  const run = page.getByRole('button', { name: '预览处理结果', exact: true });
  await run.click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  await page.locator('.task-row').filter({ hasText: '表情.srt' }).click();
  await expect(page.locator('.result-details')).toContainText('第 1 条字幕');
  await expect(page.locator('.result-details')).toContainText('😀');
  await expect(page.locator('.result-details')).toContainText('U+1F600');
  await expect(page.locator('.output-list')).not.toContainText('表情_processed.srt');
  await page.getByLabel('输出编码', { exact: true }).selectOption('gb18030');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await run.click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(2);
  const singleDownloading = page.waitForEvent('download');
  await page.locator('.output-list > div').filter({ hasText: '表情_processed.srt' }).getByRole('button', { name: '导出', exact: true }).click();
  const single = await bytes(await singleDownloading);
  expect(single.subarray(-6)).toEqual(Buffer.from([0x94, 0x39, 0xfc, 0x36, 13, 10]));
  const zipDownloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click();
  const zip = await JSZip.loadAsync(await bytes(await zipDownloading));
  expect(await zip.file('表情_processed.srt')!.async('uint8array')).toEqual(new Uint8Array(single));
  expect(new TextDecoder('gb18030', { fatal: true }).decode(single)).toContain('😀');
});

test('saved legacy output preference survives reload and leaves the manual input-confirmation gate intact', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByLabel('默认输出编码', { exact: true })).toHaveValue('utf-8');
  await page.getByLabel('默认输出编码', { exact: true }).selectOption('gb18030');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('默认输出编码', { exact: true })).toHaveValue('gb18030');
  await page.goto('/#/tools/encoding');
  await addFiles(page, [{ name: '旧编码.srt', buffer: Buffer.concat([
    Buffer.from('7\n00:00:01,234 --> 00:00:02,345\n'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n'),
  ]) }]);
  await page.locator('.export-options > summary').click();
  await expect(page.getByLabel('输出编码', { exact: true })).toHaveValue('gb18030');
  const run = page.getByRole('button', { name: '预览处理结果', exact: true });
  await run.click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await page.getByLabel('输入文件编码', { exact: true }).selectOption('gbk');
  await run.click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const output = await bytes(await downloading);
  expect(new TextDecoder('gb18030', { fatal: true }).decode(output)).toContain('中文');
});
