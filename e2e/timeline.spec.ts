import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseSubtitle } from '../src/core/parser';
import { parseTimestamp } from '../src/core/time';

const fixture = [
  ['00:00:02,000', '00:00:04,000', '第一行\r\n原文 🙂'],
  ['00:00:05,000', '00:00:06,200', '第二条'],
  ['00:00:06,000', '00:00:09,000', '第三条'],
].map(([start, end, text], i) => `${i + 1}\r\n${start} --> ${end}\r\n${text}\r\n`).join('\r\n');

async function openSubtitle(page: Page, data = fixture, name = '样例 #🙂.srt') {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开字幕' }).click();
  await (await picker).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(data) });
}

async function drag(page: Page, target: Locator, delta: number, cancel = false) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 12 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/timeline');
  await expect(page.getByRole('heading', { name: '字幕时间轴' })).toBeVisible();
});

test('pointer move and trims, list linkage, one-step undo, and exact exported text', async ({ page }, info) => {
  await openSubtitle(page, '\ufeff' + fixture);
  const viewport = page.getByLabel('可滚动字幕时间轴');
  const start = page.getByLabel('开始时间');
  const end = page.getByLabel('结束时间');
  await expect(start).toHaveValue('00:00:02.000');
  const scale = await viewport.evaluate(element => element.clientWidth / 10);
  const block = page.getByRole('button', { name: '字幕 1', exact: true });
  await drag(page, block, scale / 2);
  await expect(start).not.toHaveValue('00:00:02.000');
  const movedStart = parseTimestamp(await start.inputValue());
  expect(movedStart).toBeGreaterThan(2400);
  expect(parseTimestamp(await end.inputValue()) - movedStart).toBe(2000);
  await page.keyboard.press('Control+z');
  await expect(start).toHaveValue('00:00:02.000');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+y');
  await expect.poll(async () => parseTimestamp(await start.inputValue())).toBe(movedStart);

  await drag(page, page.getByRole('button', { name: '调整字幕 1 入点' }), scale / 4);
  const trimmedStart = parseTimestamp(await start.inputValue());
  expect(trimmedStart).toBeGreaterThan(movedStart);
  await drag(page, page.getByRole('button', { name: '调整字幕 1 出点' }), -scale / 4);
  const trimmedEnd = parseTimestamp(await end.inputValue());
  expect(trimmedEnd).toBeLessThan(movedStart + 2000);
  await drag(page, block, scale, true);
  expect(parseTimestamp(await start.inputValue())).toBe(trimmedStart);
  expect(parseTimestamp(await end.inputValue())).toBe(trimmedEnd);
  await page.getByRole('button', { name: '放大时间轴' }).click();
  await viewport.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.getByRole('button', { name: '拟合全部' }).click();
  expect(parseTimestamp(await start.inputValue())).toBe(trimmedStart);
  expect(parseTimestamp(await end.inputValue())).toBe(trimmedEnd);

  await page.getByRole('button', { name: '字幕 2', exact: true }).click();
  await expect(page.getByRole('button', { name: '列表字幕 2' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '列表字幕 1' }).click();
  await expect(block).toHaveAttribute('aria-pressed', 'true');
  await start.fill('错误');
  await page.getByRole('button', { name: '应用编辑' }).click();
  await expect(page.getByRole('alert')).toContainText('无法识别时间');
  await page.keyboard.press('Escape');
  expect(parseTimestamp(await start.inputValue())).toBe(trimmedStart);
  await start.fill('00:00:02.753');
  await page.getByLabel('字幕正文').fill('已编辑\n第二行 🐱');
  await page.getByRole('button', { name: '应用编辑' }).click();
  await page.getByRole('button', { name: '列表字幕 2' }).click();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('button', { name: '列表字幕 3' })).toHaveCount(0);
  await page.getByRole('button', { name: '插入字幕' }).click();
  await expect(start).toHaveValue('00:00:09.000');
  await page.getByLabel('字幕正文').fill('插入');
  await page.getByRole('button', { name: '应用编辑' }).click();
  await page.getByRole('button', { name: '与上次保存对比' }).click();
  await expect(page.getByLabel('字幕差异预览')).toBeVisible();
  await info.attach('timeline-workspace.png', { body: await page.screenshot(), contentType: 'image/png' });

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('样例 #🙂_timed.srt');
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  expect(text).toContain('已编辑\r\n第二行 🐱');
  const parsed = parseSubtitle(text, 'saved.srt');
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.document.cues.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([
    [2753, trimmedEnd, '已编辑\n第二行 🐱'],
    [6000, 9000, '第三条'],
    [9000, 11000, '插入'],
  ]);
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
});

test('multi-select shifts preserve gaps and reject out-of-bounds without partial edits', async ({ page }) => {
  await openSubtitle(page);
  await expect(page.getByText('2 条重叠 · 0 个错误')).toBeVisible();
  await page.getByRole('button', { name: '列表字幕 2' }).click({ modifiers: ['Control'] });
  await expect(page.getByText('已选 2 条')).toBeVisible();
  const viewport = page.getByLabel('可滚动字幕时间轴');
  const scale = await viewport.evaluate(element => element.clientWidth / 10);
  await drag(page, page.getByRole('button', { name: '字幕 1', exact: true }), -scale * 2.3);
  await expect(page.getByRole('alert')).toContainText('不能小于 0');
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
  await drag(page, page.getByRole('button', { name: '字幕 1', exact: true }), scale / 2);
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '列表字幕 1' }).click();
  const first = parseTimestamp(await page.getByLabel('开始时间').inputValue());
  await page.getByRole('button', { name: '列表字幕 2' }).click();
  const second = parseTimestamp(await page.getByLabel('开始时间').inputValue());
  expect(second - first).toBe(3000);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('开始时间')).toHaveValue('00:00:05.000');
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
});

