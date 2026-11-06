import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = [
  ['00:00:01,000', '00:00:02,500', '第一行 🐱\n第二行'],
  ['00:00:02,000', '00:00:03,500', '<script>安全文本</script>'],
  ['00:00:05,000', '00:00:07,000', '后段字幕'],
  ['00:00:08,200', '00:00:09,000', '片尾以后'],
].map(([start, end, text], i) => `${i + 1}\n${start} --> ${end}\n${text}\n`).join('\n');

async function openWorkspace(page: Page, info: TestInfo, subtitles = source) {
  const fixture = info.outputPath('synthetic-media.webm');
  const generator = fileURLToPath(new URL('../scripts/generate-media-fixture.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [generator, fixture], { windowsHide: true });
  const body = await readFile(fixture);
  await page.route('**/synthetic-media.webm?grant=*', async route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    if (!range) { await route.fulfill({ contentType: 'video/webm', body }); return; }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    const headers = { 'accept-ranges': 'bytes', 'content-range': start > end ? `bytes */${body.length}` : `bytes ${start}-${end}/${body.length}` };
    await route.fulfill({ status: start > end ? 416 : 206, contentType: 'video/webm', headers, body: body.subarray(start, end + 1) });
  });
  await page.route('**/broken-media.mp4*', route => route.fulfill({ contentType: 'video/mp4', body: 'invalid media' }));
  await page.addInitScript(source => {
    const bytes = Array.from(new TextEncoder().encode(source));
    const releases: string[] = [];
    let selection = 0;
    Object.assign(window, {
      isTauri: true,
      mediaReleases: releases,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => 1,
        convertFileSrc: (token: string) => token === '3' ? '/broken-media.mp4' : `/synthetic-media.webm?grant=${token}`,
        invoke: async (command: string, args: { token?: string; name?: string }) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_local_value') return { protectTimelineDrafts: false };
          if (command === 'list_drafts') return { drafts: [], usedBytes: 0, budgetBytes: 64 * 1024 * 1024, draftLimit: 20 };
          if (command === 'take_external_imports') return { files: [], rejected: 0, duplicates: 0 };
          if (command === 'select_files') return [{ name: '媒体字幕.srt', bytes, size: bytes.length }];
          if (command === 'select_video') {
            selection++;
            if (selection === 2) {
              await new Promise<void>(resolve => window.addEventListener('test-cancel-media-picker', () => resolve(), { once: true }));
              return null;
            }
            return { name: selection === 3 ? '损坏.mp4' : `测试视频 ${selection}.webm`, token: String(selection) };
          }
          if (command === 'release_video') { releases.push(args.token!); return null; }
          if (command === 'save_output') return args.name;
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, subtitles);
  await page.goto('/#/timeline');
  await page.getByRole('button', { name: '打开字幕' }).click();
  await expect(page.getByLabel('开始时间')).toHaveValue('00:00:01.000');
  await page.getByRole('button', { name: '关联视频' }).click();
  await expect(page.getByText('视频就绪', { exact: true })).toBeVisible();
}

async function jump(page: Page, timestamp: string) {
  await page.getByLabel('跳转视频时间').fill(timestamp);
  await page.getByRole('button', { name: '跳转视频' }).click();
  await expect(page.getByLabel('时间轴光标时间')).toHaveText(timestamp);
}

test('real video element and shared timeline clock show exact boundaries, overlap and safe text', async ({ page }, info) => {
  await page.setViewportSize({ width: 1250, height: 1000 });
  await openWorkspace(page, info);
  const overlay = page.getByRole('group', { name: '视频字幕叠加' });
  await expect(overlay).toBeEmpty();
  await jump(page, '00:00:02.200');
  await expect(overlay).toContainText('第一行 🐱');
  await expect(overlay).toContainText('<script>安全文本</script>');
  await expect(overlay.locator('script')).toHaveCount(0);
  await expect(page.getByText('1 条超出视频时长')).toBeVisible();
  await info.attach('media-preview-workspace.png', { body: await page.screenshot(), contentType: 'image/png' });
  await jump(page, '00:00:02.500');
  await expect(overlay).not.toContainText('第一行');
  await expect(overlay).toContainText('安全文本');
  await jump(page, '00:00:03.500');
  await expect(overlay).toBeEmpty();
  const video = page.locator('video');
  const tick = (seconds: number) => page.locator('.timeline-tick').filter({ hasText: new RegExp(`^00:00:0${seconds}\\.000$`, 'u') });
  const [two, four] = await Promise.all([tick(2).boundingBox(), tick(4).boundingBox()]);
  expect(two && four).toBeTruthy();
  await page.mouse.click(two!.x, two!.y + 12);
  const mediaTime = () => video.evaluate(element => (element as HTMLVideoElement).currentTime);
  await expect.poll(async () => Math.abs(await mediaTime() - 2)).toBeLessThan(0.06);
  const marker = await page.locator('.timeline-playhead').boundingBox();
  expect(marker).toBeTruthy();
  await page.mouse.move(marker!.x + 1, two!.y + 12);
  await page.mouse.down();
  await page.mouse.move(four!.x, four!.y + 12, { steps: 7 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(await mediaTime() - 4)).toBeLessThan(0.06);
  await expect(overlay).toBeEmpty();
  await page.getByRole('button', { name: '列表字幕 3' }).click();
  await page.getByRole('button', { name: '定位字幕' }).click();
  await expect(overlay).toHaveText('后段字幕');
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.getByLabel('倍速').selectOption('1.5');
  await page.getByLabel('音量').press('ArrowLeft');
  expect(await video.evaluate(element => {
    const media = element as HTMLVideoElement;
    return { rate: media.playbackRate, muted: media.muted, volume: media.volume };
  }))
    .toEqual({ rate: 1.5, muted: true, volume: 0.99 });
  await page.getByRole('button', { name: '播放视频' }).click();
  await expect(page.getByText('正在播放', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停视频' }).click();
  await expect(page.getByText('视频已暂停', { exact: true })).toBeVisible();
  await jump(page, '00:00:07.800');
  await page.getByRole('button', { name: '播放视频' }).click();
  await expect(page.getByText('播放结束', { exact: true })).toBeVisible();
  await expect(page.getByLabel('时间轴光标时间')).toHaveText('00:00:08.000');
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
});

test('A/B loops and file-picker cancellation or decode failure preserve edited subtitles', async ({ page }, info) => {
  await openWorkspace(page, info);
  await page.getByText('A/B 区间循环', { exact: true }).click();
  await page.getByLabel('A 点', { exact: true }).fill('00:00:01.200');
  await page.getByLabel('B 点', { exact: true }).fill('00:00:00.900');
  await page.getByRole('button', { name: '应用循环' }).click();
  await expect(page.getByRole('alert')).toContainText('循环需满足');
  await page.getByLabel('B 点', { exact: true }).fill('00:00:01.750');
  await page.getByRole('button', { name: '应用循环' }).click();
  await expect(page.getByText('A/B 区间循环 · 已启用')).toBeVisible();
  await expect(page.locator('.timeline-loop-marker')).toHaveCount(2);
  const video = page.locator('video');
  await video.evaluate(element => {
    element.dataset.loopSeeks = '0';
    element.addEventListener('seeked', () => {
      if ((element as HTMLVideoElement).currentTime < 1.23) element.dataset.loopSeeks = String(Number(element.dataset.loopSeeks) + 1);
    });
  });
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.getByRole('button', { name: '播放视频' }).click();
  await expect.poll(async () => Number(await video.getAttribute('data-loop-seeks'))).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '暂停视频' }).click();
  await page.getByRole('button', { name: '清除循环' }).click();
  await expect(page.locator('.timeline-loop-marker')).toHaveCount(0);
  await page.getByLabel('字幕正文').fill('保留编辑 🐱');
  await page.getByRole('button', { name: '应用编辑' }).click();
  const replaceVideo = page.getByRole('button', { name: '更换视频' });
  await replaceVideo.click();
  await expect(replaceVideo).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('test-cancel-media-picker')));
  await expect(replaceVideo).toBeEnabled();
  await expect(page.getByText('测试视频 1.webm')).toBeVisible();
  await replaceVideo.click();
  await expect(page.getByRole('alert')).toContainText('无法解码');
  await expect(video).toHaveCount(0);
  await expect(page.getByLabel('字幕正文')).toHaveValue('保留编辑 🐱');
  await page.getByRole('button', { name: '更换视频' }).click();
  await expect(page.getByText('测试视频 4.webm')).toBeVisible();
  await page.getByRole('button', { name: '关闭视频' }).click();
  await expect(page.getByRole('region', { name: '本地视频预览' })).toHaveCount(0);
  const revoked = await page.evaluate(() => Reflect.get(window, 'mediaReleases'));
  expect(revoked).toEqual(['3', '4']);
  await page.getByRole('button', { name: '另存为' }).click();
  await expect(page.getByText('无未保存修改', { exact: true })).toBeVisible();
});

test('10,000 cues keep the editor stable while media plays in a compact window', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 620 });
  const cues = Array.from({ length: 10000 }, (_, i) => {
    const stamp = (ms: number) => `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    return `${i + 1}\n${stamp(1000 + i * 5)} --> ${stamp(1004 + i * 5)}\n压力测试 ${i + 1}\n`;
  }).join('\n');
  await openWorkspace(page, info, cues);
  await page.getByRole('button', { name: '收起画面' }).click();
  await expect(page.locator('video')).not.toBeVisible();
  await page.getByRole('button', { name: '播放视频' }).click();
  await expect(page.getByText('正在播放', { exact: true })).toBeVisible();
  const measurements = await page.evaluate(async () => {
    let editorMutations = 0;
    const observer = new MutationObserver(records => { editorMutations += records.length; });
    for (const selector of ['.timeline-cue-list', '.timeline-inspector']) {
      observer.observe(document.querySelector(selector)!, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    let longTasks = 0;
    const performanceObserver = new PerformanceObserver(entries => { longTasks += entries.getEntries().length; });
    performanceObserver.observe({ type: 'longtask' });
    const intervals: number[] = [];
    const start = performance.now();
    await new Promise<void>(resolve => {
      let previous = start;
      function sample(now: number) {
        if (now > previous) intervals.push(now - previous);
        previous = now;
        if (now - start >= 1250) resolve();
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    observer.disconnect();
    performanceObserver.disconnect();
    intervals.sort((a, b) => a - b);
    return { frames: intervals.length, frameP95Ms: intervals[Math.floor(intervals.length * 0.95)], longTasks, editorMutations };
  });
  console.log('Media playback measurements', JSON.stringify(measurements));
  await info.attach('media-playback-measurement', { body: JSON.stringify(measurements), contentType: 'application/json' });
  expect(measurements.editorMutations).toBe(0);
  await expect(page.getByLabel('时间轴光标时间')).toHaveText(/^00:00:0[1-7]\./u);
  await page.getByRole('button', { name: '暂停视频' }).click();
  await page.getByRole('button', { name: '展开画面' }).click();
  await expect(page.getByRole('button', { name: '另存为' })).toBeVisible();
  await expect(page.locator('video')).toBeVisible();
});
