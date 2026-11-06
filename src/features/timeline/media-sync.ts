import { errorText } from '../../components/common';
import { mediaTimeMs, SeekQueue, validateLoop, type LoopRange, type TimelineClock } from './core/media-timing';

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
  preview?: (active: boolean) => void;
}) {
  let current = loadingState;
  let loop: LoopRange | undefined;
  let preview: { range: LoopRange; repeat: boolean; starting: boolean } | undefined;
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
    if (video.paused || seeks.hasPending) return;
    if (preview) {
      if (timeMs >= preview.range.endMs) {
        if (preview.repeat) requestSeek(preview.range.startMs);
        else {
          const endMs = preview.range.endMs;
          stopPreview();
          if (timeMs !== endMs && !video.ended) requestSeek(endMs);
        }
      }
    } else if (loop && timeMs >= loop.endMs) requestSeek(loop.startMs);
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
        stopPreview();
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
    const attempt = preview;
    try { await video.play(); }
    catch (problem) {
      if (disposed || attempt && attempt !== preview) return;
      stopPreview();
      events.error(`无法开始播放。请重试。${errorText(problem)}`, false);
    }
  }

  function stopPreview() {
    if (!preview) return;
    preview = undefined;
    seeks.clear();
    resumeAfterSeek = false;
    video.pause();
    events.preview?.(false);
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
    playing() {
      if (preview) preview.starting = false;
      status('playing');
      scheduleVideoFrame();
    },
    pause() {
      if (preview && !preview.starting && video.paused && !video.ended) stopPreview();
      stopVideoFrame();
      status(video.ended ? 'ended' : 'paused');
      reportTime();
    },
    waiting() { if (!video.paused && !video.seeking) status('buffering'); },
    seeking() { stopVideoFrame(); status('seeking'); },
    seeked() {
      const time = mediaTimeMs(video.currentTime);
      if (preview && time !== undefined && !seeks.hasPending &&
        (time < preview.range.startMs || time >= preview.range.endMs) && !video.ended) stopPreview();
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
      if (preview) {
        if (preview.repeat) requestSeek(preview.range.startMs, true);
        else { stopPreview(); status('ended'); }
      } else if (loop && !seeks.hasPending) requestSeek(loop.startMs, true);
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
    seek(timeMs: number) {
      stopPreview();
      return requestSeek(timeMs);
    },
    captureTime() {
      if (disposed || !current.durationMs) throw new Error('视频时间尚未就绪，请等待加载。');
      if (video.seeking || seeks.hasPending || current.status === 'seeking' || current.status === 'buffering') {
        throw new Error('视频正在跳转或缓冲，请等待播放位置稳定。');
      }
      const time = mediaTimeMs(video.currentTime);
      if (time === undefined || time > current.durationMs) throw new Error('当前视频时间无效。');
      return time;
    },
    async toggle() {
      if (preview) { stopPreview(); return; }
      if (video.paused) {
        if (loop && (clock.read() < loop.startMs || clock.read() >= loop.endMs)) requestSeek(loop.startMs, true);
        else await play();
      } else {
        resumeAfterSeek = false;
        seeks.cancelResume();
        video.pause();
      }
    },
    startPreview(range: LoopRange, repeat: boolean) {
      if (disposed || !current.durationMs) throw new Error('请等待视频加载后再预览。');
      validateLoop(range.startMs, range.endMs, current.durationMs);
      stopPreview();
      seeks.clear();
      resumeAfterSeek = false;
      video.pause();
      preview = { range, repeat, starting: true };
      events.preview?.(true);
      requestSeek(range.startMs, true);
    },
    stopPreview,
    setLoop(value: LoopRange | undefined) { stopPreview(); loop = value; },
    dispose() {
      disposed = true;
      video.pause();
      listeners.forEach(([name, handler]) => video.removeEventListener(name, handler));
      stopVideoFrame();
      if (seekFrame !== undefined) cancelAnimationFrame(seekFrame);
    },
  };
}