test('guard saves before navigation and keeps an invalid or discarded draft until a replacement succeeds', async ({ page }) => {
  await openSubtitle(page);
  await expect(page.getByLabel('字幕正文')).toHaveValue('第一行\n原文 🙂');
  await page.getByLabel('字幕正文').fill('临时修改');
  await page.getByRole('link', { name: '首页' }).click();
  const prompt = page.getByRole('dialog', { name: '有未保存修改' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('临时修改');
  await page.getByRole('button', { name: '打开字幕' }).click();
  const picker = page.waitForEvent('filechooser');
  await prompt.getByRole('button', { name: '放弃修改' }).click();
  await (await picker).setFiles({ name: 'styles.ass', mimeType: 'text/plain', buffer: Buffer.from('[Script Info]') });
  await expect(page.getByRole('alert')).toContainText('时间轴一次编辑一份 SRT');
  await expect(page.getByLabel('字幕正文')).toHaveValue('临时修改');
  await page.getByRole('link', { name: '首页' }).click();
  const download = page.waitForEvent('download');
  await prompt.getByRole('button', { name: '保存并继续' }).click();
  expect((await readFile((await (await download).path())!, 'utf8')).includes('临时修改')).toBe(true);
  await expect(page).toHaveURL(/#\/$/u);
  await expect(page.getByRole('heading', { name: '让字幕处理，简单一点。' })).toBeVisible();
});

test('malformed SRT is inspectable but cannot export, recoverable timings and empty files can be edited', async ({ page }) => {
  await openSubtitle(page, '游离\n' + fixture);
  await expect(page.getByText(/无法恢复的 SRT 结构/u)).toBeVisible();
  await expect(page.getByRole('button', { name: '另存为' })).toBeDisabled();
  await page.getByRole('button', { name: /保存前检查/u }).click();
  await expect(page.getByLabel('字幕诊断')).toContainText('ORPHAN_CONTENT');
  await openSubtitle(page, '1\n00:00:02,000 --> 00:00:01,000\n需要校时\n');
  await expect(page.getByLabel('字幕正文')).toHaveValue('需要校时');
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByRole('alert')).toContainText('结束时间必须晚于开始时间');
  await page.getByLabel('结束时间').fill('00:00:04.000');
  await page.getByRole('button', { name: '应用编辑' }).click();
  await expect(page.getByText('0 条重叠 · 0 个错误')).toBeVisible();
  await page.getByRole('button', { name: '打开字幕' }).click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '放弃修改' }).click();
  await (await picker).setFiles({ name: 'empty.srt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(page.getByText('没有字幕，可以插入一条。')).toBeVisible();
  await page.getByRole('button', { name: '插入字幕' }).click();
  await expect(page.getByLabel('开始时间')).toHaveValue('00:00:00.000');
});

test('fixed viewport keeps the list and fitted/zoomed timeline bounded at 500, 5000 and 10000 cues', async ({ page }, info) => {
  const readings = [];
  await page.setViewportSize({ width: 900, height: 620 });
  for (const count of [500, 5000, 10000]) {
    const srt = Array.from({ length: count }, (_, i) => {
      const format = (s: number) => new Date(s * 1000).toISOString().slice(11, 23).replace('.', ',');
      return `${i + 1}\n${format(i * 2)} --> ${format(i * 2 + 1)}\n字幕 ${i + 1}\n`;
    }).join('\n');
    const t0 = performance.now();
    await openSubtitle(page, srt, `perf-${count}.srt`);
    await expect(page.getByText(`${count} 条 · SRT · UTF-8 · LF`)).toBeVisible();
    const openMs = performance.now() - t0;
    const viewport = page.getByLabel('可滚动字幕时间轴');
    const fitted = await viewport.locator('.timeline-cue').count();
    expect(fitted).toBeLessThan(60);
    const t1 = performance.now();
    const zoom = page.getByRole('button', { name: '放大时间轴' });
    await zoom.click();
    await zoom.click();
    await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth / 2; });
    await viewport.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const zoomAndScrollMs = performance.now() - t1;
    const zoomed = await viewport.locator('.timeline-cue').count();
    expect(zoomed).toBeLessThan(60);
    const listRows = await page.getByLabel('字幕列表', { exact: true }).getByRole('button').count();
    expect(listRows).toBeLessThan(15);
    const t2 = performance.now();
    const block = viewport.locator('.timeline-cue-body').nth(2);
    await drag(page, block, 30);
    await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
    const dragMs = performance.now() - t2;
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
    const session = await page.context().newCDPSession(page);
    const { usedSize } = await session.send('Runtime.getHeapUsage');
    await session.detach();
    readings.push({ count, openMs, zoomAndScrollMs, dragMs, fitted, zoomed, listRows, usedJsBytes: usedSize });
  }
  await info.attach('timeline-viewport-metrics.json', { body: JSON.stringify(readings, null, 2), contentType: 'application/json' });
  console.log('Timeline UI measurements', JSON.stringify(readings));
});
