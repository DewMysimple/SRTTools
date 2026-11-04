import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const source = '1\n00:00:01,234 --> 00:00:02,345\n原始字幕 emoji 🐱\n';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function add(page: Page, names: string[]) {
  const choosing = page.waitForEvent('filechooser');
  await button(page, '选择文件').click();
  await (await choosing).setFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(source) })));
}
async function save(page: Page, name: string) {
  await button(page, '保存为新预设').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '预设名称' }).fill(name);
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function apply(page: Page, name: string) {
  await page.getByLabel('参数预设', { exact: true }).selectOption({ label: name });
  await button(page, '应用预设').click();
}
async function download(page: Page, name: string) {
  const downloading = page.waitForEvent('download');
  await button(page, name).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('a saved preset survives reload and produces identical single-file and batch bytes without storing inputs', async ({ page }) => {
  await page.goto('/#/tools/replace');
  await page.getByLabel('查找内容', { exact: true }).fill('原始');
  await page.getByLabel('替换为', { exact: true }).fill('批量');
  await save(page, '同一套参数');
  await page.reload();
  await expect(page.getByLabel('查找内容', { exact: true })).toHaveValue('');
  await apply(page, '同一套参数');
  await add(page, ['第一份.srt']);
  await button(page, '预览处理结果').click();
  const single = await download(page, '另存为');
  await page.getByRole('link', { name: /^批量处理/u }).click();
  await expect(page.getByLabel('查找内容', { exact: true })).toHaveValue('');
  await apply(page, '同一套参数');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await add(page, ['第二份.srt']);
  await button(page, '预览处理结果').click();
  await expect(page.locator('.task-row .success')).toHaveCount(2);
  const zip = await JSZip.loadAsync(await download(page, '导出 ZIP'));
  expect(await zip.file('第一份_processed.srt')!.async('nodebuffer')).toEqual(single);
  expect(await zip.file('第二份_processed.srt')!.async('nodebuffer')).toEqual(single);
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输出编码', { exact: true }).selectOption('utf-16be');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await expect(button(page, '导出 ZIP')).toHaveCount(0);
  const stored = await page.evaluate(() => ({ preset: localStorage.getItem('subtitle-tools:tool-presets-v1'), keys: Object.keys(localStorage) }));
  expect(stored.preset).not.toContain('第一份');
  expect(stored.preset).not.toContain('outputEncoding');
  expect(stored.preset).not.toContain('原始字幕 emoji');
  expect(stored.keys.some(key => key.includes('batch-presets'))).toBe(false);
});

test('batch updates share the tool preset and tool changes invalidate results while preserving the file queue', async ({ page }) => {
  await page.goto('/#/tools/shift');
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('321');
  await save(page, '共用名称');
  await page.goto('/#/tools/duration');
  await page.getByLabel('时长增减（毫秒）', { exact: true }).fill('456');
  await save(page, '共用名称');
  await page.getByRole('link', { name: '批量处理', exact: true }).click();
  await page.getByLabel('选择批量操作', { exact: true }).selectOption('shift');
  await apply(page, '共用名称');
  await expect(page.getByLabel('偏移量（毫秒）', { exact: true })).toHaveValue('321');
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('654');
  await button(page, '管理预设').click();
  await button(page, '更新预设').click();
  await page.getByRole('dialog').getByRole('button', { name: '确认更新', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await add(page, ['只保留队列.srt']);
  await button(page, '预览处理结果').click();
  await expect(button(page, '另存为')).toBeEnabled();
  await page.getByLabel('选择批量操作', { exact: true }).selectOption('duration');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await expect(page.locator('.file-row')).toHaveCount(1);
  await apply(page, '共用名称');
  await expect(page.getByLabel('时长增减（毫秒）', { exact: true })).toHaveValue('456');
  await page.getByLabel('选择批量操作', { exact: true }).selectOption('clean-spaces');
  await expect(page.getByLabel('参数预设', { exact: true })).toHaveCount(0);
  await page.goto('/#/tools/shift');
  await apply(page, '共用名称');
  await expect(page.getByLabel('偏移量（毫秒）', { exact: true })).toHaveValue('654');
});

test('processing locks the batch tool and preset controls, then leaves a failed batch retryable', async ({ page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    let held = false;
    Worker.prototype.postMessage = function(message: unknown) {
      if (!held) {
        held = true;
        window.addEventListener('release-batch-preset-worker', () => post.call(this, message), { once: true });
      } else post.call(this, message);
    };
  });
  await page.goto('/#/batch');
  await page.getByLabel('查找内容', { exact: true }).fill('原始');
  await page.getByLabel('替换为', { exact: true }).fill('暂存');
  await save(page, '批量锁定');
  const choosing = page.waitForEvent('filechooser');
  await button(page, '选择文件').click();
  await (await choosing).setFiles([
    { name: '有效.srt', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: '失败.srt', mimeType: 'text/plain', buffer: Buffer.from('无时间') },
  ]);
  await button(page, '预览处理结果').click();
  await expect(page.getByLabel('选择批量操作', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('参数预设', { exact: true })).toBeDisabled();
  await expect(button(page, '保存为新预设')).toBeDisabled();
  await expect(button(page, '应用预设')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-batch-preset-worker')));
  await expect(page.locator('.task-row .success')).toHaveCount(1);
  await expect(page.locator('.task-row .failed')).toHaveCount(1);
  await expect(page.getByLabel('替换为', { exact: true })).toHaveValue('暂存');
  await expect(button(page, '重试未完成项')).toBeEnabled();
  await apply(page, '批量锁定');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await expect(page.locator('.file-row')).toHaveCount(2);
});
