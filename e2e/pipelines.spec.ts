import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const source = '9\n00:00:01,000 --> 00:00:02,000\n  错词   中文 😀  \n\n12\n00:00:03,000 --> 00:00:04,000\n\u200b\n\n14\n00:00:05,000 --> 00:00:06,000\n  另一行  \n';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function workflow(page: Page) { await page.goto('/#/batch'); await button(page, '处理流程').click(); }
async function addStep(page: Page, operation: string) { await page.getByLabel('添加步骤类型', { exact: true }).selectOption(operation); await button(page, '添加处理步骤').click(); }
async function inputs(page: Page, names = ['第一份.srt', '第二份.srt'], text = source) {
  const choose = page.waitForEvent('filechooser'); await button(page, '选择文件').click();
  await (await choose).setFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })));
}
async function download(page: Page, name: string) {
  const pending = page.waitForEvent('download'); await button(page, name).click();
  const output = await pending; const stream = await output.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), name: output.suggestedFilename() };
}
async function standard(page: Page) {
  for (const operation of ['remove-empty', 'clean-spaces', 'replace', 'shift']) await addStep(page, operation);
  await page.getByLabel('查找内容', { exact: true }).fill('错词'); await page.getByLabel('替换为', { exact: true }).fill('正确');
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('500');
}
async function saveFlow(page: Page, name: string) {
  await page.getByLabel('流程名称', { exact: true }).fill(name); await button(page, '保存流程').click();
  await page.getByRole('dialog').getByRole('button', { name: '确认保存流程', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('two real SRT inputs run one four-step workflow, preview and execution export identical bytes in a ZIP', async ({ page }) => {
  await workflow(page); await standard(page); await inputs(page);
  await expect(page.locator('.workflow-analysis')).toContainText('适用 2');
  await button(page, '预览影响').click(); await expect(page.locator('.task-row .success')).toHaveCount(2);
  await expect(page.getByLabel('每一步实际变化摘要').locator('li')).toHaveCount(4);
  await expect(page.getByLabel('字幕差异预览')).toBeVisible();
  const preview = await JSZip.loadAsync((await download(page, '导出 ZIP')).bytes);
  const expected = '1\r\n00:00:01,500 --> 00:00:02,500\r\n正确 中文 😀\r\n\r\n2\r\n00:00:05,500 --> 00:00:06,500\r\n另一行\r\n';
  for (const name of ['第一份_processed.srt', '第二份_processed.srt']) expect(await preview.file(name)!.async('string')).toBe(expected);
  await button(page, '开始处理').click(); await expect(page.locator('.task-row .success')).toHaveCount(2);
  const executed = await JSZip.loadAsync((await download(page, '导出 ZIP')).bytes);
  for (const name of Object.keys(preview.files)) expect(await executed.file(name)!.async('nodebuffer')).toEqual(await preview.file(name)!.async('nodebuffer'));
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('501');
  await expect(page.locator('.results-panel')).toHaveCount(0); await expect(button(page, '导出 ZIP')).toHaveCount(0);
});

test('step reordering, disabling, deletion and mode switching preserve the draft and invalidate old output', async ({ page }) => {
  await workflow(page); await addStep(page, 'replace'); await addStep(page, 'clean-spaces');
  await page.getByLabel('查找内容', { exact: true }).fill('错词   中文'); await page.getByLabel('替换为', { exact: true }).fill('命中');
  await inputs(page, ['顺序.srt'], '1\n00:00:01,000 --> 00:00:02,000\n错词   中文\n');
  await button(page, '预览影响').click(); await expect(page.locator('.task-row .success')).toHaveCount(1);
  expect((await download(page, '另存为')).bytes.toString('utf8')).toContain('命中');
  const move = page.getByRole('button', { name: '上移步骤 2 空格清理', exact: true }); await move.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.results-panel')).toHaveCount(0); await expect(page.locator('.workflow-step').first()).toContainText('空格清理');
  await button(page, '开始处理').click(); await expect(page.locator('.task-row .success')).toHaveCount(1);
  expect((await download(page, '另存为')).bytes.toString('utf8')).toContain('错词 中文');
  await page.locator('.workflow-step').first().getByRole('checkbox', { name: '启用', exact: true }).uncheck();
  await button(page, '开始处理').click(); await expect(page.locator('.task-row .success')).toHaveCount(1); await expect(page.getByLabel('每一步实际变化摘要')).toContainText('已跳过');
  expect((await download(page, '另存为')).bytes.toString('utf8')).toContain('命中');
  await button(page, '单项处理').click(); await button(page, '处理流程').click(); await expect(page.locator('.workflow-step')).toHaveCount(2); await expect(page.getByLabel('查找内容', { exact: true })).toHaveValue('错词   中文');
  await page.getByRole('button', { name: '移除步骤 1 空格清理', exact: true }).click(); await expect(page.locator('.workflow-step')).toHaveCount(1);
});

test('workflow CRUD, restart restoration and failed save preserve configuration without storing subtitles or paths', async ({ page }) => {
  await workflow(page); await standard(page); await saveFlow(page, '标准清理');
  await page.reload(); await button(page, '处理流程').click(); await page.getByLabel('已保存流程', { exact: true }).selectOption({ label: '标准清理' }); await button(page, '应用流程').click();
  await expect(page.locator('.workflow-step')).toHaveCount(4); await expect(page.getByLabel('偏移量（毫秒）', { exact: true })).toHaveValue('500');
  await button(page, '复制流程').click(); await page.getByRole('dialog').getByLabel('保存名称', { exact: true }).fill('清理副本'); await page.getByRole('dialog').getByRole('button', { name: '确认保存流程', exact: true }).click();
  await button(page, '重命名流程').click(); await page.getByRole('dialog').getByLabel('保存名称', { exact: true }).fill('副本改名'); await page.getByRole('dialog').getByRole('button', { name: '确认保存流程', exact: true }).click();
  await expect(page.getByLabel('已保存流程', { exact: true })).toHaveValue(/./u);
  await button(page, '删除流程').click(); await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await expect(page.getByLabel('已保存流程', { exact: true }).locator('option')).toHaveText(['选择流程', '副本改名', '标准清理']);
  await button(page, '删除流程').click(); await page.getByRole('dialog').getByRole('button', { name: '确认删除流程', exact: true }).click();
  await expect(page.locator('.workflow-step')).toHaveCount(4);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'subtitle-tools:workflow-presets-v1') throw new DOMException('full', 'QuotaExceededError'); original.call(this, key, value); }; });
  await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('777'); await button(page, '保存流程').click(); await page.getByRole('dialog').getByLabel('保存名称', { exact: true }).fill('保存失败保留'); await page.getByRole('dialog').getByRole('button', { name: '确认保存流程', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await expect(page.getByLabel('偏移量（毫秒）', { exact: true })).toHaveValue('777');
  const stored = await page.evaluate(() => localStorage.getItem('subtitle-tools:workflow-presets-v1'));
  expect(stored).toContain('标准清理'); expect(stored).not.toContain('保存失败保留'); expect(stored).not.toContain('outputEncoding'); expect(stored).not.toContain('sourcePath');
});

test('tool preset snapshot, explicit privacy export and conflict preview import retain old settings and source queue', async ({ page }) => {
  await page.goto('/#/tools/shift'); await page.getByLabel('偏移量（毫秒）', { exact: true }).fill('500'); await button(page, '保存为新预设').click(); await page.getByRole('dialog').getByLabel('预设名称', { exact: true }).fill('旧工具预设'); await page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click();
  await workflow(page); await addStep(page, 'shift'); await page.getByLabel('参数预设', { exact: true }).selectOption({ label: '旧工具预设' }); await button(page, '应用预设').click(); await expect(page.getByLabel('偏移量（毫秒）', { exact: true })).toHaveValue('500'); await saveFlow(page, '快照流程');
  await button(page, '导出预设 JSON').click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '全选工具预设', exact: true }).click(); await dialog.getByRole('button', { name: '全选流程预设', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导出所选预设', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('个人文字参数');
  await dialog.getByRole('checkbox', { name: '我已了解个人输入参数会随 JSON 分享', exact: true }).check(); const exported = await download(page, '确认导出所选预设'); expect(exported.name).toBe('SRTTools-Presets.json');
  const json = JSON.parse(exported.bytes.toString('utf8')) as { format: string; items: Array<{ kind: string }> }; expect(json.format).toBe('srttools-presets'); expect(json.items.map(item => item.kind).sort()).toEqual(['tool', 'workflow']);
  await inputs(page, ['源文件.srt']); const before = await page.evaluate(() => ({ settings: localStorage.getItem('subtitle-tools:settings'), tool: localStorage.getItem('subtitle-tools:tool-presets-v1'), workflow: localStorage.getItem('subtitle-tools:workflow-presets-v1') }));
  const choosing = page.waitForEvent('filechooser'); await button(page, '导入预设 JSON').click(); await (await choosing).setFiles({ name: 'share.json', mimeType: 'application/json', buffer: exported.bytes });
  await expect(page.getByRole('dialog')).toContainText('冲突 2 项'); await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => ({ settings: localStorage.getItem('subtitle-tools:settings'), tool: localStorage.getItem('subtitle-tools:tool-presets-v1'), workflow: localStorage.getItem('subtitle-tools:workflow-presets-v1') }))).toEqual(before);
  const second = page.waitForEvent('filechooser'); await button(page, '导入预设 JSON').click(); await (await second).setFiles({ name: 'share.json', mimeType: 'application/json', buffer: exported.bytes });
  await page.getByLabel('同名冲突策略', { exact: true }).selectOption('rename'); await expect(page.getByRole('dialog')).toContainText('将导入 2 项'); await page.getByRole('dialog').getByRole('button', { name: '确认导入预设', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('已保存流程', { exact: true }).locator('option')).toHaveText(['选择流程', '快照流程 (2)', '快照流程']); await expect(page.locator('.file-row')).toHaveCount(1);
  const bad = page.waitForEvent('filechooser'); await button(page, '导入预设 JSON').click(); await (await bad).setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from([0xff, 0xfe, 0]) }); await expect(page.locator('.preset-exchange > [role="alert"]')).toContainText('UTF-8'); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('layout-sensitive workflows require consent, pure Chinese retains VTT settings and malformed inputs remain isolated', async ({ page }) => {
  await workflow(page); await addStep(page, 'clean-spaces'); await inputs(page, ['带设置.vtt'], 'WEBVTT\n\ncue\n00:00:01.000 --> 00:00:02.000 align:start\n  简体中文  \n');
  await expect(button(page, '预览影响')).toBeDisabled(); await page.locator('.workflow-applicability > summary').click(); await expect(page.locator('.workflow-applicability')).toContainText('明确同意');
  await page.getByRole('checkbox', { name: /^允许 ASS/u }).click(); await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await expect(button(page, '预览影响')).toBeDisabled();
  await page.getByRole('checkbox', { name: /^允许 ASS/u }).click(); await page.getByRole('dialog').getByRole('button', { name: '同意规范化为 SRT', exact: true }).click(); await button(page, '预览影响').click(); await expect(page.locator('.task-row .success')).toHaveCount(1); expect((await download(page, '另存为')).name).toBe('带设置_processed.srt');
  await button(page, '新建流程').click(); await addStep(page, 'chinese'); await button(page, '开始处理').click(); await expect(page.locator('.task-row .success')).toHaveCount(1); const vtt = await download(page, '另存为'); expect(vtt.name).toBe('带设置_processed.vtt'); expect(vtt.bytes.toString('utf8')).toContain('align:start\n  簡體中文  ');
  await inputs(page, ['错误.srt'], '1\n错误时间\n不得丢失正文\n'); await button(page, '开始处理').click(); await expect(page.locator('.task-row .success')).toHaveCount(1); await expect(page.locator('.task-row .failed')).toHaveCount(1);
});

