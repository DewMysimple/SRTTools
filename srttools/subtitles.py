"""Qt-independent SRT parsing, text cleanup and time manipulation."""
from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
import html
import re


class SubtitleError(ValueError):
    """Input cannot be transformed without guessing or losing content."""


STAMP = r"\d{2,}:\d{2}:\d{2}[,.]\d{3}"
TIMING = re.compile(rf"^\s*({STAMP})\s*-->\s*({STAMP})(?:\s+(.*?))?\s*$")
TAG = re.compile(r"</?(?:b|i|u|s|font|ruby|rt|span)(?:\s+[^<>]*)?>|<br\s*/?>", re.I)


@dataclass(frozen=True)
class Cue:
    start: int
    end: int
    text: str
    settings: str = ""


def parse_time(value: str) -> int:
    """Accept seconds, MM:SS, HH:MM:SS, comma/dot and millisecond precision."""
    parts = value.strip().replace(",", ".").split(":")
    if not 1 <= len(parts) <= 3:
        raise SubtitleError("时间格式应为秒、分:秒或时:分:秒（最多三位小数）。")
    try:
        if any(not re.fullmatch(r"\d+(?:\.\d{1,3})?" if i == len(parts)-1 else r"\d+", p)
               for i, p in enumerate(parts)):
            raise ValueError
        values = [Decimal(p) for p in parts]
        if len(parts) > 1 and values[-1] >= 60:
            raise ValueError
        if len(parts) == 3 and values[-2] >= 60:
            raise ValueError
        seconds = sum(v * (60 ** (len(values)-1-i)) for i, v in enumerate(values))
        return int(seconds * 1000)
    except (ValueError, InvalidOperation):
        raise SubtitleError(f"无效时间：{value}。可输入 120、02:00 或 00:02:00,000。") from None


def format_time(ms: int) -> str:
    if ms < 0:
        raise SubtitleError("时间不能为负数。")
    seconds, millis = divmod(ms, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def parse_srt(text: str) -> list[Cue]:
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        raise SubtitleError("文件为空，没有可处理的字幕。")
    cues = []
    for number, block in enumerate(re.split(r"\n[ \t]*\n+", normalized), 1):
        lines = block.split("\n")
        timing_index = 1 if lines[0].strip().isdigit() else 0
        match = TIMING.fullmatch(lines[timing_index]) if len(lines) > timing_index else None
        if not match:
            raise SubtitleError(f"第 {number} 个字幕块缺少有效时间轴；请检查空行及时间格式。")
        start, end = parse_time(match[1]), parse_time(match[2])
        content = "\n".join(lines[timing_index+1:]).strip()
        if end <= start:
            raise SubtitleError(f"第 {number} 个字幕块结束时间必须晚于开始时间。")
        if not content:
            raise SubtitleError(f"第 {number} 个字幕块没有正文。")
        if any(TIMING.fullmatch(line) for line in content.splitlines()):
            raise SubtitleError(f"第 {number} 个字幕块可能缺少分隔空行。")
        cues.append(Cue(start, end, content, match[3] or ""))
    return cues


def clean_txt(text: str) -> str:
    """Remove only structural timing lines and their immediately preceding IDs.

    Standalone numbers and ordinary prose survive. Malformed arrows are reported.
    """
    lines = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    remove = set()
    for i, line in enumerate(lines):
        match = TIMING.fullmatch(line)
        if match:
            if parse_time(match[2]) <= parse_time(match[1]):
                raise SubtitleError(f"第 {i+1} 行时间轴结束时间无效。")
            remove.add(i)
            if i and lines[i-1].strip().isdigit() and (i == 1 or not lines[i-2].strip()):
                remove.add(i-1)
        elif "-->" in line:
            raise SubtitleError(f"第 {i+1} 行包含无法识别的时间轴，请先检查。")
    result = "\n".join(line for i, line in enumerate(lines) if i not in remove).strip()
    return re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", result)


def plain_text(text: str, *, strip_tags: bool = False, layout: str = "keep") -> str:
    if strip_tags:
        text = TAG.sub(lambda m: "\n" if m[0].lower().startswith("<br") else "", text)
        text = html.unescape(text)
    if layout == "lines":
        text = "\n".join(" ".join(part.splitlines()) for part in text.split("\n\n"))
    elif layout == "paragraph":
        text = " ".join(text.split())
    elif layout != "keep":
        raise SubtitleError("未知文本排版方式。")
    return text.strip() + "\n" if text.strip() else ""


def select_range(cues: list[Cue], start: int, end: int, *, policy: str = "overlap",
                 clip: bool = True, rebase: bool = False, offset: int = 0) -> list[Cue]:
    if start < 0 or end <= start:
        raise SubtitleError("范围结束时间必须晚于开始时间。")
    if policy not in {"overlap", "contained", "start"}:
        raise SubtitleError("未知范围匹配方式。")
    result = []
    for cue in cues:
        chosen = (cue.start < end and cue.end > start) if policy == "overlap" else (
            cue.start >= start and cue.end <= end if policy == "contained" else start <= cue.start < end)
        if not chosen:
            continue
        begin, finish = (max(start, cue.start), min(end, cue.end)) if clip else (cue.start, cue.end)
        delta = offset - (start if rebase else 0)
        if begin + delta < 0:
            raise SubtitleError("时间调整会产生负时间；请启用边界裁切或调整偏移。")
        result.append(replace(cue, start=begin+delta, end=finish+delta))
    if not result:
        raise SubtitleError("该时间范围没有匹配字幕；未生成空文件。")
    return result


def render_srt(cues: list[Cue]) -> str:
    return "\n\n".join(
        f"{i}\n{format_time(c.start)} --> {format_time(c.end)}"
        f"{(' ' + c.settings) if c.settings else ''}\n{c.text}"
        for i, c in enumerate(cues, 1)
    ) + "\n"
