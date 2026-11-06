import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type Ref } from 'react';
import { errorText } from '../../components/common';
import type { SubtitleCue } from '../../core/models';
import { formatTimestamp, parseTimestamp } from '../../core/time';
import type { CueIndex } from './core/cue-index';
import { selectedPreviewRange, validateLoop, type LoopRange, type TimelineClock } from './core/media-timing';
import { chooseVideo, releaseVideo, resetVideo, type VideoSource } from './media-service';
import { attachMediaSync, loadingState, type MediaStatus } from './media-sync';

export interface MediaPreviewHandle {
  open: () => Promise<void>;
  close: () => Promise<void>;
  seek: (timeMs: number) => boolean;
  captureTime: () => number | undefined;
  previewSelection: () => void;
}

interface Props {
  ref?: Ref<MediaPreviewHandle>;
  clock: TimelineClock;
  index: CueIndex;
  selection?: SubtitleCue;
  selecting: boolean;
  onSelecting: (selecting: boolean) => void;
  onPresence: (active: boolean) => void;
  onDuration: (durationMs: number) => void;
  onLoop: (range: LoopRange | undefined) => void;
}

const statusLabels: Record<MediaStatus, string> = {
  loading: '正在加载视频', ready: '视频就绪', playing: '正在播放', paused: '视频已暂停',
  seeking: '正在跳转', buffering: '正在缓冲', ended: '播放结束',
};
const rates = [0.5, 0.75, 1, 1.25, 1.5];

function MediaCaptions({ clock, index }: { clock: TimelineClock; index: CueIndex }) {
  const time = useSyncExternalStore(clock.subscribe, clock.read);
  const active = index.active(time);
  return <div className="media-captions" role="group" aria-label="视频字幕叠加">
    {active.slice(0, 4).map(cue => <span key={cue.id}>{cue.text.length > 2000 ? `${cue.text.slice(0, 2000)}…` : cue.text}</span>)}
    {active.length > 4 && <span>另有 {active.length - 4} 条字幕</span>}
  </div>;
}

function MediaPosition({ clock, duration, seek }: { clock: TimelineClock; duration: number; seek: (timeMs: number) => void }) {
  const time = Math.min(useSyncExternalStore(clock.subscribe, clock.read), duration);
  return <label className="media-position">
    <span className="media-position-text" aria-label="视频播放时间">{formatTimestamp(time, '.')} / {formatTimestamp(duration, '.')}</span>
    <input type="range" aria-label="视频进度" aria-valuetext={formatTimestamp(time, '.')}
      min={0} max={duration || 1} step={1} disabled={!duration} value={time} onChange={event => seek(Number(event.target.value))} />
  </label>;
}

