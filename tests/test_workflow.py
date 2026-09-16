from pathlib import Path
from threading import Event

import pytest

from srttools.service import Failure, Options, Prepared
from srttools.workflow import discover, execute, plan


@pytest.fixture
def source(tmp_path):
    source = tmp_path / "input" / "lesson.srt"
    source.parent.mkdir()
    source.write_bytes(b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:03,000\r\nHello\r\n2026\r\n")
    return source


@pytest.mark.parametrize("tasks,folders", [
    (("text",), ("Text",)),
    (("archive",), ("SRT",)),
    (("raw",), ("Original",)),
    (("clean",), ("Clean",)),
    (("text", "archive"), ("Text", "Text/SRT")),
    (("text", "archive", "raw", "clean"), ("Text", "Text/SRT", "Original", "Clean")),
])
def test_reference_workflows_zero_write_preview_and_copy_archive(source, tasks, folders):
    raw = source.read_bytes()
    items = plan([source], tasks, Options(), None, {})
    assert list(source.parent.iterdir()) == [source]
    assert [item.target.parent.relative_to(source.parent).as_posix() for item in items] == list(folders)
    results = execute(items)
    assert len(results) == len(tasks) and all(isinstance(result, Path) for result in results)
    for task, result in zip(tasks, results):
        if task in {"archive", "raw"}:
            assert result.read_bytes() == raw
        else:
            assert result.read_text(encoding="utf-8") == "Hello\n2026\n"
    assert source.read_bytes() == raw


def test_conflicts_merge_without_overwrite_and_repeated_exports(source):
    items = plan([source], ("text", "archive"), Options(), None, {})
    for item in items:
        item.target.parent.mkdir(parents=True, exist_ok=True)
        item.target.write_bytes(b"precious")
    results = execute(items)
    assert all(isinstance(result, Path) and "(2)" in result.name for result in results)
    assert all(item.target.read_bytes() == b"precious" for item in items)
    again = execute(items)
    assert all("(3)" in result.name for result in again)


def test_scan_scope_excludes_generated_folders_and_handles_cancel(source):
    nested = source.parent / "nested"
    nested.mkdir()
    (nested / "more.srt").write_bytes(source.read_bytes())
    (source.parent / "notes.txt").write_text("notes", encoding="utf-8")
    for name in ("Text", "SRT", "Original", "Clean"):
        folder = source.parent / name
        folder.mkdir()
        (folder / "old.srt").write_bytes(source.read_bytes())
    assert len(discover(source.parent, False).paths) == 2
    assert len(discover(source.parent, True).paths) == 3
    assert len(discover(source.parent, True, excluded=nested).paths) == 2
    cancel = Event()
    cancel.set()
    result = discover(source.parent, True, cancel)
    assert not result.paths and result.issues


def test_scan_reports_permission_errors(source, monkeypatch):
    import srttools.workflow as workflow
    monkeypatch.setattr(workflow.os, "scandir", lambda *_: (_ for _ in ()).throw(PermissionError("denied")))
    result = discover(source.parent, True)
    assert not result.paths and "denied" in result.issues[0].message


def test_stale_plan_makes_no_output_directory(source):
    items = plan([source], ("text", "archive"), Options(), None, {})
    source.write_text("changed", encoding="utf-8")
    assert all(isinstance(item, Failure) for item in execute(items))
    assert list(source.parent.iterdir()) == [source]


def test_mixed_inputs_and_failed_extraction_keep_independent_archive(source):
    invalid = source.parent / "bad.srt"
    invalid.write_bytes(b"not valid")
    txt = source.parent / "notes.txt"
    txt.write_text("2026\nnotes", encoding="utf-8")
    items = plan([invalid, txt], ("text", "archive", "clean"), Options(), None, {})
    assert isinstance(items[0].result, Failure)
    assert isinstance(items[1].result, Prepared)
    assert items[3].result is None and items[4].result is None
    assert items[5].result.preview == "2026\nnotes\n"
    results = execute(items)
    assert len(results) == 3 and all(isinstance(result, Path) for result in results)


def test_partial_failure_and_cancel_preserve_success(source, monkeypatch):
    import srttools.workflow as workflow
    items = plan([source], ("text", "archive", "raw"), Options(), None, {})
    original = workflow.export_one
    def partial(item, directory, cancel):
        if directory.name == "SRT":
            raise PermissionError("denied")
        return original(item, directory, cancel)
    monkeypatch.setattr(workflow, "export_one", partial)
    results = execute(items)
    assert isinstance(results[0], Path) and isinstance(results[1], Failure) and isinstance(results[2], Path)
    cancel = Event()
    results = execute(items, cancel, lambda *_: cancel.set())
    assert isinstance(results[0], Path) and all(isinstance(item, Failure) for item in results[1:])
    assert source.exists()


def test_output_obstacle_and_traversal_rejected(source, tmp_path):
    (source.parent / "Text").write_text("keep", encoding="utf-8")
    assert isinstance(plan([source], ("text",), Options(), None, {})[0].result, Failure)
    with pytest.raises(ValueError, match="相对目录"):
        plan([source], ("text",), Options(), tmp_path, {source: Path("../escape")})
    with pytest.raises(ValueError, match="至少"):
        plan([source], (), Options(), None, {})


def test_symlink_scan_and_output_blocked(source, tmp_path):
    link = tmp_path / "link"
    try:
        link.symlink_to(source.parent, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    with pytest.raises(ValueError, match="链接"):
        discover(link, True)
    with pytest.raises(ValueError, match="链接"):
        plan([source], ("text",), Options(), link, {})
    assert any("链接" in issue.message for issue in discover(tmp_path, True).issues)


def test_duplicate_paths_and_memory_limits(source, monkeypatch):
    import srttools.workflow as workflow
    assert len(plan([source, source], ("text",), Options(), None, {})) == 1
    monkeypatch.setattr(workflow, "MAX_BATCH_BYTES", 1)
    assert isinstance(plan([source], ("text",), Options(), None, {})[0].result, Failure)


def test_cancelled_preview_and_output_budget(source, monkeypatch):
    import srttools.workflow as workflow
    cancel = Event()
    cancel.set()
    items = plan([source], ("raw", "archive"), Options(), None, {}, cancel)
    assert all(isinstance(item.result, Failure) for item in items)
    assert list(source.parent.iterdir()) == [source]
    monkeypatch.setattr(workflow, "MAX_BATCH_BYTES", len(source.read_bytes()) + 1)
    items = plan([source], ("raw", "archive"), Options(), None, {})
    assert isinstance(items[0].result, Prepared)
    assert isinstance(items[1].result, Failure) and "输出预览" in items[1].result.message


def test_output_link_introduced_after_preview_is_rejected(source, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    items = plan([source], ("text",), Options(), None, {})
    try:
        (source.parent / "Text").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    assert isinstance(execute(items)[0], Failure)
    assert list(outside.iterdir()) == []
