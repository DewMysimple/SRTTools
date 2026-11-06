import { useEffect, useMemo, useRef, useState } from 'react';
import { errorText, NoticeBox } from '../../components/common';
import { SubtitleDiffPreview } from '../../components/subtitle-diff-preview';
import type { SubtitleCue } from '../../core/models';
import { formatTimestamp, parseTimestamp } from '../../core/time';
import { runCalibrationWorker } from '../../services/processing-service';
import {
  createCalibrationPreview, type CalibrationAnchors, type CalibrationPreview, type CueTiming, type TimingChange,
} from './core/precision-calibration';
import type { EditingSession } from './core/editing-session';

const WORKER_THRESHOLD = 10_000;
const emptyAnchors = { subtitle1: '', video1: '', subtitle2: '', video2: '' };
const points = [
  { number: 1, subtitle: 'subtitle1', video: 'video1' },
  { number: 2, subtitle: 'subtitle2', video: 'video2' },
] as const;

function parseAnchor(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请填写四个锚点，可输入整数毫秒或 HH:MM:SS.mmm。');
  if (!/^[+-]?\d+$/u.test(trimmed)) return parseTimestamp(trimmed);
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('锚点须为非负的安全整数毫秒。');
  return number;
}

interface Baseline {
  revision: number;
  signature: string;
  preview: CalibrationPreview;
}

function range(cue: CueTiming) {
  return formatTimestamp(cue.startMs, '.') + ' → ' + formatTimestamp(cue.endMs, '.');
}