export function MediaPreview({ ref, clock, index, selection, selecting, onSelecting, onPresence, onDuration, onLoop }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const playback = useRef<ReturnType<typeof attachMediaSync> | null>(null);
  const lifecycle = useRef({ epoch: 0, pending: false, source: null as VideoSource | null });
  const preferences = useRef({ rate: 1, volume: 1, muted: false });
  const [source, setSource] = useState<VideoSource | null>(null);
  const [state, setState] = useState(loadingState);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [jump, setJump] = useState('');
  const [loopStart, setLoopStart] = useState('');
  const [loopEnd, setLoopEnd] = useState('');
  const [loop, setLoop] = useState<LoopRange>();
  const [previewing, setPreviewing] = useState(false);
  const [repeatSelection, setRepeatSelection] = useState(false);
  const [preRoll, setPreRoll] = useState('400');
  const [postRoll, setPostRoll] = useState('400');
  const present = !!source || selecting || !!error;

  useEffect(() => { onPresence(present); }, [onPresence, present]);
  useEffect(() => { onDuration(source ? state.durationMs : 0); }, [onDuration, source, state.durationMs]);
  useEffect(() => { onLoop(loop); }, [onLoop, loop]);
  useEffect(() => {
    const active = lifecycle.current;
    return () => {
      active.epoch++;
      const token = active.source?.token;
      active.source = null;
      if (token) void releaseVideo(token).catch(() => undefined);
    };
  }, []);

  function clearControls() {
    setState(loadingState);
    setLoop(undefined);
    setLoopStart('');
    setLoopEnd('');
    setJump('');
    setPreviewing(false);
  }

  async function close() {
    const active = lifecycle.current;
    const grant = active.source;
    const epoch = ++active.epoch;
    active.source = null;
    active.pending = false;
    playback.current?.dispose();
    resetVideo(video.current);
    setSource(null);
    onSelecting(false);
    clearControls();
    setError('');
    if (grant) {
      try { await releaseVideo(grant.token); }
      catch (problem) { if (epoch === active.epoch) setError(errorText(problem)); }
    }
  }

  async function open() {
    const active = lifecycle.current;
    if (active.pending) return;
    const epoch = ++active.epoch;
    active.pending = true;
    onSelecting(true);
    setError('');
    try {
      const selected = await chooseVideo();
      if (!selected) return;
      if (epoch !== active.epoch) {
        await releaseVideo(selected.token);
        return;
      }
      playback.current?.dispose();
      resetVideo(video.current);
      clearControls();
      active.source = selected;
      setSource(selected);
      clock.set(0);
    } catch (problem) {
      if (epoch === active.epoch) setError(errorText(problem));
    } finally {
      if (epoch === active.epoch) {
        active.pending = false;
        onSelecting(false);
      }
    }
  }

  const onPlaybackError = useEffectEvent((message: string, fatal: boolean) => {
    if (!fatal) { setError(message); return; }
    const closed = close();
    const epoch = lifecycle.current.epoch;
    void closed.finally(() => { if (epoch === lifecycle.current.epoch) setError(message); });
  });

  useLayoutEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    const { rate, volume, muted } = preferences.current;
    element.playbackRate = rate;
    element.volume = volume;
    element.muted = muted;
    const controller = attachMediaSync(element, clock, {
      state: setState,
      error: (message, fatal) => onPlaybackError(message, fatal),
      preview: setPreviewing,
    });
    playback.current = controller;
    element.src = source.url;
    return () => {
      controller.dispose();
      resetVideo(element);
      if (playback.current === controller) playback.current = null;
    };
  }, [source, clock]);

  useLayoutEffect(() => {
    playback.current?.stopPreview();
  }, [selection?.id, selection?.startMs, selection?.endMs]);

  function seek(timeMs: number) {
    return playback.current?.seek(timeMs) ?? false;
  }

  function applyLoop(range: LoopRange | undefined) {
    setLoop(range);
    playback.current?.setLoop(range);
  }

  function captureTime() {
    if (lifecycle.current.pending) throw new Error('请先完成视频选择。');
    if (!lifecycle.current.source) return undefined;
    if (!playback.current) throw new Error('视频时间尚未就绪，请等待加载。');
    return playback.current.captureTime();
  }

  function previewSelection() {
    if (!selection) throw new Error('请先选择一条字幕。');
    if (selecting || !playback.current) throw new Error('请先关联视频。');
    const range = selectedPreviewRange(selection, preRoll ? Number(preRoll) : NaN, postRoll ? Number(postRoll) : NaN, state.durationMs);
    setError('');
    playback.current.startPreview(range, repeatSelection);
  }

  useImperativeHandle(ref, () => ({ open, close, seek, captureTime, previewSelection }));

  if (!present) return null;
  const canPlay = !selecting && state.durationMs > 0;
  return <section className="timeline-card media-preview" aria-label="本地视频预览">
    <div className="timeline-panel-heading">
      <h2>视频预览</h2>
      {source && <div className="button-row">
        <button type="button" className="button secondary small" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开画面' : '收起画面'}</button>
        <button type="button" className="button secondary small" disabled={selecting} onClick={() => void close()}>关闭视频</button>
      </div>}
    </div>
    {selecting && <p className="timeline-inline-note" role="status">正在选择视频…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {source && <>
      <p className="media-source-name" title={source.name}>{source.name}</p>
      <div className="media-stage" hidden={collapsed}>
        <div className="media-frame" style={{ '--media-aspect': state.width && state.height ? state.width / state.height : 16 / 9 } as CSSProperties}>
          <video ref={video} aria-label="本地视频画面" preload="metadata" playsInline disablePictureInPicture disableRemotePlayback />
          {state.durationMs > 0 && <MediaCaptions clock={clock} index={index} />}
        </div>
      </div>
      <p className="timeline-inline-note" role="status">{statusLabels[state.status]}</p>
      <div className="media-controls">
        <button type="button" className="button primary small" disabled={!canPlay} onClick={() => {
          setError('');
          void playback.current?.toggle();
        }}>{state.playing ? '暂停视频' : '播放视频'}</button>
        <label>倍速 <select value={rate} onChange={event => {
          const next = Number(event.target.value);
          preferences.current.rate = next;
          setRate(next);
          if (video.current) video.current.playbackRate = next;
        }}>{rates.map(value => <option value={value} key={value}>{value}×</option>)}</select></label>
        <button type="button" className="button secondary small" aria-pressed={muted} onClick={() => {
          preferences.current.muted = !muted;
          setMuted(!muted);
          if (video.current) video.current.muted = !muted;
        }}>{muted ? '取消静音' : '静音'}</button>
        <label>音量 <input type="range" min={0} max={100} value={Math.round(volume * 100)} onChange={event => {
          const next = Number(event.target.value) / 100;
          preferences.current.volume = next;
          setVolume(next);
          if (video.current) video.current.volume = next;
        }} /></label>
      </div>
      <MediaPosition clock={clock} duration={state.durationMs} seek={seek} />
      <details className="media-loop">
        <summary>选中字幕预览设置{previewing ? ' · 播放中' : ''}</summary>
        <div className="media-preview-options">
          <label>前留白（毫秒）<input type="number" min={0} max={5000} step={1} value={preRoll}
            onChange={event => setPreRoll(event.target.value)} /></label>
          <label>后留白（毫秒）<input type="number" min={0} max={5000} step={1} value={postRoll}
            onChange={event => setPostRoll(event.target.value)} /></label>
          <label className="check-label"><input type="checkbox" checked={repeatSelection}
            onChange={event => setRepeatSelection(event.target.checked)} />循环预览</label>
        </div>
      </details>
      {previewing && <div className="media-controls">
        <span role="status">正在预览选中字幕{loop ? ' · A/B 暂停' : ''}</span>
        <button type="button" className="button secondary small" onClick={() => playback.current?.stopPreview()}>停止区间预览</button>
      </div>}
      <form className="timeline-jump media-jump" onSubmit={event => {
        event.preventDefault();
        try { seek(parseTimestamp(jump)); setError(''); } catch (problem) { setError(errorText(problem)); }
      }}>
        <input aria-label="跳转视频时间" placeholder="00:00:00.000" value={jump} onChange={event => setJump(event.target.value)} />
        <button type="submit" className="button secondary small" disabled={!canPlay}>跳转视频</button>
      </form>
      <details className="media-loop">
        <summary>A/B 区间循环{loop ? ' · 已启用' : ''}</summary>
        <form onSubmit={event => {
          event.preventDefault();
          try { applyLoop(validateLoop(parseTimestamp(loopStart), parseTimestamp(loopEnd), state.durationMs)); setError(''); }
          catch (problem) { setError(errorText(problem)); }
        }}>
          <label>A 点<input placeholder="00:00:00.000" value={loopStart} onChange={event => setLoopStart(event.target.value)} /></label>
          <button type="button" className="button secondary small" disabled={!canPlay} onClick={() => setLoopStart(formatTimestamp(clock.read(), '.'))}>当前位置设 A</button>
          <label>B 点<input placeholder="00:00:00.000" value={loopEnd} onChange={event => setLoopEnd(event.target.value)} /></label>
          <button type="button" className="button secondary small" disabled={!canPlay} onClick={() => setLoopEnd(formatTimestamp(clock.read(), '.'))}>当前位置设 B</button>
          <button type="submit" className="button primary small" disabled={!canPlay}>应用循环</button>
          <button type="button" className="button secondary small" disabled={!loop && !loopStart && !loopEnd} onClick={() => {
            applyLoop(undefined); setLoopStart(''); setLoopEnd(''); setError('');
          }}>清除循环</button>
        </form>
      </details>
    </>}
  </section>;
}
