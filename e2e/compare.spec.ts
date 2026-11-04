import { expect, test, type Page } from '@playwright/test';
import { formatTimestamp } from '../src/core/time';

interface Cue {
  index: number;
  text: string;
  start: number;
  end: number;
}

interface VisualSummary {
  beforeCount: number;
  afterCount: number;
  affected: number;
  unchanged: number;
  added: number;
  removed: number;
  textChanged: number;
  timeChanged: number;
  indexChanged: number;
  reordered: number;
  ambiguous: number;
}

interface ComparisonReport {
  visualComparison: {
    mode: 'logical';
    timeToleranceMs: number;
    kind: 'aligned' | 'fallback' | 'unavailable';
    summary?: VisualSummary;
    beforeCount?: number;
    afterCount?: number;
    reason?: string;
  };
}

function cue(index: number, text: string, start = index * 2000 + 123): Cue {
  return { index, text, start, end: start + 1234 };
}

function subtitle(cues: readonly Cue[]) {
  return cues.map(cue => `${cue.index}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}\n`).join('\n');
}

async function addFiles(page: Page, files: { name: string; text: string }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).setFiles(files.map(({ name, text }) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })));
}

async function compare(page: Page, before: readonly Cue[], after: readonly Cue[], names = ['第一份.srt', '第二份.srt']) {
  await page.goto('/#/tools/compare');
  await addFiles(page, [{ name: names[0], text: subtitle(before) }, { name: names[1], text: subtitle(after) }]);
  await run(page);
}

async function run(page: Page) {
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge')).toHaveText('已处理');
}

async function downloadReport(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  return { bytes, report: JSON.parse(bytes.toString('utf8')) as ComparisonReport };
}

function diffRegion(page: Page) {
  return page.getByRole('region', { name: '字幕差异预览', exact: true });
}

async function expectSummaryMatchesReport(page: Page, summary: VisualSummary) {
  const labels = {
    affected: '受影响行', unchanged: '未变化', added: '新增', removed: '删除', textChanged: '正文变更',
    timeChanged: '时间变更', indexChanged: '编号变更', reordered: '重排', ambiguous: '未匹配',
  } as const;
  const values = await diffRegion(page).locator('.diff-summary > div').evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [
      element.querySelector('dt')?.textContent,
      Number(element.querySelector('dd')?.textContent),
    ])),
  );
  for (const [key, label] of Object.entries(labels)) {
    expect(values[label], label).toBe(summary[key as keyof typeof labels]);
  }
}

test('independently parsed identical SRTs show source labels and the same logical summary in UI and JSON', async ({ page }) => {
  const cues = [cue(7, '唯一机密字幕哨兵 👩🏽‍💻 e\u0301'), cue(8, '第二条')];
  await compare(page, cues, cues, ['首份 (😀).srt', '对照.srt']);
  const diff = diffRegion(page);
  await expect(diff.getByRole('columnheader', { name: '第一份 · 首份 (😀).srt', exact: true })).toBeVisible();
  await expect(diff.getByRole('columnheader', { name: '第二份 · 对照.srt', exact: true })).toBeVisible();
  await expect(diff.getByRole('table', { name: '两份独立字幕的逻辑对比', exact: true })).toBeVisible();
  await expect(diff.locator('.diff-row')).toHaveCount(2);
  const { bytes, report } = await downloadReport(page);
  expect(report.visualComparison).toMatchObject({
    mode: 'logical', timeToleranceMs: 100, kind: 'aligned',
    summary: { beforeCount: 2, afterCount: 2, unchanged: 2, affected: 0 },
  });
  await expectSummaryMatchesReport(page, report.visualComparison.summary!);
  expect(bytes.toString('utf8')).not.toContain('唯一机密字幕哨兵');
  expect(report.visualComparison).not.toHaveProperty('rows');
  expect(report.visualComparison).not.toHaveProperty('cues');
  await page.getByText('查看 JSON 差异报告', { exact: true }).click();
  await expect(page.locator('.text-preview')).toContainText('"visualComparison"');
});

