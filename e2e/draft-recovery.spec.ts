import { expect, test, type Page } from '@playwright/test';

const text = '1\r\n00:00:01,000 --> 00:00:03,000\r\n原稿 🐱\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n第二条\r\n';

async function mockNative(page: Page, enabled = true) {
  await page.addInitScript(({ text, enabled }) => {
    const storage = 'synthetic-recovery-receipts';
    const settingsKey = 'synthetic-settings';
    const commands: string[] = [];
    const bytes = Array.from(new TextEncoder().encode(text));
    const sourceTokens = ['0'.repeat(32), '1'.repeat(32)];
    const state = { pick: 0, fail: false, output: 'ok', cancel: false, exports: [] as number[][] };
    const files = ['C:\\第一组\\源.srt', 'C:\\第二组\\源.srt'];
    type DraftRecord = { draft: { draftId: string; revision: number; fileName: string }; sourcePath: string; savedAtMs: number };
    const read = (): DraftRecord[] => JSON.parse(localStorage.getItem(storage) ?? '[]');
    const write = (records: DraftRecord[]) => localStorage.setItem(storage, JSON.stringify(records));
    Object.assign(window, {
      isTauri: true, recoveryState: state, recoveryCalls: commands,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'take_external_imports') return { files: [], rejected: 0, duplicates: 0 };
          if (command === 'get_local_value') return args.key === 'settings'
            ? JSON.parse(localStorage.getItem(settingsKey) ?? JSON.stringify({ protectTimelineDrafts: enabled })) : null;
          if (command === 'set_local_value' && args.key === 'settings') {
            localStorage.setItem(settingsKey, JSON.stringify(args.value));
            return null;
          }
          if (command === 'get_explorer_integration') return { supported: false, entries: [] };
          if (command === 'select_files') {
            if (state.cancel) return [];
            return [{ name: '源.srt', bytes, size: bytes.length, path: files[state.pick], draftSourceToken: sourceTokens[state.pick] }];
          }
          if (command === 'list_drafts') {
            const records = read();
            return { drafts: records.map(record => ({
              draftId: record.draft.draftId, fileName: record.draft.fileName, sourcePath: record.sourcePath,
              savedAtMs: record.savedAtMs, health: 'ready', bytes: 500,
            })), usedBytes: records.length * 500, budgetBytes: 64 * 1024 * 1024, draftLimit: 20 };
          }
          if (command === 'save_draft') {
            const draft = JSON.parse(String(args.payload));
            commands.push('save-' + draft.revision);
            if (state.fail) throw '模拟文件占用';
            const existing = read().find(record => record.draft.draftId === draft.draftId);
            const record = { draft, sourcePath: existing?.sourcePath ?? files[sourceTokens.indexOf(String(args.sourceToken))], savedAtMs: Date.now() };
            write([...read().filter(record => record.draft.draftId !== draft.draftId), record]);
            return { savedAtMs: record.savedAtMs, bytes: 500, overSoftLimit: false };
          }
          if (command === 'load_draft') {
            const found = read().find(record => record.draft.draftId === args.draftId)!;
            return {
              draft: found.draft, sourceStatus: localStorage.getItem('synthetic-source-status') ?? 'unchanged',
              sourceToken: sourceTokens[files.indexOf(found.sourcePath)], headRevision: found.draft.revision, savedAtMs: found.savedAtMs, health: 'ready',
            };
          }
          if (command === 'discard_draft') {
            commands.push('discard-' + String(args.throughRevision));
            write(read().filter(record => record.draft.draftId !== args.draftId));
            return true;
          }
          if (command === 'prune_drafts') return 0;
          if (command === 'save_output') {
            if (state.output === 'cancel') return null;
            if (state.output === 'error') throw '模拟导出失败';
            state.exports.push(args.bytes as number[]);
            return '源_timed.srt';
          }
          throw new Error('Unexpected IPC: ' + command);
        },
      },
    });
  }, { text, enabled });
}

