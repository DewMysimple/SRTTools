import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { formatTimestamp } from '../src/core/time';

const fixture = '1\r\n00:00:01,000 --> 00:00:03,000\r\n前 🐱\r\n后 é\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n第二条\r\n';

async function open(page: Page, text = fixture) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开字幕', exact: true }).click();
  await (await picker).setFiles({ name: '精准样本.srt', mimeType: 'text/plain', buffer: Buffer.from(text) });
}

async function jump(page: Page, time: string) {
  await page.getByLabel('跳转到时间', { exact: true }).fill(time);
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('时间轴光标时间')).toHaveText(time);
}

async function anchors(page: Page, values: readonly string[]) {
  for (const [i, label] of ['字幕锚点 1', '目标锚点 1', '字幕锚点 2', '目标锚点 2'].entries()) {
    await page.getByLabel(label, { exact: true }).fill(values[i]);
  }
}

test('timeline playhead endpoints, overlap reasons, keyboard/IME and ordered navigation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto('/#/timeline');
  await open(page);
  const start = page.getByLabel('开始时间', { exact: true });
  const end = page.getByLabel('结束时间', { exact: true });
  const setStart = page.getByRole('button', { name: '将当前时间设为开始' });
  const setEnd = page.getByRole('button', { name: '将当前时间设为结束' });
  await expect(page.getByText(/取时来源为时间轴当前位置/)).toBeVisible();
  await expect(page.getByRole('button', { name: '预览选中字幕' })).toBeDisabled();
  await jump(page, '00:00:02.725');
  await setStart.click();
  await expect(start).toHaveValue('00:00:02.725');
  await expect(end).toHaveValue('00:00:03.000');
  await jump(page, '00:00:04.600');
  await setStart.click();
  await expect(page.getByRole('alert')).toContainText('结束时间必须晚于开始时间');
  await expect(start).toHaveValue('00:00:02.725');
  await setEnd.click();
  await expect(end).toHaveValue('00:00:04.600');
  await expect(page.getByText(/本次新增重叠 1 处/)).toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(end).toHaveValue('00:00:03.000');
  await expect(page.getByLabel('时间轴光标时间')).toHaveText('00:00:04.600');

  const search = page.getByLabel('搜索字幕');
  await search.fill('前');
  await search.press('Alt+ArrowDown');
  await expect(start).toHaveValue('00:00:02.725');
  const next = page.getByRole('button', { name: '下一条', exact: true });
  await next.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowDown', code: 'ArrowDown', altKey: true, isComposing: true, bubbles: true,
  })));
  await expect(start).toHaveValue('00:00:02.725');
  await next.press('Alt+ArrowDown');
  await expect(page.getByRole('button', { name: '列表字幕 2' })).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: '上一条', exact: true }).click();
  await expect(start).toHaveValue('00:00:02.725');
  await page.getByRole('button', { name: '定位当前或最近字幕' }).click();
  await expect(start).toHaveValue('00:00:04.000');
  await expect(page.getByLabel('时间轴光标时间')).toHaveText('00:00:04.600');
  await page.getByRole('button', { name: '列表字幕 1' }).click({ modifiers: ['Control'] });
  await expect(setStart).toBeDisabled();
  await expect(setEnd).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
});

test('split previews Unicode body, preserves cancelled edits and undoes as one transaction', async ({ page }) => {
  await page.goto('/#/timeline');
  await open(page);
  const original = page.getByRole('textbox', { name: '字幕正文', exact: true });
  const split = page.getByRole('button', { name: '拆分字幕', exact: true });
  await jump(page, '00:00:01.000');
  await split.click();
  await expect(page.getByRole('alert')).toContainText('严格位于');
  await jump(page, '00:00:02.000');
  await original.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(field.value.indexOf('\n'), field.value.indexOf('\n'));
  });
  await split.click();
  const dialog = page.getByRole('dialog', { name: '拆分字幕预览' });
  const left = dialog.getByLabel('前半段正文');
  const right = dialog.getByLabel('后半段正文');
  await expect(left).toHaveValue('前 🐱');
  await expect(right).toHaveValue('后 é');
  await right.fill('保留 后 é');
  await page.keyboard.press('Escape');
  await expect(original).toHaveValue('前 🐱\n后 é');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await split.click();
  await expect(right).toHaveValue('保留 后 é');
  await dialog.getByRole('button', { name: '确认拆分' }).click();
  await expect(page.getByRole('button', { name: '列表字幕 2' })).toHaveAttribute('aria-pressed', 'true');
  await expect(original).toHaveValue('保留 后 é');
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:02.000');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '列表字幕 1' }).click();
  await expect(original).toHaveValue('前 🐱\n后 é');
  await expect(page.getByRole('button', { name: '列表字幕 3' })).toHaveCount(0);
});

