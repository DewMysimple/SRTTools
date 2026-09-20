from pathlib import Path
from threading import Event

import pytest

from srttools.service import Failure, Options, Prepared
from srttools.workflow import discover, export_documents, prepare_documents


@pytest.fixture
def source(tmp_path):
    source = tmp_path / "input" / "lesson.srt"
    source.parent.mkdir()
    source.write_bytes(b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:03,000\r\nHello\r\n2026\r\n")
    return source


@pytest.mark.parametrize("kind,suffix", [("text", ".txt"), ("copy", ".srt"), ("raw", ".txt")])
def test_direct_output_no_classification_folders_and_source_unchanged(source, tmp_path, kind, suffix):
    raw = source.read_bytes()
    items = prepare_documents([source], Options(), kind)
    assert list(source.parent.iterdir()) == [source]
    assert isinstance(items[0], Prepared)
    result = export_documents(items, tmp_path, {})[0]
    assert result == tmp_path / ("lesson" + suffix)
    assert result.read_bytes() == (b"Hello\n2026\n" if kind == "text" else raw)
    assert source.read_bytes() == raw
    assert not any((tmp_path / name).exists() for name in ("Text", "Original", "Clean", "SRT"))


def test_conflicts_and_saving_into_input_folder_never_overwrite(source):
    items = prepare_documents([source], Options(), "copy")
    raw = source.read_bytes()
    first = export_documents(items, source.parent, {})[0]
    second = export_documents(items, source.parent, {})[0]
    assert first.name == "lesson (2).srt" and second.name == "lesson (3).srt"
    assert source.read_bytes() == first.read_bytes() == second.read_bytes() == raw


def test_relative_structure_and_same_name_collision(source, tmp_path):
    other = source.parent / "other" / source.name
    other.parent.mkdir()
    other.write_bytes(source.read_bytes())
    output = tmp_path / "out"
    output.mkdir()
    items = prepare_documents([source, other], Options())
    paths = export_documents(items, output, {source: Path("课程"), other: Path("课程")})
    assert [path.relative_to(output).as_posix() for path in paths] == ["课程/lesson.txt", "课程/lesson (2).txt"]


def test_scan_all_named_directories_only_excludes_chosen_output(source):
    for name in ("Text", "SRT", "Original", "Clean", "nested"):
        folder = source.parent / name
        folder.mkdir()
        (folder / "old.srt").write_bytes(source.read_bytes())
    (source.parent / "notes.txt").write_text("notes", encoding="utf-8")
    assert len(discover(source.parent, False).paths) == 2
    assert len(discover(source.parent, True).paths) == 7
    assert len(discover(source.parent, True, excluded=source.parent / "nested").paths) == 6
    cancel = Event()
    cancel.set()
    result = discover(source.parent, True, cancel)
    assert not result.paths and result.issues


def test_scan_reports_permission_errors(source, monkeypatch):
    import srttools.workflow as workflow
    monkeypatch.setattr(workflow.os, "scandir", lambda *_: (_ for _ in ()).throw(PermissionError("denied")))
    result = discover(source.parent, True)
    assert not result.paths and "denied" in result.issues[0].message


def test_stale_preview_makes_no_output_directory(source, tmp_path):
    items = prepare_documents([source], Options())
    source.write_text("changed", encoding="utf-8")
    assert isinstance(export_documents(items, tmp_path, {source: Path("new")})[0], Failure)
    assert not (tmp_path / "new").exists()


def test_srt_and_txt_share_body_processing_but_bad_srt_is_not_silently_cleaned(source):
    invalid = source.parent / "bad.srt"
    invalid.write_bytes(b"not valid")
    txt = source.parent / "notes.txt"
    txt.write_bytes(source.read_bytes())
    items = prepare_documents([source, invalid, txt], Options())
    assert isinstance(items[0], Prepared) and isinstance(items[1], Failure)
    assert items[2].preview == items[0].preview == "Hello\n2026\n"
    assert isinstance(prepare_documents([invalid], Options(), "copy")[0], Prepared)
    assert isinstance(prepare_documents([txt], Options(), "copy")[0], Failure)
    assert isinstance(prepare_documents([txt], Options(), "raw")[0], Failure)


def test_partial_failure_and_cancel_preserve_success(source, tmp_path, monkeypatch):
    import srttools.workflow as workflow
    sources = [source]
    for name in ("bad", "last"):
        path = source.parent / (name + ".srt")
        path.write_bytes(source.read_bytes())
        sources.append(path)
    items = prepare_documents(sources, Options())
    original = workflow.export_one
    def partial(item, directory, cancel):
        if item.source.stem == "bad":
            raise PermissionError("denied")
        return original(item, directory, cancel)
    monkeypatch.setattr(workflow, "export_one", partial)
    results = export_documents(items, tmp_path, {})
    assert isinstance(results[0], Path) and isinstance(results[1], Failure) and isinstance(results[2], Path)
    cancel = Event()
    results = export_documents(items, tmp_path, {}, cancel, lambda *_: cancel.set())
    assert isinstance(results[0], Path) and all(isinstance(item, Failure) for item in results[1:])
    assert all(path.exists() for path in sources)


def test_output_obstacle_traversal_and_bad_operation_rejected(source, tmp_path):
    items = prepare_documents([source], Options())
    (tmp_path / "obstacle").write_text("keep", encoding="utf-8")
    assert isinstance(export_documents(items, tmp_path, {source: Path("obstacle")})[0], Failure)
    for relative in (Path("../escape"), Path("C:/escape"), Path("C:escape")):
        with pytest.raises(ValueError, match="相对目录"):
            export_documents(items, tmp_path, {source: relative})
    with pytest.raises(ValueError, match="未知"):
        prepare_documents([source], Options(), "invalid")


def test_symlink_scan_and_output_blocked(source, tmp_path):
    link = tmp_path / "link"
    try:
        link.symlink_to(source.parent, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    with pytest.raises(ValueError, match="链接"):
        discover(link, True)
    with pytest.raises(ValueError, match="链接"):
        export_documents(prepare_documents([source], Options()), link, {})
    assert any("链接" in issue.message for issue in discover(tmp_path, True).issues)


def test_duplicate_paths_input_limit_and_cancelled_preview(source, monkeypatch):
    import srttools.workflow as workflow
    assert len(prepare_documents([source, source], Options())) == 1
    cancel = Event()
    cancel.set()
    assert isinstance(prepare_documents([source], Options(), cancel=cancel)[0], Failure)
    monkeypatch.setattr(workflow, "MAX_BATCH_BYTES", 1)
    assert isinstance(prepare_documents([source], Options())[0], Failure)


def test_output_budget_counts_encoded_bytes(source, monkeypatch):
    import srttools.workflow as workflow
    source.write_text("1\n00:00:01,000 --> 00:00:03,000\n" + "a" * 100, encoding="utf-8")
    monkeypatch.setattr(workflow, "MAX_BATCH_BYTES", source.stat().st_size)
    item = prepare_documents([source], Options(output_encoding="utf-16"))[0]
    assert isinstance(item, Failure) and "输出预览" in item.message


def test_output_link_introduced_after_preview_is_rejected(source, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    items = prepare_documents([source], Options())
    try:
        (tmp_path / "sub").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    assert isinstance(export_documents(items, tmp_path, {source: Path("sub")})[0], Failure)
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("fmt,timed", [("txt", False), ("txt", True), ("srt", True), ("srt", False)])
@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16"])
@pytest.mark.parametrize("strip", [False, True])
def test_document_formats_timestamps_and_styling_are_independent(source, tmp_path, fmt, timed, encoding, strip):
    from srttools.subtitles import parse_srt
    raw = "1\n00:00:01,000 --> 00:00:03,000\n<i>Hello &amp; world</i>\n2026\n"
    source.write_text(raw, encoding="utf-8", newline="")
    item = prepare_documents([source], Options(output_format=fmt, include_timestamps=timed,
                             output_encoding=encoding, strip_tags=strip), "document")[0]
    assert isinstance(item, Prepared) and item.has_style_markup
    assert ("-->" in item.preview) == (timed or fmt == "srt")
    assert ("<i>" in item.preview) != strip and ("&amp;" in item.preview) != strip
    assert item.preview.endswith("2026\n") and item.suffix == "." + fmt
    if timed or fmt == "srt":
        cues = parse_srt(item.preview)
        assert len(cues) == 1 and (cues[0].start, cues[0].end) == (1000, 3000)
    assert item.data == item.preview.encode(encoding)
    output = tmp_path / "not-created-by-preview" / "nested"
    assert not output.exists()
    result = export_documents([item], output, {})[0]
    assert result.read_bytes() == item.data
    assert source.read_text(encoding="utf-8") == raw


def test_timed_txt_requires_real_times_but_accepts_srt_structure_in_txt(source):
    txt = source.with_suffix(".txt")
    txt.write_text("正文 2026", encoding="utf-8")
    opts = Options(output_format="txt", include_timestamps=True)
    item = prepare_documents([txt], opts, "document")[0]
    assert isinstance(item, Failure) and "不能为普通 TXT" in item.message
    txt.write_bytes(source.read_bytes())
    assert isinstance(prepare_documents([txt], opts, "document")[0], Prepared)
    assert isinstance(prepare_documents([txt], Options(output_format="srt"), "document")[0], Prepared)


def test_no_style_markers_unknown_tags_and_no_cue_loss(source):
    source.write_text("1\n00:00:01,000 --> 00:00:03,000\n<unknown>2026</unknown>", encoding="utf-8")
    item = prepare_documents([source], Options(output_format="txt", strip_tags=True), "document")[0]
    assert not item.has_style_markup and item.preview == "<unknown>2026</unknown>\n"
    source.write_text("1\n00:00:01,000 --> 00:00:03,000\n<i></i>", encoding="utf-8")
    item = prepare_documents([source], Options(output_format="srt", strip_tags=True), "document")[0]
    assert isinstance(item, Failure) and "正文为空" in item.message


def test_new_output_root_not_created_for_stale_cancelled_or_invalid_mapping(source, tmp_path):
    items = prepare_documents([source], Options(output_format="txt"), "document")
    output = tmp_path / "new-root"
    with pytest.raises(ValueError, match="相对目录"):
        export_documents(items, output, {source: Path("../escape")})
    assert not output.exists()
    cancel = Event()
    cancel.set()
    assert isinstance(export_documents(items, output, {}, cancel)[0], Failure)
    assert not output.exists()
    source.write_text("changed", encoding="utf-8")
    assert isinstance(export_documents(items, output, {})[0], Failure)
    assert not output.exists()
