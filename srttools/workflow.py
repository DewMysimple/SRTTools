"""Read-only subtitle discovery, document preparation and direct-folder export."""
from dataclasses import dataclass, replace
import hashlib
import os
from pathlib import Path
from threading import Event

from .service import (Cancelled, Failure, MAX_BATCH_BYTES, Options, Prepared,
                      check_cancel, export_one, prepare, read_source)
from .subtitles import SubtitleError


def linked(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def validate_directory(path: Path) -> None:
    for parent in (path, *path.parents):
        if linked(parent):
            raise SubtitleError("路径包含链接或目录联接，不允许扫描或输出。")
        if parent.exists() and not parent.is_dir():
            raise SubtitleError("目录位置已被普通文件占用。")


@dataclass(frozen=True)
class Discovery:
    paths: tuple[Path, ...]
    issues: tuple[Failure, ...]


def discover(root: Path, recursive: bool, cancel: Event | None = None,
             progress=lambda *_: None, excluded: Path | None = None) -> Discovery:
    root = root.absolute()
    validate_directory(root)
    if not root.is_dir():
        raise SubtitleError("扫描位置不是文件夹。")
    paths, issues = [], []
    pending = [root]
    while pending:
        if cancel and cancel.is_set():
            issues.append(Failure(root, "扫描已取消，列表仅包含已发现文件。"))
            break
        directory = pending.pop()
        try:
            validate_directory(directory)
            with os.scandir(directory) as entries:
                for entry in sorted(entries, key=lambda e: e.name.casefold()):
                    check_cancel(cancel)
                    path = Path(entry.path)
                    if linked(path):
                        issues.append(Failure(path, "已跳过链接或目录联接。"))
                    elif entry.is_dir(follow_symlinks=False):
                        if recursive and path != excluded:
                            pending.append(path)
                    elif entry.is_file(follow_symlinks=False) and path.suffix.lower() in {".srt", ".txt"}:
                        paths.append(path)
            progress(len(paths), max(1, len(paths)), directory.name)
        except (OSError, ValueError, Cancelled) as exc:
            issues.append(Failure(directory, str(exc)))
    return Discovery(tuple(sorted(paths)), tuple(issues))


def prepare_documents(paths: list[Path], options: Options, kind: str = "text",
                      cancel: Event | None = None, progress=lambda *_: None) -> list[Prepared | Failure]:
    """One result per input. TXT cleanup is automatic, not a separate user task."""
    if kind not in {"text", "copy", "raw"}:
        raise SubtitleError("未知导出操作。")
    results, seen = [], set()
    input_size = output_size = 0
    for index, original in enumerate(paths):
        path = original.absolute()
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        try:
            check_cancel(cancel)
            validate_directory(path.parent)
            allowed = {".srt", ".txt"} if kind == "text" else {".srt"}
            if path.suffix.lower() not in allowed:
                raise SubtitleError("此操作只接受 SRT 字幕。" if kind != "text" else "请选择 SRT 或 TXT 文件。")
            input_size += path.stat().st_size
            if input_size > MAX_BATCH_BYTES:
                raise SubtitleError("批次输入上限为 256 MiB，请分批处理。")
            if kind == "copy":
                data = read_source(path)
                result = Prepared(path, hashlib.sha256(data).hexdigest(), data,
                                  "复制原字幕，保留原文件。", "原始编码", None, ".srt")
            else:
                mode = "raw" if kind == "raw" else "clean" if path.suffix.lower() == ".txt" else "text"
                result = replace(prepare(path, replace(options, mode=mode)), suffix=".txt")
            output_size += len(result.data)
            if output_size > MAX_BATCH_BYTES:
                raise SubtitleError("输出预览上限为 256 MiB，请分批处理。")
        except (OSError, ValueError, Cancelled) as exc:
            result = Failure(path, str(exc))
        results.append(result)
        progress(index + 1, len(paths), path.name)
    return results


def export_documents(items: list[Prepared | Failure], output: Path, relatives: dict[Path, Path],
                     cancel: Event | None = None, progress=lambda *_: None) -> list[Path | Failure]:
    """Save directly in the chosen folder, retaining only scanned relative paths."""
    output = output.absolute()
    validate_directory(output)
    if not output.is_dir():
        raise SubtitleError("请选择已存在的保存位置。")
    # Validate every relative mapping before any writes, even for later rows.
    for item in items:
        relative = relatives.get(item.source, Path())
        if relative.is_absolute() or relative.drive or ".." in relative.parts:
            raise SubtitleError("无效的扫描相对目录。")
    results = []
    for index, item in enumerate(items):
        if isinstance(item, Failure):
            results.append(item)
        else:
            try:
                check_cancel(cancel)
                validate_directory(item.source.parent)
                if hashlib.sha256(read_source(item.source)).hexdigest() != item.fingerprint:
                    raise SubtitleError("来源已在预览后修改，请重新预览。")
                directory = output / relatives.get(item.source, Path())
                validate_directory(directory)
                directory.mkdir(parents=True, exist_ok=True)
                validate_directory(directory)
                results.append(export_one(item, directory, cancel))
            except (OSError, ValueError, Cancelled) as exc:
                results.append(Failure(item.source, str(exc)))
        progress(index + 1, len(items), item.source.name)
    return results
