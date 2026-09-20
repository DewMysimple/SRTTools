"""Read-only preparation and no-overwrite atomic exports; no Qt imports."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat
import tempfile
from threading import Event
from typing import Callable

from .subtitles import SubtitleError, clean_txt, parse_srt, plain_text, render_srt, select_range

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_BATCH_BYTES = 256 * 1024 * 1024
ENCODINGS = ("auto", "utf-8", "utf-8-sig", "utf-16", "gb18030", "big5", "cp1252")


@dataclass(frozen=True)
class Options:
    mode: str = "raw"
    encoding: str = "auto"
    output_encoding: str = "utf-8"
    layout: str = "keep"
    strip_tags: bool = False
    output_format: str = "srt"
    start: int = 0
    end: int = 60_000
    policy: str = "overlap"
    clip: bool = True
    rebase: bool = False
    offset: int = 0
    include_timestamps: bool = False


@dataclass(frozen=True)
class Prepared:
    source: Path
    fingerprint: str
    data: bytes
    preview: str
    encoding: str
    cue_count: int | None
    suffix: str
    warnings: tuple[str, ...] = ()
    has_style_markup: bool = False


@dataclass(frozen=True)
class Failure:
    source: Path
    message: str


class Cancelled(Exception):
    pass


def check_cancel(cancel: Event | None) -> None:
    if cancel and cancel.is_set():
        raise Cancelled("操作已取消；已经导出的文件会保留。")


def decode(data: bytes, encoding: str) -> tuple[str, str]:
    if encoding not in ENCODINGS:
        raise SubtitleError("不支持的输入编码。")
    if encoding == "auto":
        encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        text = data.decode(encoding)
    except UnicodeError:
        raise SubtitleError("无法按所选编码读取；请手动选择 GB18030、Big5 等编码后重新预览。") from None
    if "\x00" in text:
        raise SubtitleError("内容含 NUL 字符，可能是无 BOM 的 UTF-16 或非文本文件。")
    return text, encoding


def read_source(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise SubtitleError("请选择普通 SRT/TXT 文件，不支持链接或目录。")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE_BYTES:
            raise SubtitleError("单文件上限为 64 MiB。")
        data = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(data) > MAX_FILE_BYTES:
        raise SubtitleError("单文件上限为 64 MiB。")
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise SubtitleError("读取期间来源发生变化，请重新预览。")
    return data


def prepare(path: Path, options: Options) -> Prepared:
    path = path.absolute()
    expected = {".txt", ".srt"} if options.mode == "clean" else {".srt"}
    if path.suffix.lower() not in expected:
        raise SubtitleError("此功能需要 SRT 文件；TXT 文件请使用「TXT 字幕清理」。")
    data = read_source(path)
    digest = hashlib.sha256(data).hexdigest()
    if options.mode == "raw":
        try:
            text, encoding = decode(data, options.encoding)
            warnings = ()
        except SubtitleError:
            text = "当前编码无法显示预览。原样转换仍完整保留原始字节；可切换输入编码查看内容。"
            encoding = "未解码"
            warnings = (text,)
        return Prepared(path, digest, data, text, encoding, None, "_original.txt", warnings)
    text, encoding = decode(data, options.encoding)
    if options.output_encoding not in {"utf-8", "utf-8-sig", "utf-16"}:
        raise SubtitleError("不支持的输出编码。")
    warnings = []
    count = None
    if options.mode == "clean":
        result = clean_txt(text)
        suffix = "_clean.txt"
    elif options.mode in {"text", "range"}:
        cues = parse_srt(text)
        if any(a.start > b.start for a, b in zip(cues, cues[1:])):
            warnings.append("原字幕时间顺序不递增，已保留原文顺序。")
        if any(a.end > b.start for a, b in zip(cues, cues[1:])):
            warnings.append("原字幕存在时间重叠，未自动合并。")
        if options.mode == "range":
            cues = select_range(cues, options.start, options.end, policy=options.policy,
                                clip=options.clip, rebase=options.rebase, offset=options.offset)
        count = len(cues)
        if options.mode == "range" and options.output_format == "srt":
            result = render_srt(cues)
            suffix = "_range.srt"
        else:
            if options.output_format not in {"srt", "txt"}:
                raise SubtitleError("未知导出格式。")
            result = "\n\n".join(c.text for c in cues)
            suffix = "_range.txt" if options.mode == "range" else "_text.txt"
    else:
        raise SubtitleError("未知处理模式。")
    if suffix.endswith(".txt"):
        result = plain_text(result, strip_tags=options.strip_tags, layout=options.layout)
    if not result.strip():
        raise SubtitleError("处理后没有正文；未生成空文件。")
    return Prepared(path, digest, result.encode(options.output_encoding), result, encoding,
                    count, suffix, tuple(warnings))


def prepare_batch(paths: list[Path], options: Options, cancel: Event | None = None,
                  progress: Callable[[int, int, str], None] = lambda *_: None) -> list[Prepared | Failure]:
    results = []
    total_bytes = 0
    seen = set()
    for i, path in enumerate(paths):
        check_cancel(cancel)
        key = os.path.normcase(str(path.absolute()))
        if key in seen:
            continue
        seen.add(key)
        try:
            if total_bytes + path.stat().st_size > MAX_BATCH_BYTES:
                raise SubtitleError("批次输入上限为 256 MiB，请分批处理。")
            # Count attempted inputs too; retained previews never exceed the input budget.
            total_bytes += path.stat().st_size
            result = prepare(path, options)
        except (OSError, ValueError) as exc:
            result = Failure(path, str(exc))
        results.append(result)
        progress(i+1, len(paths), path.name)
    return results


def export_one(item: Prepared, directory: Path, cancel: Event | None = None) -> Path:
    """Publish atomically with Windows rename / POSIX link; never replace a path."""
    check_cancel(cancel)
    if hashlib.sha256(read_source(item.source)).hexdigest() != item.fingerprint:
        raise SubtitleError("来源已在预览后修改，请重新预览。")
    directory = directory.resolve(strict=True)
    if not directory.is_dir():
        raise SubtitleError("输出位置不是文件夹。")
    fd, name = tempfile.mkstemp(prefix=".srttools-", suffix=".tmp", dir=directory)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(item.data)
            stream.flush()
            os.fsync(stream.fileno())
        check_cancel(cancel)
        base = item.source.stem[:160]
        for number in range(1, 10001):
            candidate = directory / f"{base}{'' if number == 1 else f' ({number})'}{item.suffix}"
            try:
                # rename on Windows fails if destination exists; no hardlink requirement
                # means USB FAT/exFAT exports also work.
                if os.name == "nt":
                    os.rename(temporary, candidate)
                else:
                    os.link(temporary, candidate)
                return candidate
            except FileExistsError:
                continue
        raise SubtitleError("同名输出过多，请选择另一个文件夹。")
    finally:
        temporary.unlink(missing_ok=True)


def export_batch(items: list[Prepared], directory: Path, cancel: Event | None = None,
                 progress: Callable[[int, int, str], None] = lambda *_: None) -> list[Path | Failure]:
    results = []
    for i, item in enumerate(items):
        if cancel and cancel.is_set():
            results.extend(Failure(rest.source, "已取消，未导出。") for rest in items[i:])
            break
        try:
            results.append(export_one(item, directory, cancel))
        except (OSError, ValueError, Cancelled) as exc:
            results.append(Failure(item.source, str(exc)))
        progress(i+1, len(items), item.source.name)
    return results