async function open(page: Page) {
  await page.getByRole('button', { name: '打开字幕', exact: true }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('原稿 🐱');
}

async function edit(page: Page, value: string) {
  await page.getByLabel('字幕正文').fill(value);
  await page.getByRole('button', { name: '应用编辑' }).click();
}

const state = (page: Page, key: string, value: boolean | string | number) =>
  page.evaluate(({ key, value }) => { Reflect.get(window, 'recoveryState')[key] = value; }, { key, value });
const receipts = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('synthetic-recovery-receipts') ?? '[]'));
const manage = (page: Page) => page.getByRole('button', { name: /^本地草稿/ });

test('protects only committed edits, discovers at startup and keeps read-only comparison and later actions separate', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  await page.getByLabel('字幕正文').fill('未提交编辑');
  await page.waitForTimeout(1350);
  expect(await receipts(page)).toHaveLength(0);
  await page.getByRole('button', { name: '应用编辑' }).click();
  await page.getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '重做' }).click();
  await expect(page.getByText(/^草稿已保护/)).toBeVisible();
  const before = await receipts(page);
  expect(before[0].draft.revision).toBe(3);
  await page.goto('/?restart=draft');
  await expect(page.getByText('发现 1 份待处理的本地字幕草稿。')).toBeVisible();
  await page.getByRole('link', { name: '管理本地草稿' }).click();
  await page.getByRole('button', { name: '稍后处理', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '显示稍后处理项' }).click();
  await page.getByRole('button', { name: '查看差异' }).click();
  await expect(page.getByRole('region', { name: '字幕差异预览' })).toContainText('正文变更');
  await expect(page.getByLabel('字幕正文')).toHaveCount(0);
  await page.getByRole('button', { name: '确认恢复到时间轴' }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('未提交编辑');
  await expect(page.getByText('已恢复草稿 · 尚未导出')).toBeVisible();
  expect(await receipts(page)).toEqual(before);
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByText('最近已导出 源_timed.srt')).toBeVisible();
  await expect.poll(() => receipts(page)).toHaveLength(0);
});

test('a drag preview is transient and pointerup creates one recovery revision', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  const cue = page.getByRole('button', { name: '字幕 1', exact: true });
  await cue.scrollIntoViewIfNeeded();
  const box = (await cue.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 6 });
  await page.waitForTimeout(1350);
  expect(await receipts(page)).toHaveLength(0);
  await page.mouse.up();
  await expect(page.getByText(/^草稿已保护/)).toBeVisible();
  const [saved] = await receipts(page);
  expect(saved.draft.revision).toBe(1);
  expect(saved.draft.cues[0].startMs).toBeGreaterThan(1000);
  expect(saved.draft.cues[0].endMs - saved.draft.cues[0].startMs).toBe(2000);
});

test('a failed save is visible and retryable; cancelled or failed exports retain recovery', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  await state(page, 'fail', true);
  await edit(page, '保护失败后重试');
  await expect(page.getByText(/草稿保护失败.*模拟文件占用/)).toBeVisible();
  expect(await receipts(page)).toHaveLength(0);
  await state(page, 'fail', false);
  await page.getByRole('button', { name: '重试草稿保护' }).click();
  await expect(page.getByText(/^草稿已保护/)).toBeVisible();
  await state(page, 'output', 'cancel');
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  expect(await receipts(page)).toHaveLength(1);
  await state(page, 'output', 'error');
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByRole('alert')).toContainText('模拟导出失败');
  expect(await receipts(page)).toHaveLength(1);
  await state(page, 'output', 'ok');
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
  await expect.poll(() => receipts(page)).toHaveLength(0);
});

