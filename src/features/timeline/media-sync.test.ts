import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineClock } from './core/media-timing';
import { attachMediaSync, type PlaybackState } from './media-sync';

class TestVideo extends EventTarget {
  duration = 8;
  videoWidth = 320;
  videoHeight = 180;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  currentTime = 0;
  error: { code: number } | null = null;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.emit('playing');
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.emit('pause');
  });

  emit(name: string) { this.dispatchEvent(new Event(name)); }
}

function setup(video = new TestVideo()) {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('MediaError', { MEDIA_ERR_NETWORK: 2 });
  const tick = () => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach(callback => callback(performance.now()));
  };
  const clock = new TimelineClock();
  const states: PlaybackState[] = [];
  const error = vi.fn();
  const preview = vi.fn();
  const controller = attachMediaSync(video as unknown as HTMLVideoElement, clock, {
    state: next => states.push(next), error, preview,
  });
  return { video, clock, controller, error, preview, tick, state: () => states.at(-1)?.status };
}

afterEach(() => vi.unstubAllGlobals());

describe('HTML media clock', () => {
  it('waits for metadata and reports actual fallback time, buffering, pause and end', async () => {
    const { video, controller, clock, state } = setup();
    expect(controller.seek(300)).toBe(false);
    video.emit('loadedmetadata');
    expect(state()).toBe('ready');
    await controller.toggle();
    expect(state()).toBe('playing');
    video.currentTime = 1.234;
    video.emit('timeupdate');
    expect(clock.read()).toBe(1234);
    video.emit('waiting');
    expect(state()).toBe('buffering');
    video.emit('playing');
    await controller.toggle();
    expect(state()).toBe('paused');
    video.ended = true;
    video.emit('ended');
    expect(state()).toBe('ended');
    expect(clock.read()).toBe(8000);
    controller.dispose();
    video.emit('playing');
    expect(state()).toBe('ended');
  });

  it('coalesces rapid seeks while a decoder seek is outstanding and ignores stale updates', () => {
    const { video, controller, clock, state, tick } = setup();
    video.emit('loadedmetadata');
    controller.seek(800);
    controller.seek(900);
    tick();
    expect(video.currentTime).toBe(0.9);
    expect(state()).toBe('seeking');
    video.seeking = true;
    controller.seek(1200);
    controller.seek(2400);
    video.emit('timeupdate');
    tick();
    expect(clock.read()).toBe(0);
    expect(video.currentTime).toBe(0.9);
    video.seeking = false;
    video.emit('seeked');
    tick();
    expect(video.currentTime).toBe(2.4);
    video.emit('seeked');
    expect(clock.read()).toBe(2400);
    expect(state()).toBe('paused');
  });

  it('restarts at A on a loop ending at the media duration and gives a pending user seek priority', async () => {
    const { video, controller, state, tick } = setup();
    video.emit('loadedmetadata');
    await controller.toggle();
    controller.setLoop({ startMs: 1500, endMs: 6500 });
    controller.seek(4000);
    video.currentTime = 6.6;
    video.emit('timeupdate');
    tick();
    expect(video.currentTime).toBe(4);
    video.emit('seeked');
    controller.setLoop({ startMs: 1500, endMs: 8000 });
    video.paused = video.ended = true;
    video.currentTime = 8;
    video.emit('ended');
    tick();
    expect(video.currentTime).toBe(1.5);
    video.emit('seeked');
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(state()).toBe('playing');
  });

  it('reports play rejection as recoverable and invalid metadata or media errors as fatal', async () => {
    const { video, controller, error, state } = setup();
    video.emit('loadedmetadata');
    video.play.mockRejectedValueOnce(new Error('blocked'));
    await controller.toggle();
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('blocked'), false);
    expect(state()).toBe('ready');
    video.duration = Infinity;
    video.emit('loadedmetadata');
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('有效画面或时长'), true);
    video.error = { code: 2 };
    video.emit('error');
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('读取本地视频'), true);
    video.error = { code: 4 };
    video.emit('error');
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('无法解码'), true);
  });

  it('captures the live element at action time and refuses pending seeks or invalid values', () => {
    const { video, controller, clock, tick } = setup();
    expect(() => controller.captureTime()).toThrow('尚未就绪');
    video.emit('loadedmetadata');
    video.currentTime = 2.1239;
    expect(clock.read()).toBe(0);
    expect(controller.captureTime()).toBe(2123);
    controller.seek(3500);
    expect(() => controller.captureTime()).toThrow('正在跳转');
    tick();
    video.emit('seeked');
    expect(controller.captureTime()).toBe(3500);
    video.currentTime = NaN;
    expect(() => controller.captureTime()).toThrow('无效');
  });

  it('plays a selected range once, stops at its end and resumes the saved A/B only on play', async () => {
    const { video, controller, clock, preview, tick } = setup();
    video.emit('loadedmetadata');
    controller.setLoop({ startMs: 4000, endMs: 6000 });
    controller.startPreview({ startMs: 1000, endMs: 2000 }, false);
    tick();
    expect(video.currentTime).toBe(1);
    video.emit('seeked');
    expect(video.paused).toBe(false);
    video.currentTime = 2.03;
    video.emit('timeupdate');
    expect(video.paused).toBe(true);
    expect(preview.mock.calls).toEqual([[true], [false]]);
    tick();
    video.emit('seeked');
    expect(clock.read()).toBe(2000);
    await controller.toggle();
    tick();
    expect(video.currentTime).toBe(4);
  });

  it('settles at the selected end even when the presented frame lags behind the live media clock', () => {
    let present!: VideoFrameRequestCallback;
    const video = Object.assign(new TestVideo(), {
      requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
        present = callback;
        return 1;
      },
      cancelVideoFrameCallback: vi.fn(),
    });
    const { controller, clock, tick } = setup(video);
    video.emit('loadedmetadata');
    controller.startPreview({ startMs: 1000, endMs: 2000 }, false);
    tick();
    video.emit('seeked');
    video.currentTime = 2.012;
    present(performance.now(), { mediaTime: 2 } as VideoFrameCallbackMetadata);
    expect(video.paused).toBe(true);
    tick();
    video.emit('seeked');
    expect(video.currentTime).toBe(2);
    expect(clock.read()).toBe(2000);
  });

  it('loops a selected range through media end and cancels queued playback on a manual seek', () => {
    const { video, controller, preview, tick } = setup();
    video.emit('loadedmetadata');
    controller.startPreview({ startMs: 7000, endMs: 8000 }, true);
    tick();
    video.emit('seeked');
    video.currentTime = 8;
    video.paused = video.ended = true;
    video.emit('ended');
    tick();
    expect(video.currentTime).toBe(7);
    video.ended = false;
    video.emit('seeked');
    expect(video.paused).toBe(false);
    controller.seek(1500);
    tick();
    video.emit('seeked');
    expect(video.currentTime).toBe(1.5);
    expect(video.paused).toBe(true);
    expect(preview).toHaveBeenLastCalledWith(false);
  });
});