test('insertions and removals stay aligned across pages and display filters never change report bytes', async ({ page }) => {
  const before = Array.from({ length: 43 }, (_, index) => cue(index + 1, `唯一正文 ${index + 1}`));
  const after = before.filter(cue => cue.index !== 2);
  after.splice(after.length - 1, 0, cue(99, '新加入的正文', before[41].start + 1500));
  await compare(page, before, after);
  const diff = diffRegion(page);
  await expect(diff.locator('.diff-row')).toHaveCount(20);
  await expect(diff.locator('.diff-row').nth(1)).toContainText('已删除');
  await expect(diff.locator('.diff-row').nth(2).locator('.cue p')).toHaveText(['唯一正文 3', '唯一正文 3']);
  const initial = await downloadReport(page);
  expect(initial.report.visualComparison.summary).toMatchObject({ added: 1, removed: 1, unchanged: 42, affected: 2, textChanged: 0, timeChanged: 0, indexChanged: 0 });
  await diff.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(diff.locator('.pagination')).toContainText('2 / 3');
  await diff.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(diff.locator('.diff-row')).toHaveCount(4);
  await expect(diff.locator('.diff-row')).toContainText(['唯一正文 41', '唯一正文 42', '新增', '唯一正文 43']);
  await diff.getByRole('button', { name: '仅变化', exact: true }).click();
  await expect(diff.locator('.diff-row')).toHaveCount(2);
  await expect(diff.locator('.pagination')).toContainText('1 / 1');
  expect((await downloadReport(page)).bytes).toEqual(initial.bytes);
  await expectSummaryMatchesReport(page, initial.report.visualComparison.summary!);
});

test('number and order changes in two independent files do not become fictional text or time changes', async ({ page }) => {
  const before = [cue(1, '甲'), cue(2, '乙'), cue(3, '丙')];
  const after = [{ ...before[1], index: 20 }, { ...before[0], index: 10 }, { ...before[2], index: 30 }];
  await compare(page, before, after);
  const { report } = await downloadReport(page);
  expect(report.visualComparison.summary).toMatchObject({ indexChanged: 3, reordered: 2, textChanged: 0, timeChanged: 0, added: 0, removed: 0 });
  await expectSummaryMatchesReport(page, report.visualComparison.summary!);
  await expect(diffRegion(page).locator('.diff-row .cue p')).toHaveText(['乙', '乙', '甲', '甲', '丙', '丙']);
});

test('duplicate bodies at identical times stay explicitly ambiguous', async ({ page }) => {
  const before = [cue(1, '重复正文', 1000), cue(2, '重复正文', 1000)];
  await compare(page, before, [before[0]]);
  const diff = diffRegion(page);
  await expect(diff).toContainText('部分条目无法可靠匹配');
  await expect(diff.locator('.diff-row')).toHaveCount(3);
  await expect(diff.getByText('未匹配 · 第二份无可靠配对', { exact: true })).toHaveCount(2);
  await expect(diff.getByText('未匹配 · 第一份无可靠配对', { exact: true })).toHaveCount(1);
  const { report } = await downloadReport(page);
  expect(report.visualComparison.summary).toMatchObject({ ambiguous: 3, unchanged: 0, added: 0, removed: 0, textChanged: 0 });
  await expectSummaryMatchesReport(page, report.visualComparison.summary!);
});

test('the configured time tolerance applies to logical flags and its JSON summary', async ({ page }) => {
  const before = cue(1, '稳定的时间锚点');
  const after = { ...before, start: before.start + 51, end: before.end + 51 };
  await compare(page, [before], [after]);
  const first = await downloadReport(page);
  expect(first.report.visualComparison).toMatchObject({ timeToleranceMs: 100, summary: { timeChanged: 0, unchanged: 1 } });
  await expectSummaryMatchesReport(page, first.report.visualComparison.summary!);
  await page.getByLabel('允许的时间差（毫秒）', { exact: true }).fill('0');
  await expect(diffRegion(page)).toHaveCount(0);
  await run(page);
  const strict = await downloadReport(page);
  expect(strict.report.visualComparison).toMatchObject({ timeToleranceMs: 0, summary: { timeChanged: 1, unchanged: 0, textChanged: 0 } });
  await expectSummaryMatchesReport(page, strict.report.visualComparison.summary!);
  await expect(diffRegion(page).locator('.cue code')).toHaveText([
    '00:00:02,123 → 00:00:03,357', '00:00:02,174 → 00:00:03,408',
  ]);
});

