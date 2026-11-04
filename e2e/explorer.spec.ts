import { expect, test, type Page } from '@playwright/test';

async function explorerMock(page: Page, conflict = false, delayExternalRegistration = false) {
  await page.addInitScript(({ conflict, delayExternalRegistration }) => {
    const browser = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Map<number, number>>(); let nextId = 0; let nextListenerId = 1000; let enabled = false;
    const bytes = Array.from(new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nbody\n'));
    let pending = [{ name: 'cold 字幕.srt', path: 'C:\\cold 字幕.srt', size: bytes.length, bytes }];
    const requests: unknown[] = []; const changes: boolean[] = [];
    const externalEvent = 'subtitle-tools:external-import-pending';
    const unregisteredExternal = new Set<number>();
    const delayed: { id: number; handler: number; register: () => void; active?: boolean }[] = [];
    const register = (event: string, id: number, handler: number) => {
      const group = listeners.get(event) ?? new Map<number, number>();
      group.set(id, handler); listeners.set(event, group);
    };
    const unregister = (event: string, id: number) => {
      if (event === externalEvent) unregisteredExternal.add(id);
      const group = listeners.get(event); const handler = group?.get(id);
      group?.delete(id); if (handler !== undefined) callbacks.delete(handler);
    };
    let finishFolder: (() => void) | undefined;
    Object.assign(browser, {
      isTauri: true, externalRequests: requests, integrationChanges: changes,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: unregister },
      delayedExternalCount: () => delayed.length,
      externalListenerCount: () => listeners.get(externalEvent)?.size ?? 0,
      unregisteredExternalCount: () => unregisteredExternal.size,
      activateDelayedExternalListener: () => {
        // A native event can arrive before the asynchronous listen IPC reply.
        // Identify the live effect by its actual drain, then deliver its reply first.
        for (const listener of delayed) {
          const previous = requests.length;
          callbacks.get(listener.handler)?.({ event: externalEvent, id: listener.id, payload: null });
          if (requests.length > previous) { listener.active = true; listener.register(); return; }
        }
        throw new Error('No active external listener drained the startup queue.');
      },
      registerStaleExternalListener: () => delayed.filter(listener => !listener.active).forEach(listener => listener.register()),
      queueExternal: () => {
        pending.push({ name: 'warm.srt', path: 'C:\\warm.srt', size: bytes.length, bytes });
        for (const [id, handler] of listeners.get(externalEvent) ?? []) {
          callbacks.get(handler)?.({ event: externalEvent, id, payload: null });
        }
      },
      finishFolder: () => finishFolder?.(),
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++nextId, callback); return nextId; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown>) => {
          if (command === 'plugin:event|listen') {
            const event = args.event as string; const handler = args.handler as number; const id = ++nextListenerId;
            if (delayExternalRegistration && event === externalEvent) return new Promise(resolve => {
              delayed.push({ id, handler, register: () => { register(event, id, handler); resolve(id); } });
            });
            register(event, id, handler); return id;
          }
          if (command === 'plugin:event|unlisten') { unregister(args.event as string, args.eventId as number); return null; }
          if (command === 'get_local_value') return null;
          if (command === 'get_explorer_integration') return { available: true, enabled, conflict, otherInstallation: false };
          if (command === 'set_explorer_integration') { enabled = args.enabled as boolean; changes.push(enabled); return { available: true, enabled, conflict: false, otherInstallation: false }; }
          if (command === 'take_external_imports') { requests.push(args); const files = pending; pending = []; return { files, rejected: 0, duplicates: 0 }; }
          if (command === 'select_import_folder') {
            const summary = { selected: true, visitedEntries: 0, scannedFiles: 0, added: 0, duplicates: 0, unsupported: 0, overLimit: 0, failed: 0, unreadableDirectories: 0, skippedLinks: 0, depthSkipped: 0, cancelledFiles: 0, limitStopped: false, cancelled: false };
            const channel = args.onEvent as { onmessage: (event: unknown) => void };
            channel.onmessage({ scanId: args.scanId, phase: 'reading', summary });
            finishFolder = () => channel.onmessage({ scanId: args.scanId, phase: 'complete', summary }); return null;
          }
          throw new Error(`Unexpected Explorer IPC ${command}`);
        },
      },
    });
  }, { conflict, delayExternalRegistration });
}

test('cold requests wait for initialization and warm requests defer during a folder scan without replacing the queue', async ({ page }) => {
  await explorerMock(page); await page.goto('/#/tools/clean-spaces');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect(page.locator('.file-row')).toContainText('cold 字幕.srt');
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览处理结果', exact: true })).toBeDisabled();
  const before = await page.evaluate(() => (window as unknown as { externalRequests: unknown[] }).externalRequests.length);
  await page.evaluate(() => (window as unknown as { queueExternal: () => void }).queueExternal());
  expect(await page.evaluate(() => (window as unknown as { externalRequests: unknown[] }).externalRequests.length)).toBe(before);
  await expect(page.locator('.file-row')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { finishFolder: () => void }).finishFolder());
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.locator('.file-row').first()).toContainText('cold 字幕.srt');
  expect(await page.evaluate(() => (window as unknown as { externalRequests: unknown[] }).externalRequests.at(-1))).toMatchObject({ existingCount: 1, existingPaths: ['C:\\cold 字幕.srt'] });
});

test('a late stale listener registration removes only itself and preserves the active listener', async ({ page }) => {
  await explorerMock(page, false, true); await page.goto('/#/tools/clean-spaces');
  const call = (name: string) => page.evaluate(name => (window as unknown as Record<string, () => unknown>)[name](), name);
  await expect.poll(() => call('delayedExternalCount')).toBe(2);
  await call('activateDelayedExternalListener');
  await expect(page.locator('.file-row')).toHaveCount(1);
  await expect.poll(() => call('externalListenerCount')).toBe(1);
  await call('registerStaleExternalListener');
  await expect.poll(() => call('unregisteredExternalCount')).toBe(1);
  await expect.poll(() => call('externalListenerCount')).toBe(1);
  await call('queueExternal');
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.locator('.file-row').first()).toContainText('cold 字幕.srt');
  expect(await page.evaluate(() => (window as unknown as { externalRequests: unknown[] }).externalRequests.length)).toBe(2);
});

test('registration defaults off and requires an explicit settings click; disabling is explicit too', async ({ page }) => {
  await explorerMock(page); await page.goto('/#/settings');
  await expect(page.getByText('菜单未登记（默认关闭）', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { integrationChanges: unknown[] }).integrationChanges)).toEqual([]);
  await page.getByRole('button', { name: '启用右键菜单', exact: true }).click();
  await expect(page.getByText('菜单已登记，请在 Explorer 中验证', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '禁用右键菜单', exact: true }).click();
  await expect(page.getByText('菜单未登记（默认关闭）', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { integrationChanges: unknown[] }).integrationChanges)).toEqual([true, false]);
});

test('an unknown owner disables registration and preserves its settings', async ({ page }) => {
  await explorerMock(page, true); await page.goto('/#/settings');
  await expect(page.getByRole('button', { name: '启用右键菜单', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('已保留原设置');
  expect(await page.evaluate(() => (window as unknown as { integrationChanges: unknown[] }).integrationChanges)).toEqual([]);
});
