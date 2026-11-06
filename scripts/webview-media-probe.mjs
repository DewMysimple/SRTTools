/* global document, window, HTMLVideoElement */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [, , manifestPath] = process.argv;
const { port, assets } = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const directory = path.dirname(manifestPath);
const receiptPath = path.join(directory, 'media-spike-receipt.json');
const receipt = { status: 'FAIL', samples: [] };
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
try {
  const [context] = browser.contexts();
  const page = context.pages().find(candidate => /^https?:\/\/tauri\.localhost\//u.test(candidate.url()));
  assert.ok(page, 'The controlled native Tauri page was not available');
  receipt.webView = browser.version();
  const devtools = await context.newCDPSession(page);
  await devtools.send('Network.enable');
  await devtools.send('Network.setCacheDisabled', { cacheDisabled: true });
  const network = new Map();
  devtools.on('Network.requestWillBeSent', event => {
    if (new URL(event.request.url).hostname !== 'srtmedia.localhost') return;
    const range = Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === 'range')?.[1];
    network.set(event.requestId, { url: event.request.url, range });
  });
  devtools.on('Network.responseReceived', event => {
    if (new URL(event.response.url).hostname !== 'srtmedia.localhost') return;
    const captured = network.get(event.requestId) ?? { url: event.response.url };
    const headers = Object.fromEntries(Object.entries(event.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
    network.set(event.requestId, {
      ...captured, status: event.response.status,
      contentRange: headers['content-range'], length: Number(headers['content-length'] ?? 0),
    });
  });
  await page.getByRole('link', { name: '字幕时间轴' }).click();
  const select = page.getByRole('button', { name: '选择测试视频' });
  const close = page.getByRole('button', { name: '关闭测试视频' });
  const video = page.locator('video[aria-label="WebView2 测试视频"]');
  await page.evaluate(() => {
    window.mediaProbeEvents = [];
    for (const event of ['loadedmetadata', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'error', 'emptied']) {
      document.addEventListener(event, ({ target }) => {
        if (target instanceof HTMLVideoElement && target.getAttribute('aria-label') === 'WebView2 测试视频') {
          window.mediaProbeEvents.push({ event, time: target.currentTime });
        }
      }, true);
    }
  });

  async function pick(index) {
    await select.click();
    await fs.writeFile(path.join(directory, `media-pick-${index}.ready`), '', { flag: 'wx' });
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '选择测试视频')?.disabled, null, { timeout: 15_000 });
  }

  async function expectAccessDenied(url) {
    const failed = await page.evaluate(url => new Promise(resolve => {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      const finish = rejected => {
        clearTimeout(timeout);
        probe.removeAttribute('src');
        probe.load();
        resolve(rejected);
      };
      const timeout = setTimeout(() => finish(false), 6000);
      probe.addEventListener('error', () => finish(true), { once: true });
      probe.addEventListener('loadedmetadata', () => finish(false), { once: true });
      probe.src = url;
      probe.load();
    }), url);
    assert.equal(failed, true, 'An unauthorized media URL was readable or did not produce a native error');
    return [...network.values()].findLast(request => request.url === url)?.status ?? null;
  }

  await pick('cancel');
  assert.equal(await video.count(), 0);
  receipt.cancelPreservesIdle = true;
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const sample = { id: asset.id, bytes: asset.bytes, sha256: asset.sha256 };
    receipt.samples.push(sample);
    const initialHeap = (await devtools.send('Runtime.getHeapUsage')).usedSize;
    let peak = initialHeap;
    await page.evaluate(() => { window.mediaProbeEvents = []; });
    await pick(i);
    await video.waitFor({ state: 'visible', timeout: 15_000 });
    const url = await video.getAttribute('src');
    assert.match(url, /^https?:\/\/srtmedia\.localhost\/[a-f0-9]{32}$/u);
    await page.waitForFunction(() => {
      const element = document.querySelector('video');
      return element?.readyState >= 1 || element?.error;
    }, null, { timeout: 20_000 });
    const metadata = await video.evaluate(element => ({
      duration: Number.isFinite(element.duration) ? element.duration : null,
      width: element.videoWidth, height: element.videoHeight, error: element.error?.code ?? null,
    }));
    sample.metadata = metadata;
    await assert.rejects(async () => {
      const opened = await fs.open(asset.file, 'r+');
      await opened.close();
    }, error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
    const playable = asset.expected === 'play' || asset.expected === 'observe' && metadata.error === null;
    if (playable) {
      assert.ok(metadata.duration > 1 && metadata.width > 0 && metadata.height > 0 && metadata.error === null);
      sample.seeks = [];
      for (const fraction of [0.05, 0.5, 0.95]) {
        const target = metadata.duration * fraction;
        await video.evaluate((element, target) => { element.currentTime = target; }, target);
        await page.waitForFunction(target => {
          const element = document.querySelector('video');
          return element && !element.seeking && Math.abs(element.currentTime - target) < 0.15;
        }, target, { timeout: 15_000 });
        const before = await video.evaluate(element => element.currentTime);
        await video.evaluate(element => element.play());
        await page.waitForFunction(before => {
          const element = document.querySelector('video');
          return element && element.currentTime > before + 0.12;
        }, before, { timeout: 15_000 });
        await video.evaluate(element => element.pause());
        assert.equal(await video.evaluate(element => element.paused), true);
        sample.seeks.push({ requestedSeconds: target, actualSeconds: before });
        peak = Math.max(peak, (await devtools.send('Runtime.getHeapUsage')).usedSize);
      }
      await video.evaluate(async element => {
        element.currentTime = element.duration - 0.16;
        await element.play();
      });
      await page.waitForFunction(() => document.querySelector('video')?.ended === true, null, { timeout: 12_000 });
      const wrong = new URL(url);
      wrong.pathname = `/${'0'.repeat(32)}`;
      sample.unauthorizedStatus = await expectAccessDenied(wrong.href);
    } else if (asset.expected === 'error') {
      assert.ok(metadata.error, 'The deliberately invalid video did not raise a native decode error');
    }
    sample.events = await page.evaluate(() => window.mediaProbeEvents);
    if (playable) {
      for (const event of ['loadedmetadata', 'playing', 'pause', 'seeking', 'seeked', 'ended']) {
        assert.ok(sample.events.some(item => item.event === event), `Missing WebView2 event: ${event}`);
      }
    }
    sample.peakJsDeltaBytes = Math.max(peak, (await devtools.send('Runtime.getHeapUsage')).usedSize) - initialHeap;
    sample.responses = [...network.values()].filter(request => request.url === url && request.status).map(({ range, status, contentRange, length }) => ({ range, status, contentRange, length }));
    if (asset.bytes > 1024 * 1024 && asset.expected === 'play') {
      assert.ok(sample.responses.length >= 3, 'Missing multiple bounded native media responses');
      for (const part of sample.responses) {
        assert.equal(part.status, 206);
        assert.ok(part.length > 0 && part.length <= 1024 * 1024);
        assert.ok(part.contentRange?.endsWith(`/${asset.bytes}`));
      }
      assert.ok(sample.peakJsDeltaBytes < asset.bytes / 4, 'Renderer JS heap grew with the file size');
    }
    await close.click();
    await video.waitFor({ state: 'detached', timeout: 10_000 });
    sample.closedStatus = await expectAccessDenied(url);
    const released = await fs.open(asset.file, 'r+');
    await released.close();
    sample.handleReleased = true;
  }
  receipt.status = 'PASS';
} catch (problem) {
  receipt.failure = String(problem);
  throw problem;
} finally {
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  await browser.close();
}
