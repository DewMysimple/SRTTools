import { errorText } from '../../components/common';
import { mediaTimeMs, SeekQueue, type LoopRange, type TimelineClock } from './core/media-timing';

export type MediaStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'buffering' | 'ended';
export interface PlaybackState {
  status: MediaStatus;
  durationMs: number;
  width: number;
  height: number;
  playing: boolean;
}

export const loadingState: PlaybackState = { status: 'loading', durationMs: 0, width: 0, height: 0, playing: false };

export function attachMediaSync(video: HTMLVideoElement, clock: TimelineClock, events: {
  state: (state: PlaybackState) => void;
  error: (message: string, fatal: boolean) => void;
}) {
  let current = loadingState;
  let loop: LoopRange | undefined;
  let videoFrame: number | undefined;
  let seekFrame: number | undefined;
  let lastPresented = -Infinity;
  let resumeAfterSeek = false;
  let disposed = false;
  const seeks = new SeekQueue();

  function status(next: MediaStatus) {
    const playing = !video.paused && !video.ended;
    if (disposed || (current.status === next && current.playing === playing)) return;
    current = { ...current, status: next, playing };
    events.state(current);
  }

  function reportTime(seconds = video.currentTime) {
    const timeMs = mediaTimeMs(seconds);
    if (timeMs === undefined || video.seeking || disposed) return;
    clock.set(timeMs);
    if (loop && !video.paused && timeMs >= loop.endMs && !seeks.hasPending) requestSeek(loop.startMs);
  }

  function scheduleVideoFrame() {
    if (videoFrame !== undefined || video.paused || disposed || typeof video.requestVideoFrameCallback !== 'function') return;
    videoFrame = video.requestVideoFrameCallback((now, frame) => {
      videoFrame = undefined;
      lastPresented = now;
      if (current.status === 'playing') reportTime(frame.mediaTime);
      scheduleVideoFrame();
    });
  }

  function stopVideoFrame() {
    if (videoFrame === undefined) return;
    video.cancelVideoFrameCallback(videoFrame);
    videoFrame = undefined;
  }

  function scheduleSeek() {
    if (seekFrame !== undefined || disposed) return;
    seekFrame = requestAnimationFrame(() => {
      seekFrame = undefined;
      const intent = seeks.take(video.seeking);
      if (!intent) return;
      try {
        if (Math.abs(video.currentTime * 1000 - intent.timeMs) < 0.5) {
          reportTime();
          if (intent.resume) void play();
          return;
        }
        resumeAfterSeek ||= intent.resume;
        video.currentTime = intent.timeMs / 1000;
        status('seeking');
      } catch {
        resumeAfterSeek = false;
        events.error('无法跳转到这个视频位置。', false);
      }
    });
  }

  function requestSeek(timeMs: number, resume = false): boolean {
    if (!current.durationMs || disposed) return false;
    seeks.put(timeMs, current.durationMs, resume);
    scheduleSeek();
    return true;
  }

  async function play() {
    try { await video.play(); }
    catch (problem) { if (!disposed) events.error(`无法开始播放。请重试。${errorText(problem)}`, false); }
  }

  const handlers = {
    loadedmetadata() {
      const durationMs = mediaTimeMs(video.duration);
      if (!durationMs || !video.videoWidth || !video.videoHeight) {
        events.error('视频没有可预览的有效画面或时长。', true);
        return;
      }
      current = { status: 'ready', durationMs, width: video.videoWidth, height: video.videoHeight, playing: false };
      events.state(current);
      reportTime();
    },
    playing() { status('playing'); scheduleVideoFrame(); },
    pause() { stopVideoFrame(); status(video.ended ? 'ended' : 'paused'); reportTime(); },
    waiting() { if (!video.paused && !video.seeking) status('buffering'); },
    seeking() { stopVideoFrame(); status('seeking'); },
    seeked() {
      if (!seeks.hasPending) reportTime();
      status(video.ended ? 'ended' : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing');
      if (resumeAfterSeek) { resumeAfterSeek = false; void play(); }
      scheduleVideoFrame();
      scheduleSeek();
    },
    timeupdate() {
      // A collapsed picture or hidden window may stop presenting frames.
      if (video.paused || typeof video.requestVideoFrameCallback !== 'function'
        || performance.now() - lastPresented > 200) reportTime();
    },
    ended() {
      stopVideoFrame();
      clock.set(current.durationMs);
      if (loop && !seeks.hasPending) requestSeek(loop.startMs, true);
      else status('ended');
    },
    error() {
      stopVideoFrame();
      const message = video.error?.code === MediaError.MEDIA_ERR_NETWORK
        ? '读取本地视频时发生错误。请确认文件仍可访问，再重新选择。'
        : '当前 Windows/WebView2 无法解码此视频，或文件已损坏。请更换视频，优先使用 H.264/AAC 的 MP4。';
      events.error(message, true);
    },
  };
  const listeners = Object.entries(handlers);
  listeners.forEach(([name, handler]) => video.addEventListener(name, handler));

  return {
    seek: requestSeek,
    async toggle() {
      if (video.paused) {
        if (loop && (clock.read() < loop.startMs || clock.read() >= loop.endMs)) requestSeek(loop.startMs, true);
        else await play();
      } else {
        resumeAfterSeek = false;
        seeks.cancelResume();
        video.pause();
      }
    },
    setLoop(value: LoopRange | undefined) { loop = value; },
    dispose() {
      disposed = true;
      video.pause();
      listeners.forEach(([name, handler]) => video.removeEventListener(name, handler));
      stopVideoFrame();
      if (seekFrame !== undefined) cancelAnimationFrame(seekFrame);
    },
  };
}
