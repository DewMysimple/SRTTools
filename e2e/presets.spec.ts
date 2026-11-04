import { expect, test, type Page } from '@playwright/test';

const key = 'subtitle-tools:tool-presets-v1';
const replace = '/#/tools/replace';
const find = (page: Page) => page.getByRole('textbox', { name: '查找内容', exact: true });
const replacement = (page: Page) => page.getByRole('textbox', { name: '替换为', exact: true });
const presets = (page: Page) => page.getByRole('combobox', { name: '参数预设', exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const dialog = (page: Page) => page.getByRole('dialog');

async function openSave(page: Page, name: string) {
  await button(page, '保存为新预设').click();
  await dialog(page).getByRole('textbox', { name: '预设名称' }).fill(name);
}

async function save(page: Page, name: string) {
  await openSave(page, name);
  await dialog(page).getByRole('button', { name: '确认保存' }).click();
  await expect(dialog(page)).toHaveCount(0);
}

async function apply(page: Page, name: string) {
  await presets(page).selectOption({ label: name });
  await button(page, '应用预设').click();
}

async function addSubtitle(page: Page) {
  const picker = page.waitForEvent('filechooser');
  await button(page, '选择文件').click();
  await (await picker).setFiles({
    name: '预设测试.srt', mimeType: 'text/plain',
    buffer: Buffer.from('1\n00:00:01,234 --> 00:00:02,345\n我觉的这个方案可行。\n'),
  });
}

test('named presets survive a reload and do not persist unsaved input or affect another tool', async ({ page }) => {
  await page.goto(replace);
  await find(page).fill('觉的');
  await replacement(page).fill('觉得');
  await page.getByRole('checkbox', { name: '区分大小写' }).check();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await save(page, '常用替换');

  await page.reload();
  await expect(find(page)).toHaveValue('');
  await apply(page, '常用替换');
  await expect(find(page)).toHaveValue('觉的');
  await expect(replacement(page)).toHaveValue('觉得');
  await expect(page.getByRole('checkbox', { name: '区分大小写' })).toBeChecked();
  await replacement(page).fill('只改表单');
  await expect(page.getByText('已修改', { exact: true })).toBeVisible();
  await apply(page, '常用替换');
  await expect(replacement(page)).toHaveValue('觉得');

  await page.goto('/#/tools/shift');
  await expect(presets(page).getByRole('option', { name: '常用替换' })).toHaveCount(0);
  await page.getByLabel('偏移量（毫秒）').fill('321');
  await page.getByLabel('偏移后出现无效时间').selectOption('drop');
  await save(page, '常用替换');
  await button(page, '重置').click();
  await expect(page.getByLabel('偏移量（毫秒）')).toHaveValue('1000');
  await apply(page, '常用替换');
  await expect(page.getByLabel('偏移量（毫秒）')).toHaveValue('321');
  await expect(page.getByLabel('偏移后出现无效时间')).toHaveValue('drop');
  await page.goto('/#/tools/renumber');
  await expect(presets(page)).toHaveCount(0);
  await expect(button(page, '保存为新预设')).toHaveCount(0);
});

test('applying a preset clears stale preview and export until the user processes again', async ({ page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown) {
      window.addEventListener('release-preset-test-worker', () => post.call(this, message), { once: true });
    };
  });
  await page.goto(replace);
  await addSubtitle(page);
  await find(page).fill('觉的');
  await replacement(page).fill('确信');
  await save(page, 'B 方案');
  await replacement(page).fill('觉得');
  await button(page, '预览处理结果').click();
  await expect(button(page, '取消处理')).toBeVisible();
  await expect(button(page, '应用预设')).toBeDisabled();
  await expect(button(page, '保存为新预设')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-preset-test-worker')));
  await expect(page.locator('.diff-summary')).toContainText('正文变更 1');
  await expect(button(page, '另存为')).toBeEnabled();

  await apply(page, 'B 方案');
  await expect(replacement(page)).toHaveValue('确信');
  await expect(page.locator('.results-panel')).toHaveCount(0);
  await expect(button(page, '另存为')).toHaveCount(0);
  await button(page, '预览处理结果').click();
  await expect(button(page, '取消处理')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('release-preset-test-worker')));
  await expect(page.locator('.diff-row').getByText('我确信这个方案可行。', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await button(page, '另存为').click();
  const output = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of output!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toContain('我确信这个方案可行。');
});

test('explicit update, rename and confirmed deletion preserve the current form', async ({ page }) => {
  await page.goto(replace);
  await find(page).fill('原参数');
  await save(page, '方案一');
  await replacement(page).fill('新参数');
  await button(page, '管理预设').click();
  await button(page, '更新预设').click();
  await dialog(page).getByRole('button', { name: '确认更新' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await button(page, '重命名预设').click();
  await dialog(page).getByRole('textbox', { name: '预设名称' }).fill('新方案');
  await dialog(page).getByRole('button', { name: '确认重命名' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await apply(page, '新方案');
  await expect(replacement(page)).toHaveValue('新参数');
  await button(page, '删除预设').click();
  await dialog(page).getByRole('button', { name: '取消' }).click();
  await expect(presets(page).getByRole('option', { name: '新方案' })).toHaveCount(1);
  await button(page, '删除预设').click();
  await dialog(page).getByRole('button', { name: '确认删除' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(presets(page).getByRole('option', { name: '新方案' })).toHaveCount(0);
  await expect(replacement(page)).toHaveValue('新参数');
});

test('invalid names and failed storage keep the form and existing presets', async ({ page }) => {
  await page.goto(replace);
  await find(page).fill('保留表单');
  await save(page, '已有预设');
  await openSave(page, ' ');
  await dialog(page).getByRole('button', { name: '确认保存' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('名称');
  await dialog(page).getByRole('textbox', { name: '预设名称' }).fill('写入失败');
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error('test quota');
      setItem.call(this, name, value);
    };
  }, key);
  await dialog(page).getByRole('button', { name: '确认保存' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('保存');
  await dialog(page).getByRole('button', { name: '取消' }).click();
  await expect(find(page)).toHaveValue('保留表单');
  await expect(presets(page).getByRole('option', { name: '已有预设' })).toHaveCount(1);
  await expect(presets(page).getByRole('option', { name: '写入失败' })).toHaveCount(0);
});

test('corrupt preset storage can be reset explicitly without resetting settings', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, '{bad json');
    localStorage.setItem('subtitle-tools:settings', JSON.stringify({ theme: 'dark' }));
  }, key);
  await page.goto(replace);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('alert').filter({ hasText: '预设' })).toContainText('损坏');
  await find(page).fill('保留此参数');
  await button(page, '清理损坏预设').click();
  await dialog(page).getByRole('button', { name: '确认清理' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(find(page)).toHaveValue('保留此参数');
  await save(page, '恢复后保存');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('subtitle-tools:settings')!).theme)).toBe('dark');
});
