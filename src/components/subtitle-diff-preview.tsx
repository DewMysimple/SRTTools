import { memo, useMemo, useState } from 'react';
import { formatTimestamp } from '../core/time';
import type { SubtitleCue } from '../core/models';
import { buildSubtitleDiff, type CueDiffRow } from '../core/diff/subtitle-diff';
import { diffCueText, type TextDiffSegment } from '../core/diff/text-diff';
import { EmptyState, NoticeBox } from './common';

export const PREVIEW_PAGE_SIZE = 20;
const CUE_TEXT_LIMIT = 2_048;
const previewSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined;

interface PreviewLabels { before: string; after: string }
export function SubtitleDiffPreview({ before, after, partialOutput, trustIds = true, timeToleranceMs = 0, documentComparison = false, beforeLabel = '处理前', afterLabel = '处理后' }: {
  before: readonly SubtitleCue[];
  after: readonly SubtitleCue[];
  partialOutput: boolean;
  trustIds?: boolean;
  timeToleranceMs?: number;
  documentComparison?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const diff = useMemo(() => buildSubtitleDiff(before, after, { trustIds, timeToleranceMs }), [before, after, trustIds, timeToleranceMs]);
  const labels = { before: beforeLabel, after: afterLabel };
  return <section className="diff-preview" aria-label="字幕差异预览">
    {documentComparison && <p className="diff-note">只读对比，以第一份为基准显示新增、删除和变化。开始与结束时间差不超过 {timeToleranceMs} 毫秒时视为相同，原始时间仍完整显示。</p>}
    {partialOutput && <p className="diff-note">对比仅针对所选输出。标为删除的条目未包含在此输出，可能出现在其他分段。</p>}
    {!after.length && <NoticeBox>所选输出没有字幕条目。</NoticeBox>}
    {diff.kind === 'aligned' ? <AlignedPreview diff={diff} partialOutput={partialOutput} labels={labels} documentComparison={documentComparison} /> : <>
      <NoticeBox kind="warning">字幕规模较大，无法精确对齐。{documentComparison ? '第一份' : '原文'} {diff.beforeCount} 条，{documentComparison ? '第二份' : '输出'} {diff.afterCount} 条。以下分别分页展示，行位置不代表配对。</NoticeBox>
      <SeparatePreview before={before} after={after} labels={labels} />
    </>}
  </section>;
}

function AlignedPreview({ diff, partialOutput, labels, documentComparison }: {
  diff: Extract<ReturnType<typeof buildSubtitleDiff>, { kind: 'aligned' }>;
  partialOutput: boolean;
  labels: PreviewLabels;
  documentComparison: boolean;
}) {
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [page, setPage] = useState(0);
  const { summary } = diff;
  const rows = useMemo(() => onlyChanges ? diff.rows.filter(row => row.kind !== 'unchanged') : diff.rows, [diff, onlyChanges]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_SIZE));
  const visible = rows.slice(page * PREVIEW_PAGE_SIZE, (page + 1) * PREVIEW_PAGE_SIZE);
  const counts = [
    ['受影响行', summary.affected], ['新增', summary.added], ['删除', summary.removed],
    ['正文变更', summary.textChanged], ['时间变更', summary.timeChanged], ['编号变更', summary.indexChanged],
    ['未变化', summary.unchanged], ['重排', summary.reordered], ['未匹配', summary.ambiguous],
  ] as const;
  const filter = (changed: boolean) => { setOnlyChanges(changed); setPage(0); };

  return <>
    <dl className="diff-summary" aria-label="差异摘要">{counts.map(([label, count]) =>
      <div key={label}><dt>{label}</dt>{' '}<dd>{count}</dd></div>
    )}</dl>
    <p className="diff-note">同一行的正文、时间、编号或顺序变化可同时计入各项，受影响行总数每行只计一次。</p>
    {summary.ambiguous > 0 && <NoticeBox kind="warning">部分条目无法可靠匹配，已按未匹配行单独显示。</NoticeBox>}
    {summary.affected === 0 && <NoticeBox>{documentComparison ? '两份字幕在所选时间容差内无条目变化。' : '字幕条目无变化。导出格式、编码和换行以当前输出为准。'}</NoticeBox>}
    <div className="diff-filters button-row" role="group" aria-label="过滤差异行">
      <button type="button" className="button secondary small" aria-pressed={!onlyChanges} onClick={() => filter(false)}>全部</button>
      <button type="button" className="button secondary small" aria-pressed={onlyChanges} onClick={() => filter(true)}>仅变化</button>
      <span className="diff-note" role="status">显示 {rows.length} 行</span>
    </div>
    {visible.length > 0 ? <>
      <div className="diff-table" key={`${onlyChanges}-${page}`} role="table" aria-label={documentComparison ? '两份独立字幕的逻辑对比' : '按字幕配对的处理前后内容'} tabIndex={0}>
        <div className="preview-grid diff-headings" role="row">
          <span className="preview-label" role="columnheader">{labels.before}</span>
          <span className="preview-label after" role="columnheader">{labels.after}</span>
        </div>
        {visible.map(row => <AlignedCueRow key={row.key} row={row} partialOutput={partialOutput} documentComparison={documentComparison} />)}
      </div>
      <Pagination page={page} count={pageCount} onChange={setPage} />
    </> : <p className="diff-note">没有可显示的差异行。</p>}
  </>;
}

