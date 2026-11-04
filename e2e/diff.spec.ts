import { expect, test, type Page } from '@playwright/test';
import { formatTimestamp, parseSubtitle } from '../src/core';

function fixture(texts: readonly string[]) {
  return texts.map((text, index) => {
    const start = index * 2_000 + 123;
    return `${index + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(start + 1_234)}\n${text}\n`;
  }).join('\n');
}

async function addFiles(page: Page, files: { name: string; text: string }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).setFiles(files.map(({ name, text }) => ({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  })));
}

async function runTool(page: Page) {
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge')).toHaveText('已处理');
}

async function exportText(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('replacement highlights just the changed text and preserves the previewed download', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.addInitScript(() => localStorage.setItem('subtitle-tools:settings', JSON.stringify({ theme: 'dark' })));
  await page.goto('/#/tools/replace');
  const first = '我觉的这个方案不错。👩🏽‍💻 e\u0301\n<img src=x onerror=alert(1)>';
  const input = fixture([first, '第二条', '第三条']);
  await addFiles(page, [{ name: '差异.srt', text: input }]);
  await page.getByLabel('查找内容', { exact: true }).fill('觉的');
  await page.getByLabel('替换为', { exact: true }).fill('觉得');
  await runTool(page);

  const diff = page.getByRole('region', { name: '字幕差异预览', exact: true });
  const rows = diff.locator('.diff-row');
  await expect(diff.locator('.diff-summary')).toContainText('正文变更 1');
  await expect(diff.locator('.diff-summary')).toContainText('时间变更 0');
  await expect(diff.locator('.diff-summary')).toContainText('未变化 2');
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator('.diff-delete')).toHaveText('的');
  await expect(rows.first().locator('.diff-insert')).toHaveText('得');
  await expect(rows.first().locator('.cue code')).toHaveText([
    '00:00:00,123 → 00:00:01,357', '00:00:00,123 → 00:00:01,357',
  ]);
  await expect(rows.first().locator('.cue p').nth(1)).toContainText('<img src=x onerror=alert(1)>');
  await expect(rows.locator('img')).toHaveCount(0);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 900);
  const onlyChanged = diff.getByRole('button', { name: '仅变化', exact: true });
  await onlyChanged.press('Enter');
  await expect(onlyChanged).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await diff.screenshot({ path: testInfo.outputPath('diff-dark-900x620.png'), animations: 'disabled' });

  const output = parseSubtitle(await exportText(page), '差异_processed.srt').document;
  const before = parseSubtitle(input, '差异.srt').document;
  expect(output.cues.map(cue => [cue.startMs, cue.endMs])).toEqual(before.cues.map(cue => [cue.startMs, cue.endMs]));
  expect(output.cues.map(cue => cue.text)).toEqual([first.replace('觉的', '觉得'), '第二条', '第三条']);
});

test('deleting two middle cues maintains paired rows and paginates the 41 logical rows', async ({ page }) => {
  await page.goto('/#/tools/remove-empty');
  const texts = Array.from({ length: 41 }, (_, i) => i === 1 || i === 22 ? '' : `正文 ${i + 1}`);
  await addFiles(page, [{ name: '空白.srt', text: fixture(texts) }]);
  await runTool(page);
  const diff = page.getByRole('region', { name: '字幕差异预览', exact: true });
  const rows = diff.locator('.diff-row');
  await expect(diff.locator('.diff-summary')).toContainText('删除 2');
  await expect(diff.locator('.diff-summary')).toContainText('正文变更 0');
  await expect(rows).toHaveCount(20);
  await expect(rows.nth(1)).toContainText('已删除');
  await expect(rows.nth(2).locator('.cue p')).toHaveText(['正文 3', '正文 3']);

  const next = diff.getByRole('button', { name: '下一页', exact: true });
  await next.click();
  await expect(diff.locator('.pagination')).toContainText('2 / 3');
  await expect(rows.nth(2)).toContainText('已删除');
  await expect(rows.nth(3).locator('.cue p')).toHaveText(['正文 24', '正文 24']);
  await next.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.cue p')).toHaveText(['正文 41', '正文 41']);
  await expect(next).toBeDisabled();
  await diff.getByRole('button', { name: '仅变化', exact: true }).click();
  await expect(diff.locator('.pagination')).toContainText('1 / 2');
  await expect(rows).toHaveCount(20);
  const output = parseSubtitle(await exportText(page), '空白_processed.srt').document;
  expect(output.cues.map(cue => cue.text)).toEqual(texts.filter(Boolean));
});

test('switching the split output refreshes the scope, counters, filter and page', async ({ page }) => {
  await page.goto('/#/tools/split-count');
  await addFiles(page, [{ name: '拆分.srt', text: fixture(Array.from({ length: 45 }, (_, i) => `段落 ${i + 1}`)) }]);
  await page.getByLabel('每个文件的条目数', { exact: true }).fill('24');
  await runTool(page);
  const diff = page.getByRole('region', { name: '字幕差异预览', exact: true });
  await expect(diff.locator('.diff-summary')).toContainText('删除 21');
  await expect(diff).toContainText('可能出现在其他分段');
  await diff.getByRole('button', { name: '仅变化', exact: true }).click();
  await diff.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(diff.locator('.pagination')).toContainText('2 / 2');
  await page.getByLabel('预览输出文件', { exact: true }).selectOption('1');
  await expect(diff.locator('.diff-summary')).toContainText('删除 24');
  await expect(diff.locator('.diff-summary')).toContainText('编号变更 21');
  await expect(diff.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff.locator('.pagination')).toContainText('1 / 3');
});

