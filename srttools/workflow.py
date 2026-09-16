"""Composable SRT workspace tasks, read-only discovery and planned safe exports."""
from dataclasses import dataclass, replace
import hashlib
import os
from pathlib import Path
from threading import Event

from .service import (Cancelled, Failure, MAX_BATCH_BYTES, Options, Prepared,
                      check_cancel, export_one, prepare, read_source)
from .subtitles import SubtitleError

TASKS = {"text": "提取正文", "archive": "归档 SRT", "raw": "原样 TXT", "clean": "清理 TXT"}
OUTPUT_FOLDERS = {"text", "srt", "original", "clean"}


def linked(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def validate_directory(path: Path) -> None:
    """Reject links/junctions in every existing ancestor, including dangling links."""
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
                        if recursive and entry.name.casefold() not in OUTPUT_FOLDERS and path != excluded:
                            pending.append(path)
                    elif entry.is_file(follow_symlinks=False) and path.suffix.lower() in {".srt", ".txt"}:
                        paths.append(path)
            progress(len(paths), max(1, len(paths)), directory.name)
        except (OSError, ValueError, Cancelled) as exc:
            issues.append(Failure(directory, str(exc)))
    return Discovery(tuple(sorted(paths)), tuple(issues))


@dataclass(frozen=True)
class PlanItem:
    source: Path
    task: str
    target: Path
    result: Prepared | Failure | None
    message: str = ""


def plan(paths: list[Path], tasks: tuple[str, ...], options: Options,
         output: Path | None, relatives: dict[Path, Path],
         cancel: Event | None = None, progress=lambda *_: None) -> list[PlanItem]:
    if not tasks or any(task not in TASKS for task in tasks):
        raise SubtitleError("请至少勾选一项工作台任务。")
    if output is not None:
        output = output.absolute()
        validate_directory(output)
        if not output.is_dir():
            raise SubtitleError("请选择已存在的输出文件夹。")
    results, seen = [], set()
    input_size = output_size = 0
    for index, original in enumerate(paths):
        path = original.absolute()
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        relative = relatives.get(path, Path())
        if relative.is_absolute() or ".." in relative.parts:
            raise SubtitleError("无效的扫描相对目录。")
        base = output / relative if output is not None else path.parent
        source_error = None
        try:
            validate_directory(path.parent)
            input_size += path.stat().st_size
            if input_size > MAX_BATCH_BYTES:
                raise SubtitleError("批次输入上限为 256 MiB，请分批处理。")
        except (OSError, ValueError) as exc:
            source_error = str(exc)
        fingerprint = None
        for task in tasks:
            directory = base / {"text": "Text", "archive": "Text/SRT" if "text" in tasks else "SRT",
                                "raw": "Original", "clean": "Clean"}[task]
            suffix = ".srt" if task == "archive" else ".txt"
            target = directory / (path.stem[:160] + suffix)
            if cancel and cancel.is_set():
                result = Failure(path, "已取消，未预览。")
            elif path.suffix.lower() not in ({".srt", ".txt"} if task == "clean" else {".srt"}):
                results.append(PlanItem(path, task, target, None, "不适用：此任务需要 SRT"))
                continue
            else:
                try:
                    if source_error:
                        raise SubtitleError(source_error)
                    validate_directory(directory)
                    if task == "archive":
                        data = read_source(path)
                        result = Prepared(path, hashlib.sha256(data).hexdigest(), data,
                                          "按原始字节复制 SRT；不移动、不改写来源。", "原始编码", None, suffix)
                    else:
                        result = replace(prepare(path, replace(options, mode=task)), suffix=suffix)
                    if fingerprint is not None and fingerprint != result.fingerprint:
                        raise SubtitleError("准备多个任务期间来源改变，请重新预览。")
                    fingerprint = result.fingerprint
                    output_size += len(result.data)
                    if output_size > MAX_BATCH_BYTES:
                        raise SubtitleError("组合任务的输出预览上限为 256 MiB，请分批处理。")
                except (OSError, ValueError) as exc:
                    result = Failure(path, str(exc))
            results.append(PlanItem(path, task, target, result))
        progress(index + 1, len(paths), path.name)
    return results


def execute(items: list[PlanItem], cancel: Event | None = None, progress=lambda *_: None) -> list[Path | Failure]:
    results = []
    for index, item in enumerate(items):
        if not isinstance(item.result, Prepared):
            continue
        try:
            check_cancel(cancel)
            # Check stale inputs before even creating the output directories.
            if hashlib.sha256(read_source(item.source)).hexdigest() != item.result.fingerprint:
                raise SubtitleError("来源已在预览后修改，请重新预览。")
            validate_directory(item.target.parent)
            item.target.parent.mkdir(parents=True, exist_ok=True)
            validate_directory(item.target.parent)
            results.append(export_one(item.result, item.target.parent, cancel))
        except (OSError, ValueError, Cancelled) as exc:
            results.append(Failure(item.source, f"{TASKS[item.task]}：{exc}"))
        progress(index + 1, len(items), item.source.name)
    return results