test('two anchors report scoped conflicts, reject invalid output, and invalidate previews on editing', async ({ page }) => {
  await page.goto('/#/timeline');
  await open(page);
  await page.getByRole('button', { name: '两点校准', exact: true }).click();
  const calculate = page.getByRole('button', { name: '计算校准预览' });
  const apply = page.getByRole('button', { name: '应用两点校准' });
  await page.getByRole('button', { name: '记录字幕起点 1' }).click();
  await expect(page.getByLabel('字幕锚点 1')).toHaveValue('00:00:01.000');
  await jump(page, '00:00:02.000');
  await page.getByRole('button', { name: '记录时间轴游标 1' }).click();
  await expect(page.getByLabel('目标锚点 1')).toHaveValue('00:00:02.000');
  await anchors(page, ['2000', '0', '12000', '10000']);
  await calculate.click();
  await expect(page.getByText(/无效 1 条/)).toBeVisible();
  await expect(apply).toBeDisabled();
  await anchors(page, ['0', '0', '10000', '20000']);
  await calculate.click();
  await expect(page.getByText(/倍率超出 0.8–1.2/)).toBeVisible();
  await expect(apply).toBeDisabled();
  await page.getByRole('checkbox', { name: '确认使用此倍率' }).check();
  await expect(apply).toBeEnabled();
  await anchors(page, ['1000', '2500', '11000', '12500']);
  await page.getByLabel('作用范围').selectOption('selected');
  await calculate.click();
  await expect(page.getByText(/本次新增重叠 1 对/)).toBeVisible();
  await page.getByRole('button', { name: '查看校准差异' }).click();
  await expect(page.getByRole('region', { name: '字幕差异预览' })).toContainText('时间变更');
  await page.getByRole('textbox', { name: '字幕正文', exact: true }).fill('独立正文事务 🐱');
  await page.getByRole('button', { name: '应用编辑' }).click();
  await expect(page.getByText(/请重新计算校准预览/)).toBeVisible();
  await expect(apply).toHaveCount(0);

  await page.getByLabel('作用范围').selectOption('all');
  await anchors(page, ['0', '0', '00:00:10.000', '10500']);
  await calculate.click();
  await apply.click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:01.050');
  await expect(calculate).toBeDisabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:01.000');
  await expect(page.getByRole('textbox', { name: '字幕正文', exact: true })).toHaveValue('独立正文事务 🐱');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:01.050');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const body = await readFile((await (await download).path())!, 'utf8');
  expect(body).toBe('1\r\n00:00:01,050 --> 00:00:03,150\r\n独立正文事务 🐱\r\n\r\n2\r\n00:00:04,200 --> 00:00:06,300\r\n第二条\r\n');
});

test('calibrates 10,000 and 50,000 cues with bounded DOM and timing-only worker input', async ({ page }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 900, height: 620 });
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    const observed: { count: number; hasText: boolean }[] = [];
    Reflect.set(window, 'observedCalibration', observed);
    Worker.prototype.postMessage = function (...args: unknown[]) {
      const payload = args[0] as { request?: { kind: string; cues: object[] } };
      if (payload.request?.kind === 'calibration') observed.push({
        count: payload.request.cues.length, hasText: 'text' in payload.request.cues[0],
      });
      return Reflect.apply(send, this, args);
    };
  });
  const readings = [];
  for (const count of [10_000, 50_000]) {
    await page.goto('/?cues=' + count + '#/timeline');
    const srt = Array.from({ length: count }, (_, i) => {
      const start = i * 800 + 100;
      return (i + 1) + '\n' + formatTimestamp(start) + ' --> ' + formatTimestamp(start + 600) + '\n样本 ' + i + ' 🐱\n';
    }).join('\n');
    await open(page, srt);
    const start = page.getByLabel('开始时间', { exact: true });
    await expect(start).toHaveValue('00:00:00.100');
    await page.getByRole('button', { name: '两点校准', exact: true }).click();
    await anchors(page, ['0', '0', '10000', '10500']);
    const now = performance.now();
    await page.getByRole('button', { name: '计算校准预览' }).click();
    await expect(page.getByText('作用 ' + count + ' 条 · 时间变化 ' + count + ' 条 · 无效 0 条')).toBeVisible();
    const previewMs = performance.now() - now;
    const calls = await page.evaluate(() => Reflect.get(window, 'observedCalibration'));
    expect(calls).toEqual(count > 10_000 ? [{ count, hasText: false }] : []);
    await page.getByRole('button', { name: '查看校准差异' }).click();
    const diff = page.getByRole('region', { name: '字幕差异预览' });
    await expect(diff).toContainText('分别分页展示');
    expect(await diff.locator('.cue').count()).toBeLessThanOrEqual(40);
    const applyStarted = performance.now();
    await page.getByRole('button', { name: '应用两点校准' }).click();
    await expect(start).toHaveValue('00:00:00.105');
    const applyMs = performance.now() - applyStarted;
    expect(await page.locator('.timeline-list-item').count()).toBeLessThan(20);
    const usedJsBytes = await page.evaluate(() =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(start).toHaveValue('00:00:00.100');
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    readings.push({ count, previewMs, applyMs, usedJsBytes });
  }
  console.log('Precision timing measurements ' + JSON.stringify(readings));
});