test('independent Unicode text changes are highlighted safely in a narrow dark window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.addInitScript(() => localStorage.setItem('subtitle-tools:settings', JSON.stringify({ theme: 'dark' })));
  const text = '唯一正文 👩🏽‍💻 e\u0301 觉的\n下一行 <img src=x onerror=alert(1)>';
  const before = cue(1, text);
  const after = { ...before, text: text.replace('觉的', '觉得') };
  await compare(page, [before], [after]);
  const diff = diffRegion(page);
  await expect(diff.locator('.cue p')).toHaveText([text, after.text]);
  await expect(diff.locator('.diff-delete')).toHaveText('的');
  await expect(diff.locator('.diff-insert')).toHaveText('得');
  await expect(diff.locator('img')).toHaveCount(0);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 900);
  await diff.getByRole('button', { name: '仅变化', exact: true }).press('Enter');
  await expect(diff.getByRole('button', { name: '仅变化', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await diff.screenshot({ path: testInfo.outputPath('independent-compare-dark.png'), animations: 'disabled' });
  const { bytes, report } = await downloadReport(page);
  expect(report.visualComparison.summary).toMatchObject({ textChanged: 1, timeChanged: 0, indexChanged: 0 });
  await expectSummaryMatchesReport(page, report.visualComparison.summary!);
  expect(bytes.toString('utf8')).not.toContain('唯一正文');
});

test('5000 long cues in each file reach the text budget and retain bounded independent previews', async ({ page }) => {
  const before = Array.from({ length: 5000 }, (_, index) => cue(index + 1, `大型正文 ${index + 1} ${'合成'.repeat(105)}`));
  await compare(page, before, before);
  const diff = diffRegion(page);
  await expect(diff).toContainText('字幕规模较大，无法精确对齐。第一份 5000 条，第二份 5000 条');
  await expect(diff.locator('.diff-summary')).toHaveCount(0);
  await expect(diff.locator('.preview-grid .cue')).toHaveCount(40);
  const first = await downloadReport(page);
  expect(first.report.visualComparison).toMatchObject({ kind: 'fallback', beforeCount: 5000, afterCount: 5000, reason: 'size-limit' });
  expect(first.report.visualComparison).not.toHaveProperty('summary');
  expect(first.bytes.toString('utf8')).not.toContain('大型正文');
  await diff.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(diff.locator('.preview-grid .cue p').first()).toContainText('大型正文 21');
  expect((await downloadReport(page)).bytes).toEqual(first.bytes);
});

test('a failed new comparison cannot retain an earlier successful logical preview or report export', async ({ page }) => {
  await compare(page, [cue(1, '第一份')], [cue(1, '第二份')]);
  await expect(diffRegion(page)).toBeVisible();
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(diffRegion(page)).toHaveCount(0);
  await addFiles(page, [
    { name: 'valid.srt', text: subtitle([cue(1, '保留这份')]) },
    { name: 'unreadable.exe', text: '此格式在导入时即被拒绝' },
  ]);
  await page.getByRole('button', { name: '预览处理结果', exact: true }).click();
  await expect(page.locator('.task-row .status-badge.failed')).toHaveCount(1);
  await expect(diffRegion(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
});

test('parse damage retains the diagnostic report without pretending a missing document is a deletion', async ({ page }) => {
  await page.goto('/#/tools/compare');
  await addFiles(page, [
    { name: 'first.srt', text: subtitle([cue(7, '不应作为删除项的完整正文')]) },
    { name: 'damaged.srt', text: '没有字幕时间结构' },
  ]);
  await run(page);
  await expect(diffRegion(page)).toHaveCount(0);
  await expect(page.getByText('源文件存在解析错误，逻辑对比暂不可用。请先根据诊断修正源文件，仍可导出诊断报告。', { exact: true })).toBeVisible();
  await expect(page.locator('.diagnostics')).toContainText('damaged.srt');
  const { bytes, report } = await downloadReport(page);
  expect(report.visualComparison).toMatchObject({ kind: 'unavailable', reason: 'input-errors', mode: 'logical', timeToleranceMs: 100 });
  expect(report.visualComparison).not.toHaveProperty('summary');
  expect(bytes.toString('utf8')).not.toContain('不应作为删除项的完整正文');
});

test('uncertain input encoding suspends logical matches until the user explicitly confirms the input encoding', async ({ page }) => {
  const before = cue(1, 'Hel\ufffdo 世界');
  const after = cue(1, 'Hello 世界');
  await compare(page, [before], [after]);
  await expect(diffRegion(page)).toHaveCount(0);
  await expect(page.getByText('输入编码尚未确认，逻辑对比暂不可用。请核对原文并手动选择输入编码。', { exact: true })).toBeVisible();
  const first = await downloadReport(page);
  expect(first.report.visualComparison).toMatchObject({ kind: 'unavailable', reason: 'uncertain-encoding' });
  await page.locator('.export-options > summary').click();
  await page.getByLabel('输入文件编码', { exact: true }).selectOption('utf-8');
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await run(page);
  await expect(diffRegion(page)).toBeVisible();
  const confirmed = await downloadReport(page);
  expect(confirmed.report.visualComparison).toMatchObject({ kind: 'aligned', summary: { textChanged: 1, timeChanged: 0 } });
  await expectSummaryMatchesReport(page, confirmed.report.visualComparison.summary!);
});
