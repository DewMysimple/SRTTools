// Tool presets, workflows and imports share one queue so an import cannot race a form save.
let pending: Promise<unknown> = Promise.resolve();

export function serializePresetOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(async () => {
    // A second browser tab must not mistake an in-progress import journal for a crashed writer.
    // Current Windows WebView2 and the supported Chromium/Firefox previews expose Web Locks.
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks?.request ? await locks.request('subtitle-tools:preset-storage-v1', { mode: 'exclusive' }, operation) : await operation();
  });
  pending = result.catch(() => undefined);
  return result;
}
