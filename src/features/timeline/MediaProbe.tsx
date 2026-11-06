import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../components/common';
import { isDesktop } from '../../services/file-service';
import { chooseVideo, releaseVideo, resetVideo, type VideoSource } from './media-service';

/** Minimal native WebView2 probe kept on the integration branch until the access gate passes. */
export function MediaProbe() {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<VideoSource | null>(null);
  const generation = useRef({ epoch: 0 });
  const [source, setSource] = useState<VideoSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    try {
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
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  if (!isDesktop()) return null;
  return <section className="timeline-card" aria-label="本地媒体技术验证">
    <div className="button-row">
      <button type="button" className="button secondary" onClick={() => void open()} disabled={busy}>选择测试视频</button>
      <button type="button" className="button secondary" onClick={() => void close()} disabled={busy || !source}>关闭测试视频</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {source && <video key={source.token} ref={video} src={source.url} aria-label="WebView2 测试视频" preload="metadata" muted controls width="320" />}
  </section>;
}
