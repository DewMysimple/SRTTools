export interface LoopRange {
  startMs: number;
  endMs: number;
}

export class TimelineClock {
  private timeMs = 0;
  private readonly listeners = new Set<() => void>();

  read = () => this.timeMs;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(timeMs: number) {
    if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs === this.timeMs) return;
    this.timeMs = timeMs;
    this.listeners.forEach(listener => listener());
  }
}

export function mediaTimeMs(seconds: number): number | undefined {
  const timeMs = Math.floor(seconds * 1000 + 1e-6);
  return Number.isSafeInteger(timeMs) && timeMs >= 0 ? timeMs : undefined;
}

export function validateLoop(startMs: number, endMs: number, durationMs: number): LoopRange {
  if (![startMs, endMs, durationMs].every(Number.isSafeInteger) || startMs < 0 || startMs >= endMs || endMs > durationMs) {
    throw new Error('循环需满足 0 ≤ A < B ≤ 视频总时长。');
  }
  return { startMs, endMs };
}

interface SeekIntent {
  timeMs: number;
  resume: boolean;
}

/** Only the latest request survives while a frame or an existing seek is pending. */
export class SeekQueue {
  private pending: SeekIntent | undefined;

  get hasPending() { return this.pending !== undefined; }

  put(timeMs: number, durationMs: number, resume = false) {
    if (!Number.isSafeInteger(timeMs) || !Number.isSafeInteger(durationMs) || durationMs < 0) return;
    this.pending = { timeMs: Math.max(0, Math.min(durationMs, timeMs)), resume };
  }

  take(seeking: boolean): SeekIntent | undefined {
    if (seeking) return undefined;
    const intent = this.pending;
    this.pending = undefined;
    return intent;
  }

  cancelResume() {
    if (this.pending) this.pending.resume = false;
  }
}
