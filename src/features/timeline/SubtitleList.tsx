import { memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import type { SubtitleCue } from '../../core/models';
import { formatTimestamp } from '../../core/time';

const ROW_HEIGHT = 46;

export interface SubtitleListHandle { reveal: (id: string) => void }

export const SubtitleList = memo(function SubtitleList({ ref, cues, selectedIds, overlapping, disabled, onSelect }: {
  ref?: Ref<SubtitleListHandle>;
  cues: readonly SubtitleCue[];
  selectedIds: readonly string[];
  overlapping: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (id: string, extend: boolean, range: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [height, setHeight] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const indexed = cues.map((cue, i) => ({ cue, number: i + 1 }));
    return query ? indexed.filter(({ cue, number }) =>
      cue.text.toLowerCase().includes(query) || String(number) === query || formatTimestamp(cue.startMs, '.').includes(query)) : indexed;
  }, [cues, search]);
  const maxTop = Math.max(0, rows.length * ROW_HEIGHT - height);
  const start = Math.max(0, Math.floor(Math.min(scrollTop, maxTop) / ROW_HEIGHT) - 2);
  const end = Math.min(rows.length, start + Math.ceil(height / ROW_HEIGHT) + 5);

  useImperativeHandle(ref, () => ({
    reveal(id) {
      if (search && !rows.some(({ cue }) => cue.id === id)) setSearch('');
    },
  }), [rows, search]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = list.current;
    const position = rows.findIndex(({ cue }) => cue.id === selectedIds.at(-1));
    if (!element || position < 0) return;
    const top = position * ROW_HEIGHT;
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top;
  }, [selectedIds, rows]);

  return <div className="timeline-cue-list">
    <label className="field"><span>搜索字幕</span><input id="timeline-search" type="search" value={search} placeholder="正文、编号或时间" onChange={event => {
      setSearch(event.target.value);
      if (list.current) list.current.scrollTop = 0;
    }} /></label>
    <div className="timeline-list-scroll" ref={list} aria-label="字幕列表" tabIndex={0} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {rows.length ? <div className="timeline-list-rail" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(start, end).map(({ cue, number }, i) => <button type="button"
          key={cue.id} className={`timeline-list-item${selected.has(cue.id) ? ' selected' : ''}`}
          style={{ top: (start + i) * ROW_HEIGHT, height: ROW_HEIGHT - 2 }}
          aria-label={`列表字幕 ${number}`} aria-pressed={selected.has(cue.id)} disabled={disabled}
          onClick={event => onSelect(cue.id, event.ctrlKey || event.metaKey, event.shiftKey)}>
          <span><b>#{number}</b> {formatTimestamp(cue.startMs, '.')} {overlapping.has(cue.id) && <span className="timeline-warning">重叠</span>}</span>
          <span className="timeline-row-text">{cue.text || '空正文'}</span>
        </button>)}
      </div> : <p className="timeline-inline-note">{search ? '没有匹配的字幕。' : '没有字幕，可以插入一条。'}</p>}
    </div>
  </div>;
});
