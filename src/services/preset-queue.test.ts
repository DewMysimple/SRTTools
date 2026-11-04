import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('preset coordination across browser contexts', () => {
  it('takes the same origin-wide exclusive Web Lock even for independently loaded service queues', async () => {
    let held: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, _options: unknown, callback: () => Promise<unknown>) => {
      const next = held.then(callback);
      held = next.catch(() => undefined);
      return next;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const first = await import('./preset-queue');
    vi.resetModules();
    const second = await import('./preset-queue');
    const events: string[] = [];
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    const running = first.serializePresetOperation(async () => {
      events.push('first:start'); started();
      await new Promise<void>(resolve => { release = resolve; });
      events.push('first:end');
    });
    await beginning;
    const waiting = second.serializePresetOperation(async () => { events.push('second'); });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(events).toEqual(['first:start']);
    release(); await Promise.all([running, waiting]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(request.mock.calls.every(([name, options]) => name === 'subtitle-tools:preset-storage-v1' && JSON.stringify(options) === '{"mode":"exclusive"}')).toBe(true);
    await expect(first.serializePresetOperation(async () => { throw new Error('failed save'); })).rejects.toThrow('failed save');
    await expect(first.serializePresetOperation(async () => 'recovered')).resolves.toBe('recovered');
  });
});