export function CalibrationPanel({ session, selectedIds, cue, hasVideo, blocked, hidden, capturePosition, onApply }: {
  session: EditingSession;
  selectedIds: readonly string[];
  cue?: SubtitleCue;
  hasVideo: boolean;
  blocked: boolean;
  hidden: boolean;
  capturePosition: () => number;
  onApply: (changes: readonly TimingChange[], revision: number) => void;
}) {
  const [anchors, setAnchors] = useState(emptyAnchors);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [result, setResult] = useState<Baseline>();
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [acceptScale, setAcceptScale] = useState(false);
  const [applied, setApplied] = useState(false);
  const abort = useRef<AbortController>(null);
  const signature = JSON.stringify([anchors, scope, scope === 'selected' ? [...selectedIds].sort() : null]);
  const stale = !!result && (result.revision !== session.revision || result.signature !== signature);
  const preview = result?.preview;
  const rows = useMemo(() => {
    if (!showDiff || !preview || stale) return undefined;
    const cues = new Map(session.document.cues.map(cue => [cue.id, cue]));
    const before: SubtitleCue[] = [];
    const after: SubtitleCue[] = [];
    for (const change of preview.changes) {
      const cue = cues.get(change.before.id);
      if (cue) {
        before.push(cue);
        after.push({ ...cue, startMs: change.after.startMs, endMs: change.after.endMs });
      }
    }
    return { before, after };
  }, [showDiff, preview, stale, session.document.cues]);

  useEffect(() => () => abort.current?.abort(), []);

  function update(field: keyof CalibrationAnchors, value: string) {
    setAnchors(current => ({ ...current, [field]: value }));
    setFailure('');
    setAcceptScale(false);
  }

  function record(field: keyof CalibrationAnchors, capture: () => number) {
    try { update(field, formatTimestamp(capture(), '.')); }
    catch (error) { setFailure(errorText(error)); }
  }

  async function calculate() {
    if (pending || applied || blocked) return;
    setFailure('');
    setResult(undefined);
    setShowDiff(false);
    setAcceptScale(false);
    setPending(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const values: CalibrationAnchors = {
        subtitle1: parseAnchor(anchors.subtitle1), video1: parseAnchor(anchors.video1),
        subtitle2: parseAnchor(anchors.subtitle2), video2: parseAnchor(anchors.video2),
      };
      const timings = session.document.cues.map(({ id, index, startMs, endMs }) => ({ id, index, startMs, endMs }));
      const selection = scope === 'selected' ? [...selectedIds] : undefined;
      const preview = timings.length > WORKER_THRESHOLD
        ? await runCalibrationWorker({ kind: 'calibration', cues: timings, anchors: values, selectedIds: selection }, controller.signal)
        : createCalibrationPreview(timings, values, selection);
      if (!controller.signal.aborted) setResult({ revision: session.revision, signature, preview });
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorText(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (abort.current === controller) abort.current = null;
    }
  }

  function apply() {
    if (!result || !preview || stale || blocked || applied || !preview.changes.length || preview.invalidCount ||
      (preview.unusualScale && !acceptScale)) return;
    try {
      onApply(preview.changes, result.revision);
      setApplied(true);
      setResult(undefined);
      setShowDiff(false);
      setFailure('');
    } catch (error) { setFailure(errorText(error)); }
  }

  return <section className="timeline-card timeline-calibration" aria-label="两点校准" hidden={hidden}>
    <div className="timeline-panel-heading"><h2>两点校准</h2></div>
    <p className="timeline-inline-note">给同一片段的字幕时间和目标时间配两对锚点。可输入时间码或整数毫秒，也可记录选中字幕起点和当前位置。</p>
    <form onSubmit={event => { event.preventDefault(); void calculate(); }}>
      <div className="timeline-calibration-fields">
        {points.map(({ number: point, subtitle, video }) => <fieldset key={point}>
          <legend>同步点 {point}</legend>
          <label className="field">字幕锚点 {point}<input value={anchors[subtitle]}
            placeholder="00:00:00.000" onChange={event => update(subtitle, event.target.value)} /></label>
          <button type="button" className="button secondary small" disabled={!cue || blocked}
            title={!cue ? '请选择一条字幕' : '使用选中字幕的开始时间'}
            onClick={() => { if (cue) record(subtitle, () => cue.startMs); }}>记录字幕起点 {point}</button>
          <label className="field">目标锚点 {point}<input value={anchors[video]}
            placeholder="00:00:00.000" onChange={event => update(video, event.target.value)} /></label>
          <button type="button" className="button secondary small" disabled={blocked}
            onClick={() => record(video, capturePosition)}>记录{hasVideo ? '播放位置' : '时间轴游标'} {point}</button>
        </fieldset>)}
      </div>
      <div className="button-row">
        <label>作用范围 <select value={scope} onChange={event => {
          setScope(event.target.value === 'selected' ? 'selected' : 'all');
          setAcceptScale(false);
        }}>
          <option value="all">全部字幕</option>
          <option value="selected">当前选中字幕（{selectedIds.length} 条）</option>
        </select></label>
        <button type="submit" className="button secondary small"
          disabled={blocked || pending || applied || scope === 'selected' && !selectedIds.length}>计算校准预览</button>
      </div>
    </form>
    {scope === 'selected' && !selectedIds.length && <p className="timeline-inline-note">请先在列表或轨道中选择作用范围。</p>}
    {pending && <p role="status">正在计算校准预览…</p>}
    {failure && <p className="field-error" role="alert">{failure}</p>}
    {applied && <div className="button-row">
      <p role="status">已应用两点校准，可撤销一次恢复全部时间。</p>
      <button type="button" className="button secondary small" onClick={() => { setApplied(false); setAcceptScale(false); }}>选择当前版本为新基线</button>
    </div>}
    {stale && <NoticeBox kind="warning">字幕、锚点或作用范围已变化。请重新计算校准预览。</NoticeBox>}
    {preview && !stale && <section className="timeline-calibration-result" aria-label="两点校准结果">
      <p role="status">作用 {preview.scopedCount} 条 · 时间变化 {preview.changes.length} 条 · 无效 {preview.invalidCount} 条</p>
      <p>倍率 {preview.scale.toPrecision(7)} · 估计偏移 {preview.offsetMs.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ms · 锚点跨度 {preview.spanMs} ms</p>
      <p>原有重叠 {preview.priorOverlapPairs} 对 · 本次新增重叠 {preview.newOverlapPairs} 对 · 新增短时长 {preview.newlyShortCount} 条</p>
      <p>时长缩短 {preview.shorterCount} 条，延长 {preview.longerCount} 条，差值 {preview.minDurationDelta} 至 {preview.maxDurationDelta} ms。</p>
      {preview.first && <p>首个示例 {range(preview.first.before)} → {range(preview.first.after)}</p>}
      {preview.last && preview.last !== preview.first && <p>末个示例 {range(preview.last.before)} → {range(preview.last.after)}</p>}
      {!!preview.invalidCount && <NoticeBox kind="error">存在无效结果，当前预览无法应用。请调整锚点或作用范围。</NoticeBox>}
      {!!preview.issues.length && <ul>{preview.issues.map(issue => <li key={issue.position}>第 {issue.position} 条 · {issue.message}</li>)}</ul>}
      {preview.unusualScale && <>
        <NoticeBox kind="warning">倍率超出 0.8–1.2，字幕时长会明显变化。请检查两组锚点。</NoticeBox>
        <label className="check-label"><input type="checkbox" checked={acceptScale}
          onChange={event => setAcceptScale(event.target.checked)} />确认使用此倍率</label>
      </>}
      <div className="button-row">
        <button type="button" className="button secondary small" aria-expanded={showDiff} disabled={!preview.changes.length}
          onClick={() => setShowDiff(value => !value)}>查看校准差异</button>
        <button type="button" className="button primary small" disabled={blocked || !!preview.invalidCount || !preview.changes.length || (preview.unusualScale && !acceptScale)}
          onClick={apply}>应用两点校准</button>
      </div>
      {rows && <SubtitleDiffPreview before={rows.before} after={rows.after} beforeLabel="校准前" afterLabel="校准后" partialOutput={false} />}
    </section>}
  </section>;
}