test('switch flushes the previous file, isolates same names, rechecks a changed source and confirms discard', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  await edit(page, '第一次修改');
  await page.getByRole('button', { name: '打开字幕', exact: true }).click();
  await state(page, 'cancel', true);
  await page.getByRole('button', { name: '放弃修改' }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('第一次修改');
  await state(page, 'cancel', false);
  await state(page, 'pick', 1);
  await page.getByRole('button', { name: '打开字幕', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并继续' }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('原稿 🐱');
  await edit(page, '第二次修改');
  await expect.poll(() => receipts(page)).toHaveLength(2);
  await page.reload();
  await manage(page).click();
  await expect(page.getByRole('article', { name: '源.srt' })).toHaveCount(2);
  const first = page.getByRole('article', { name: '源.srt' }).first();
  await first.getByRole('button', { name: '丢弃草稿' }).click();
  const confirm = page.getByRole('dialog', { name: '永久丢弃本地草稿？' });
  await confirm.getByRole('button', { name: '取消' }).click();
  expect(await receipts(page)).toHaveLength(2);
  await first.getByRole('button', { name: '丢弃草稿' }).click();
  await confirm.getByRole('button', { name: '确认丢弃草稿' }).click();
  await expect(page.getByRole('article', { name: '源.srt' })).toHaveCount(1);
  await page.getByRole('button', { name: '查看差异' }).click();
  await expect(page.getByRole('button', { name: '确认恢复到时间轴' })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('synthetic-source-status', 'changed'));
  await page.getByRole('button', { name: '确认恢复到时间轴' }).click();
  await expect(page.getByText('草稿或来源状态已变化，请核对后再次确认。')).toBeVisible();
  await expect(page.getByLabel('字幕正文')).toHaveCount(0);
  await page.getByRole('button', { name: '独立恢复并另存为' }).click();
  await expect(page.getByLabel('字幕正文')).toHaveValue('第二次修改');
});

test('disabling protection preserves existing recovery without saving new edits', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  await edit(page, '保留的草稿');
  await expect(page.getByText(/^草稿已保护/)).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: '保留草稿并继续' }).click();
  await page.getByRole('checkbox', { name: '自动保护未保存字幕草稿' }).uncheck();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存。')).toBeVisible();
  await page.getByRole('link', { name: '字幕时间轴' }).click();
  await state(page, 'pick', 1);
  await open(page);
  await edit(page, '仅在内存中的修改');
  await expect(page.getByText('自动草稿保护已关闭，请另存为 SRT。')).toBeVisible();
  await page.waitForTimeout(1350);
  expect((await receipts(page))[0].draft.cues[0].text).toBe('保留的草稿');
});

test('one confirmed calibration revision survives a restart and exports through the draft lifecycle', async ({ page }) => {
  await mockNative(page);
  await page.goto('/#/timeline');
  await open(page);
  await page.getByRole('button', { name: '两点校准', exact: true }).click();
  for (const [label, value] of [
    ['字幕锚点 1', '0'], ['目标锚点 1', '0'], ['字幕锚点 2', '10000'], ['目标锚点 2', '10500'],
  ]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: '计算校准预览' }).click();
  expect(await receipts(page)).toHaveLength(0);
  await page.getByRole('button', { name: '应用两点校准' }).click();
  await expect(page.getByText(/^草稿已保护/)).toBeVisible();
  const [saved] = await receipts(page);
  expect(saved.draft.revision).toBe(1);
  expect(saved.draft.cues.map((item: { startMs: number; endMs: number; text: string }) => [item.startMs, item.endMs, item.text]))
    .toEqual([[1050, 3150, '原稿 🐱'], [4200, 6300, '第二条']]);
  await page.reload();
  await manage(page).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复到时间轴' }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:01.050');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await expect.poll(() => receipts(page)).toHaveLength(0);
  const bytes = await page.evaluate(() => Reflect.get(window, 'recoveryState').exports[0]);
  expect(Buffer.from(bytes).toString('utf8')).toContain('00:00:01,050 --> 00:00:03,150\r\n原稿 🐱');
});