test('renumber and shift mark distinct fields and preserve millisecond labels', async ({ page }) => {
  await page.goto('/#/tools/renumber');
  await addFiles(page, [{ name: '编号.srt', text: fixture(['保留正文']).replace(/^1/u, '8') }]);
  await runTool(page);
  const diff = page.getByRole('region', { name: '字幕差异预览', exact: true });
  const summary = diff.locator('.diff-summary');
  await expect(summary).toContainText('编号变更 1');
  await expect(summary).toContainText('时间变更 0');
  await expect(summary).toContainText('正文变更 0');
  await expect(diff.locator('.diff-field')).toHaveText(['8', '1']);
  await expect(diff.locator('code.diff-field')).toHaveCount(0);

  await page.goto('/#/tools/shift');
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await addFiles(page, [{ name: '时间.srt', text: fixture(['保留正文']) }]);
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('321');
  await runTool(page);
  await expect(summary).toContainText('时间变更 1');
  await expect(summary).toContainText('编号变更 0');
  await expect(summary).toContainText('正文变更 0');
  await expect(diff.locator('.diff-field')).toHaveText([
    '00:00:00,123 → 00:00:01,357', '00:00:00,444 → 00:00:01,678',
  ]);
});

test('an unchanged document and an intentionally empty output have distinct preview states', async ({ page }) => {
  await page.goto('/#/tools/renumber');
  await addFiles(page, [{ name: '空字幕.srt', text: fixture(['']) }]);
  await runTool(page);
  const diff = page.getByRole('region', { name: '字幕差异预览', exact: true });
  await expect(diff).toContainText('字幕条目无变化');
  await diff.getByRole('button', { name: '仅变化', exact: true }).click();
  await expect(diff.locator('.diff-row')).toHaveCount(0);
  await expect(diff).toContainText('没有可显示的差异行');

  await page.goto('/#/tools/remove-empty');
  await runTool(page);
  await expect(diff).toContainText('所选输出没有字幕条目');
  await expect(diff.locator('.diff-summary')).toContainText('删除 1');
  await expect(diff.locator('.diff-row')).toContainText('已删除');
  expect(await exportText(page)).toBe('');
});

test('TXT and JSON keep text previews and export the actual content', async ({ page }) => {
  await page.goto('/#/tools/extract');
  await addFiles(page, [{ name: '报告.srt', text: fixture(['只导出正文', '第二行']) }]);
  await runTool(page);
  await expect(page.locator('.diff-summary')).toHaveCount(0);
  await expect(page.locator('.text-preview')).toHaveText('只导出正文 第二行');
  expect(await exportText(page)).toBe('只导出正文\r\n\r\n第二行');

  await page.goto('/#/tools/detect');
  await runTool(page);
  await expect(page.locator('.diff-summary')).toHaveCount(0);
  await expect(page.locator('.text-preview')).toContainText('"cueCount": 2');
  const report = JSON.parse(await exportText(page)) as { cueCount: number };
  expect(report.cueCount).toBe(2);
  await expect(page.locator('.text-preview')).not.toContainText('只导出正文');
});

test('combined output shows an output overview and no fictional matches to one input', async ({ page }) => {
  await page.goto('/#/tools/merge');
  await addFiles(page, [
    { name: '甲.srt', text: fixture(['甲文件的正文']) },
    { name: '乙.srt', text: fixture(['乙文件的正文']) },
  ]);
  await runTool(page);
  await expect(page.getByText('此结果由多个输入合成，以下显示所选输出的字幕概览。', { exact: true })).toBeVisible();
  await expect(page.locator('.diff-summary')).toHaveCount(0);
  await expect(page.locator('.cue-preview .cue p')).toHaveText(['甲文件的正文', '乙文件的正文']);
});

test('oversized comparisons fall back to bounded previews that still page and export', async ({ page }) => {
  await page.goto('/#/tools/renumber');
  await addFiles(page, [{ name: '长文件.srt', text: fixture(Array.from({ length: 5_101 }, (_, i) => `字幕 ${i + 1}`)) }]);
  await runTool(page);
  await expect(page.getByText(/字幕规模较大，无法精确对齐/)).toBeVisible();
  await expect(page.locator('.diff-summary')).toHaveCount(0);
  await expect(page.locator('.preview-grid .cue')).toHaveCount(40);
  await page.locator('.result-details').getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.preview-grid .cue p').first()).toHaveText('字幕 21');
  const output = parseSubtitle(await exportText(page), '长文件_processed.srt').document;
  expect(output.cues).toHaveLength(5_101);
});
