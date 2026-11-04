import { expect, test, type Page } from '@playwright/test';
import { parseSubtitle } from '../src/core';

const sample = '8\n00:00:01,123 --> 00:00:03,456\n头发 理发 发现 干杯 干部 后面 皇后\nEnglish 123 😀\n';

async function addFiles(page: Page, files: { name: string; text: string }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).setFiles(files.map(({ name, text }) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })));
}

async function savePreset(page: Page, name: string) {
  await page.getByRole('button', { name: '保存为新预设', exact: true }).click();
  await page.getByLabel('预设名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Chinese tool preserves numbering and newline layout, exposes text-only differences and saves a direction preset', async ({ page }) => {
  await page.goto('/#/tools/chinese');
  await expect(page.getByRole('heading', { name: '简繁转换', exact: true })).toBeVisible();
  await expect(page.getByLabel('转换方向', { exact: true })).toHaveValue('s2t');
  await addFiles(page, [{ name: '词组.srt', text: sample }]);
  await page.locator('.export-options > summary').click();
  await expect(page.getByLabel('输出换行符', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('输出换行符', { exact: true })).toHaveValue('preserve');
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge')).toHaveText('已处理');
  const summary = page.locator('.diff-summary');
  await expect(summary).toContainText('正文变更 1');
  await expect(summary).toContainText('时间变更 0');
  await expect(summary).toContainText('编号变更 0');
  await expect(page.locator('.diff-row .cue p').nth(1)).toContainText('頭髮 理髮 發現 乾杯 幹部 後面 皇后');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toBe(sample.replace('头发 理发 发现 干杯 干部 后面 皇后', '頭髮 理髮 發現 乾杯 幹部 後面 皇后'));
  expect(parseSubtitle(text, 'out.srt').document.cues[0].index).toBe(8);
  await page.getByLabel('转换方向', { exact: true }).selectOption('t2s');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await savePreset(page, '繁转简');
  await page.reload();
  await expect(page.getByLabel('转换方向', { exact: true })).toHaveValue('s2t');
  await page.getByLabel('参数预设', { exact: true }).selectOption({ label: '繁转简' });
  await page.getByRole('button', { name: '应用预设', exact: true }).click();
  await expect(page.getByLabel('转换方向', { exact: true })).toHaveValue('t2s');
});

test('Chinese batch uses the existing preset, isolates bad input and produces the actual retained-format ZIP', async ({ page }) => {
  await page.goto('/#/tools/chinese');
  await savePreset(page, '通用繁体');
  await page.getByRole('link', { name: '批量处理', exact: true }).click();
  await page.getByLabel('选择批量操作', { exact: true }).selectOption('chinese');
  await page.getByLabel('参数预设', { exact: true }).selectOption({ label: '通用繁体' });
  await page.getByRole('button', { name: '应用预设', exact: true }).click();
  await addFiles(page, [
    { name: '词组.srt', text: sample },
    { name: '结构损坏.srt', text: '没有时间的字幕' },
    { name: '继续.txt', text: '9\r\n00:00:01,000 --> 00:00:02,000\r\n发现\r\n' },
  ]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(2);
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  expect(Object.keys(zip.files)).toEqual(['词组_processed.srt', '继续_processed.txt']);
  expect(await zip.file('继续_processed.txt')!.async('string')).toBe('9\r\n00:00:01,000 --> 00:00:02,000\r\n發現\r\n');
  const stored = await page.evaluate(() => localStorage.getItem('subtitle-tools:tool-presets-v1'));
  expect(stored).not.toContain('头发');
  expect(stored).not.toContain('outputEncoding');
});

test('cancelling the Chinese worker leaves queued files cancelled and allows a fresh run', async ({ page }) => {
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    let holdFirst = true;
    window.Worker = class extends RealWorker {
      postMessage(message: unknown) {
        if (holdFirst) { holdFirst = false; return; }
        super.postMessage(message);
      }
    };
  });
  await page.goto('/#/tools/chinese');
  await addFiles(page, [{ name: '第一份.srt', text: sample }, { name: '第二份.srt', text: sample }]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.getByLabel('转换方向', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消处理', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.cancelled')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '导出全部文件', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重试未完成项', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.success')).toHaveCount(2);
});
