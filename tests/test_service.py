from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest

from srttools.cli import main
from srttools.service import Failure, Options, Prepared, export_batch, export_one, prepare, prepare_batch
from srttools.subtitles import SubtitleError

TEXT = "1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>中文</i>\r\n2026\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n再见\r\n"


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "字幕.srt"
    path.write_bytes(TEXT.encode("utf-8-sig"))
    return path


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "gb18030", "big5"])
def test_raw_exact_bytes_all_encodings(source, tmp_path, encoding):
    data = TEXT.replace("再见", "再見").encode(encoding)
    source.write_bytes(data)
    item = prepare(source, Options(encoding=encoding))
    target = export_one(item, tmp_path)
    assert target.suffix == ".txt" and target.read_bytes() == data
    assert source.read_bytes() == data


def test_clean_srt_and_preconverted_txt(source, tmp_path):
    raw = export_one(prepare(source, Options()), tmp_path)
    result = prepare(raw, Options(mode="clean", strip_tags=True))
    assert result.preview == "中文\n2026\n\n再见\n"
    extracted = prepare(source, Options(mode="text", strip_tags=True))
    assert extracted.preview == result.preview
    assert extracted.cue_count == 2


@pytest.mark.parametrize("fmt", ["srt", "txt"])
def test_range_outputs(source, fmt):
    item = prepare(source, Options(mode="range", start=2000, end=4000, rebase=True, output_format=fmt))
    assert item.cue_count == 1 and "再见" not in item.preview
    assert ("00:00:00,000 --> 00:00:01,000" in item.preview) == (fmt == "srt")
    assert item.suffix.endswith("." + fmt)


def test_existing_files_and_source_never_overwritten(source, tmp_path):
    item = prepare(source, Options())
    first = export_one(item, tmp_path)
    first.write_bytes(b"precious")
    second = export_one(item, tmp_path)
    assert first.read_bytes() == b"precious"
    assert second != first and second.read_bytes() == source.read_bytes()
    assert not list(tmp_path.glob(".srttools-*.tmp"))


def test_stale_preview_no_output(source, tmp_path):
    item = prepare(source, Options(mode="text"))
    source.write_bytes(b"changed")
    with pytest.raises(SubtitleError, match="修改"):
        export_one(item, tmp_path)
    assert list(tmp_path.iterdir()) == [source]


def test_encoding_failure_requires_choice(source):
    source.write_bytes(TEXT.encode("gb18030"))
    with pytest.raises(SubtitleError, match="编码"):
        prepare(source, Options(mode="text"))
    assert "中文" in prepare(source, Options(mode="text", encoding="gb18030")).preview


def test_batch_failures_do_not_hide_valid_results(source, tmp_path):
    invalid = tmp_path / "bad.srt"
    invalid.write_text("bad", encoding="utf-8")
    results = prepare_batch([source, invalid], Options(mode="text"))
    assert isinstance(results[0], Prepared) and isinstance(results[1], Failure)
    cancel = Event()
    cancel.set()
    exported = export_batch([results[0]], tmp_path, cancel)
    assert isinstance(exported[0], Failure) and not list(tmp_path.glob("*.txt"))


def test_write_failure_cleans_temporary_without_touching_source(source, tmp_path, monkeypatch):
    import srttools.service as service
    original = source.read_bytes()
    def fail(*_):
        raise PermissionError("denied")
    monkeypatch.setattr(service.os, "rename" if service.os.name == "nt" else "link", fail)
    with pytest.raises(PermissionError):
        export_one(prepare(source, Options()), tmp_path)
    assert list(tmp_path.iterdir()) == [source] and source.read_bytes() == original


def test_cli_preview_zero_write_and_export(source, tmp_path, capsys):
    assert main(["text", str(source)]) == 0
    assert list(tmp_path.iterdir()) == [source]
    assert main(["range", str(source), "--start", "2", "--end", "3", "--format", "txt", "-o", str(tmp_path)]) == 0
    assert (tmp_path / "字幕_range.txt").exists()
    assert main(["range", str(source), "--start", "99", "--end", "100"]) == 1


def test_limits_and_duplicate_inputs(source, monkeypatch):
    import srttools.service as service
    assert len(prepare_batch([source, source], Options())) == 1
    monkeypatch.setattr(service, "MAX_FILE_BYTES", 2)
    assert isinstance(prepare_batch([source], Options())[0], Failure)


def test_overlap_warning_keeps_source_order(source):
    source.write_text("1\n00:00:02,000 --> 00:00:04,000\na\n\n2\n00:00:01,000 --> 00:00:03,000\nb", encoding="utf-8")
    item = prepare(source, Options(mode="text"))
    assert len(item.warnings) == 2 and item.preview == "a\n\nb\n"


def test_raw_undecodable_still_preserves_bytes(source, tmp_path):
    source.write_bytes(b'\xff\x80\x81\x00')
    item = prepare(source, Options())
    assert item.warnings
    assert export_one(item, tmp_path).read_bytes() == source.read_bytes()


def test_cancel_after_first_export_preserves_completed_file(source, tmp_path):
    second = tmp_path / "second.srt"
    second.write_bytes(source.read_bytes())
    items = [prepare(p, Options(mode="text")) for p in (source, second)]
    cancel = Event()
    results = export_batch(items, tmp_path, cancel, lambda *_: cancel.set())
    assert isinstance(results[0], Path) and isinstance(results[1], Failure)
    assert results[0].exists() and not (tmp_path / "second_text.txt").exists()


def test_two_sources_same_stem_get_distinct_outputs(source, tmp_path):
    directory = tmp_path / "nested"
    directory.mkdir()
    second = directory / source.name
    second.write_bytes(source.read_bytes())
    items = [prepare(p, Options()) for p in (source, second)]
    results = export_batch(items, tmp_path)
    assert len(set(results)) == 2 and all(isinstance(p, Path) and p.exists() for p in results)
