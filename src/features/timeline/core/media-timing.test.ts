import { expect, it } from 'vitest';
import { mediaTimeMs, SeekQueue, TimelineClock, validateLoop } from './media-timing';

it('uses integral media milliseconds and sends only changed clock readings', () => {
  expect(mediaTimeMs(1.9999)).toBe(1999);
  expect(mediaTimeMs(1.001)).toBe(1001);
  expect(mediaTimeMs(Infinity)).toBeUndefined();
  expect(mediaTimeMs(-0.1)).toBeUndefined();
  const clock = new TimelineClock();
  const readings: number[] = [];
  const off = clock.subscribe(() => readings.push(clock.read()));
  clock.set(200);
  clock.set(200);
  clock.set(-1);
  clock.set(450);
  off();
  clock.set(900);
  expect(readings).toEqual([200, 450]);
  expect(clock.read()).toBe(900);
});

it('only accepts a finite, ordered loop within the media duration', () => {
  expect(validateLoop(0, 1200, 1200)).toEqual({ startMs: 0, endMs: 1200 });
  for (const bounds of [[-1, 1], [10, 10], [100, 20], [0, 1201], [0.5, 500], [0, Infinity]]) {
    expect(() => validateLoop(bounds[0], bounds[1], 1200)).toThrow('循环需满足');
  }
});

it('serializes seek requests, clamps to the media and retains the latest intent', () => {
  const queue = new SeekQueue();
  queue.put(-5, 9000);
  expect(queue.take(false)).toEqual({ timeMs: 0, resume: false });
  queue.put(1000, 9000);
  expect(queue.take(true)).toBeUndefined();
  queue.put(2500, 9000);
  queue.put(10000, 9000, true);
  queue.put(NaN, 9000);
  queue.cancelResume();
  expect(queue.take(false)).toEqual({ timeMs: 9000, resume: false });
  expect(queue.take(false)).toBeUndefined();
});