test('twenty-step limit and invalid regular expression are visible before execution and cancelled worker can retry', async ({ page }) => {
  await page.addInitScript(() => { const original = Worker.prototype.postMessage; let held = false; Worker.prototype.postMessage = function(message: unknown) { if (!held) { held = true; return; } return original.call(this, message); }; });
  await workflow(page); for (let index = 0; index < 20; index++) await addStep(page, 'clean-spaces'); await expect(button(page, '添加处理步骤')).toBeDisabled();
  for (let index = 20; index > 0; index--) await page.getByRole('button', { name: `移除步骤 ${index} 空格清理`, exact: true }).click();
  await addStep(page, 'replace'); await page.getByLabel('查找内容', { exact: true }).fill('('); await page.getByRole('checkbox', { name: '使用正则表达式（高级）', exact: true }).check(); await inputs(page, ['取消.srt']); await expect(button(page, '开始处理')).toBeDisabled();
  await page.getByRole('checkbox', { name: '使用正则表达式（高级）', exact: true }).uncheck(); await page.getByLabel('查找内容', { exact: true }).fill('错词'); await button(page, '开始处理').click(); await expect(button(page, '处理流程')).toBeDisabled(); await button(page, '取消处理').click(); await expect(page.locator('.task-row .cancelled')).toHaveCount(1); await expect(button(page, '导出 ZIP')).toHaveCount(0);
  await button(page, '重试未完成项').click(); await expect(page.locator('.task-row .success')).toHaveCount(1); await expect(button(page, '导出 ZIP')).toBeEnabled();
});

for (const viewport of [{ width: 900, height: 620 }, { width: 1200, height: 800 }]) {
  for (const theme of ['light', 'dark']) {
    test(`workflow editor remains keyboard operable and contained at ${viewport.width}×${viewport.height} in ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(selected => { localStorage.setItem('subtitle-tools:settings', JSON.stringify({ theme: selected })); }, theme);
      await workflow(page); await standard(page); await inputs(page, ['界面验证.srt']); await button(page, '预览影响').click(); await expect(page.locator('.task-row .success')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('.main-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.getByRole('button', { name: '上移步骤 4 整体时间偏移', exact: true }).focus(); await expect(page.getByRole('button', { name: '上移步骤 4 整体时间偏移', exact: true })).toBeFocused();
      await page.locator('.workflow-step').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `src-tauri/target/v040-workflow-${viewport.width}-${theme}.png` });
    });
  }
}