const AlignedCueRow = memo(function AlignedCueRow({ row, partialOutput, documentComparison }: { row: CueDiffRow; partialOutput: boolean; documentComparison: boolean }) {
  const { before, after } = row;
  const canHighlight = before && after && row.textChanged && before.text.length <= CUE_TEXT_LIMIT && after.text.length <= CUE_TEXT_LIMIT;
  const fragments = canHighlight ? diffCueText(before.text, after.text) : undefined;
  const labels: string[] = [];
  if (row.textChanged) labels.push(fragments?.detailed ? '正文变更' : '正文变更（省略逐字高亮）');
  if (row.timeChanged) labels.push('时间调整');
  if (row.indexChanged) labels.push('编号变更');
  if (row.reordered) labels.push('顺序调整');
  const beforeName = documentComparison ? '第一份' : '处理前';
  const afterName = documentComparison ? '第二份' : '处理后';
  return <div className="preview-grid diff-row" role="row">
    <div role="cell">{before
      ? <CueCard cue={before} segments={fragments?.detailed ? fragments.before : undefined} change={row} />
      : <p className="diff-placeholder">{row.kind === 'unmatched' ? `未匹配 · ${beforeName}无可靠配对` : `新增 · ${beforeName}无此条`}</p>}</div>
    <div role="cell">{after
      ? <CueCard cue={after} segments={fragments?.detailed ? fragments.after : undefined} change={row} labels={labels} />
      : <p className="diff-placeholder">{row.kind === 'unmatched' ? `未匹配 · ${afterName}无可靠配对` : partialOutput ? '未包含于此分段' : `已删除 · ${afterName}无此条`}</p>}</div>
  </div>;
});

function SeparatePreview({ before, after, labels }: { before: readonly SubtitleCue[]; after: readonly SubtitleCue[]; labels: PreviewLabels }) {
  const [page, setPage] = useState(0);
  const start = page * PREVIEW_PAGE_SIZE;
  return <>
    <div className="preview-grid" key={page}>
      <div><div className="preview-label">{labels.before}</div><CuePreview cues={before.slice(start, start + PREVIEW_PAGE_SIZE)} /></div>
      <div><div className="preview-label after">{labels.after}</div><CuePreview cues={after.slice(start, start + PREVIEW_PAGE_SIZE)} /></div>
    </div>
    <Pagination page={page} count={Math.max(1, Math.ceil(Math.max(before.length, after.length) / PREVIEW_PAGE_SIZE))} onChange={setPage} />
  </>;
}

export function PagedCuePreview({ cues }: { cues: readonly SubtitleCue[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(cues.length / PREVIEW_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PREVIEW_PAGE_SIZE;
  return <>
    <CuePreview cues={cues.slice(start, start + PREVIEW_PAGE_SIZE)} />
    <Pagination page={safePage} count={pageCount} onChange={setPage} />
  </>;
}

function CuePreview({ cues }: { cues: readonly SubtitleCue[] }) {
  return <div className="cue-preview">{cues.length
    ? cues.map((cue, index) => <CueCard key={`${cue.id}-${index}`} cue={cue} />)
    : <EmptyState title="此页没有条目" description="操作可能已删除条目，或两侧条数不同。" />}
  </div>;
}

function CueCard({ cue, segments, change, labels }: {
  cue: SubtitleCue;
  segments?: readonly TextDiffSegment[];
  change?: Pick<CueDiffRow, 'timeChanged' | 'indexChanged'>;
  labels?: readonly string[];
}) {
  const truncated = cue.text.length > CUE_TEXT_LIMIT;
  const text = truncated ? clipCueText(cue.text) : cue.text;
  return <div className="cue">
    <div>
      <span className={change?.indexChanged ? 'diff-field' : undefined}>{cue.index}</span>
      <code className={change?.timeChanged ? 'diff-field' : undefined}>{timeLabel(cue.startMs)} → {timeLabel(cue.endMs)}</code>
    </div>
    <p>{text ? segments?.map((segment, index) => segment.kind === 'equal' ? segment.text : (
      <span className={`diff-${segment.kind}`} key={index} title={segment.kind === 'insert' ? '加入的文字' : '移除的文字'}>{segment.text}</span>
    )) ?? text : <em>空白字幕</em>}</p>
    {truncated && <small className="diff-note">正文过长，预览仅显示开头。导出保留完整正文。</small>}
    {!!labels?.length && <ul className="diff-labels" aria-label="本行变化">{labels.map(label => <li key={label}>{label}</li>)}</ul>}
  </div>;
}

function clipCueText(text: string) {
  const prefix = text.slice(0, CUE_TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/u, '');
  // The final grapheme in the bounded prefix may extend beyond the cut.
  const lastGrapheme = previewSegmenter?.segment(prefix).containing(prefix.length - 1);
  return prefix.slice(0, lastGrapheme?.index ?? prefix.length) + '…';
}

function timeLabel(ms: number) {
  return Number.isSafeInteger(ms) && ms >= 0 ? formatTimestamp(ms) : `无效 (${ms})`;
}

export function Pagination({ page, count, onChange }: { page: number; count: number; onChange: (n: number) => void }) {
  return <div className="pagination">
    <button type="button" className="button secondary small" disabled={page === 0} onClick={() => onChange(page - 1)}>上一页</button>
    <span role="status" aria-label="当前页 / 总页数">{page + 1} / {count}</span>
    <button type="button" className="button secondary small" disabled={page + 1 >= count} onClick={() => onChange(page + 1)}>下一页</button>
  </div>;
}
