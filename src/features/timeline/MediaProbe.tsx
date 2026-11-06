import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorText } from '../../components/common';
import { isDesktop } from '../../services/file-service';
import { chooseVideo, releaseVideo, resetVideo, type VideoSource } from './media-service';

interface ProbeResponse {
  method: string;
  range: string | null;
  status: number;
  contentRange: string | null;
  contentLength: number | null;
  bodyBytes: number;
}

interface ProbeReceipt {
  grantBytes: number;
  metadata: { duration: number | null; width: number; height: number; error: number | null };
  events: { event: string; time: number }[];
  seeks: { requestedSeconds: number; actualSeconds: number }[];
  responses: ProbeResponse[];
  unknownDenied?: boolean;
  closedDenied?: boolean;
  peakJsDeltaBytes?: number;
  failure?: string;
}

const responses = (reset = false) => invoke<ProbeResponse[]>('media_probe_responses', { reset });

async function until(check: () => boolean, message: string, timeout = 15_000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function mediaDenied(url: string): Promise<boolean> {
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  return new Promise(resolve => {
    const finish = (denied: boolean) => {
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      resolve(denied);
    };
    const timer = setTimeout(() => finish(false), 6000);
    probe.addEventListener('error', () => finish(true), { once: true });
    probe.addEventListener('loadedmetadata', () => finish(false), { once: true });
    probe.src = url;
    probe.load();
  });
}

function heapBytes(): number | undefined {
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

/** Minimal native WebView2 probe kept on the integration branch until the access gate passes. */
export function MediaProbe() {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<VideoSource | null>(null);
  const generation = useRef({ epoch: 0 });
  const [source, setSource] = useState<VideoSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ProbeReceipt>();
  const [revoked, setRevoked] = useState(false);
  const events = useRef<ProbeReceipt['events']>([]);
  useEffect(() => {
    const lifecycle = generation.current;
    return () => {
      lifecycle.epoch++;
      const active = current.current;
      current.current = null;
      if (active) void releaseVideo(active.token).catch(() => undefined);
    };
  }, []);

  async function open() {
    const attempt = ++generation.current.epoch;
    setBusy(true);
    setError('');
    setReceipt(undefined);
    setRevoked(false);
    events.current = [];
    try {
      await responses(true);
      const selected = await chooseVideo();
      if (!selected) return;
      if (attempt !== generation.current.epoch) {
        await releaseVideo(selected.token);
        return;
      }
      resetVideo(video.current);
      current.current = selected;
      setSource(selected);
    } catch (problem) {
      if (attempt === generation.current.epoch) setError(errorText(problem));
    } finally {
      if (attempt === generation.current.epoch) setBusy(false);
    }
  }

  async function close() {
    const active = current.current;
    if (!active) return;
    setBusy(true);
    resetVideo(video.current);
    try {
      await releaseVideo(active.token);
      current.current = null;
      setSource(null);
      const denied = await mediaDenied(active.url);
      const captured = await responses();
      setReceipt(previous => previous && { ...previous, closedDenied: denied, responses: captured });
      setRevoked(denied && captured.at(-1)?.status === 404);
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    const element = video.current;
    const active = current.current;
    if (!element || !active) return;
    setBusy(true);
    setError('');
    const initialHeap = heapBytes();
    let peakHeap = initialHeap ?? 0;
    const next: ProbeReceipt = {
      grantBytes: new TextEncoder().encode(JSON.stringify({ token: active.token, name: active.name })).byteLength,
      metadata: { duration: null, width: 0, height: 0, error: null }, events: [], seeks: [], responses: [],
    };
    try {
      await until(() => element.readyState >= HTMLMediaElement.HAVE_METADATA || !!element.error, '未收到视频元数据或解码错误。');
      next.metadata = {
        duration: Number.isFinite(element.duration) ? element.duration : null,
        width: element.videoWidth, height: element.videoHeight, error: element.error?.code ?? null,
      };
      if (!element.error) {
        const { duration } = element;
        for (const fraction of [0.05, 0.5, 0.95]) {
          const requestedSeconds = duration * fraction;
          element.currentTime = requestedSeconds;
          await until(() => !element.seeking && Math.abs(element.currentTime - requestedSeconds) < 0.15, '视频跳转未完成。');
          const actualSeconds = element.currentTime;
          await element.play();
          await until(() => element.currentTime > actualSeconds + 0.12, 'WebView2 播放时间未推进。');
          element.pause();
          next.seeks.push({ requestedSeconds, actualSeconds });
          peakHeap = Math.max(peakHeap, heapBytes() ?? 0);
        }
        element.currentTime = duration - 0.16;
        await element.play();
        await until(() => element.ended, '未收到视频播放结束。');
        const unknown = new URL(active.url);
        unknown.pathname = `/${'0'.repeat(32)}`;
        next.unknownDenied = await mediaDenied(unknown.href);
      }
    } catch (problem) {
      next.failure = errorText(problem);
    } finally {
      next.events = [...events.current];
      next.responses = await responses();
      if (initialHeap !== undefined) next.peakJsDeltaBytes = Math.max(peakHeap, heapBytes() ?? 0) - initialHeap;
      setReceipt(next);
      setBusy(false);
    }
  }

  function record(event: string, element: HTMLVideoElement) {
    if (events.current.length < 512) events.current.push({ event, time: element.currentTime });
  }

  if (!isDesktop()) return null;
  return <section className="timeline-card" aria-label="本地媒体技术验证">
    <div className="button-row">
      <button type="button" className="button secondary" onClick={() => void open()} disabled={busy}>选择测试视频</button>
      <button type="button" className="button secondary" onClick={() => void inspect()} disabled={busy || !source}>运行媒体检查</button>
      <button type="button" className="button secondary" onClick={() => void close()} disabled={busy || !source}>关闭测试视频</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {source && <video key={source.token} ref={video} src={source.url} aria-label="WebView2 测试视频" preload="metadata" muted controls width="320"
      onLoadedMetadata={event => record('loadedmetadata', event.currentTarget)}
      onPlaying={event => record('playing', event.currentTarget)} onPause={event => record('pause', event.currentTarget)}
      onSeeking={event => record('seeking', event.currentTarget)} onSeeked={event => record('seeked', event.currentTarget)}
      onWaiting={event => record('waiting', event.currentTarget)} onEnded={event => record('ended', event.currentTarget)}
      onError={event => record('error', event.currentTarget)} />}
    {receipt && <label className="field">媒体实测记录<textarea aria-label="媒体实测记录" readOnly rows={2} value={JSON.stringify(receipt)} /></label>}
    {revoked && <p role="status">已撤销测试访问</p>}
  </section>;
}
