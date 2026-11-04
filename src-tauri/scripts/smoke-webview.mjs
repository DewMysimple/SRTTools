/* global process, console, window, document */
// Run against a dedicated installed smoke-test instance launched with a loopback CDP port.
// It does not interact with native file dialogs or change user files.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const output = path.resolve('src-tauri/target/smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.SUBTITLE_SMOKE_CDP ?? 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
const pages = context.pages();
const page = pages.find((candidate) => candidate.url().includes('tauri.localhost')) ?? pages[0];
assert.ok(page, 'The installed application must create a WebView2 page');
const runtimeErrors = [];
page.on('pageerror', (error) => runtimeErrors.push(error.message));
await page.getByRole('heading', { name: '让字幕处理，简单一点。' }).waitFor();
assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
await page.screenshot({ path: path.join(output, 'native-home.png'), fullPage: true });

const visited = [];
for (const label of ['全部工具', '批量处理', '处理记录', '设置', '首页']) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label, exact: true }).click();
  visited.push(label);
}

const security = await page.evaluate(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const results = {};
  try {
    await invoke('get_local_value', { key: '../secret.json' });
    results.fixedStoreKeys = false;
  } catch {
    results.fixedStoreKeys = true;
  }
  try {
    await invoke('plugin:store|load', { path: '../secret.json', options: {} });
    results.storePluginDenied = false;
  } catch {
    results.storePluginDenied = true;
  }
  try {
    await invoke('save_output', { name: '../escape.srt', bytes: [65], directory: null });
    results.pathTraversalDenied = false;
  } catch {
    results.pathTraversalDenied = true;
  }
  const files = await invoke('read_dropped_files', { paths: ['C:\\Windows\\win.ini'] });
  results.unselectedReadDenied = files.length === 1 && files[0].bytes.length === 0 && Boolean(files[0].error);
  return results;
});
assert.ok(Object.values(security).every(Boolean), `Native security check failed: ${JSON.stringify(security)}`);

await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设置', exact: true }).click();
await page.getByRole('button', { name: '深色', exact: true }).click();
await page.getByRole('button', { name: '保存设置', exact: true }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
await page.screenshot({ path: path.join(output, 'native-dark.png'), fullPage: true });
await page.reload();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
await page.getByRole('button', { name: '浅色', exact: true }).click();
await page.getByRole('button', { name: '保存设置', exact: true }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

const report = {
  checkedAt: new Date().toISOString(),
  url: page.url(),
  visited,
  security,
  nativeSettingsPersistence: true,
  runtimeErrors,
};
await writeFile(path.join(output, 'webview-report.json'), JSON.stringify(report, null, 2));
assert.deepEqual(runtimeErrors, [], 'Production WebView2 should not report runtime errors');
console.log(JSON.stringify(report, null, 2));
await browser.close();
