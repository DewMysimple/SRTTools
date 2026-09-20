import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from pathlib import Path
from threading import Event

import pytest
from PySide6.QtWidgets import QApplication, QCheckBox, QFileDialog, QLabel

from srttools.smoke import wait_task
from srttools.service import Failure, Prepared
from srttools.ui import MainWindow


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def window(app):
    window = MainWindow()
    window.show()
    app.processEvents()
    yield window
    if window.worker:
        window.cancel_task()
        wait_task(app, window)
    window.close()


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "example.srt"
    path.write_bytes(b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Hello</i>\r\n2026\r\n")
    return path


def test_document_first_ui_no_task_combinations_or_english_routes(app, window):
    page = window.pages[0]
    assert window.navigation.item(0).text() == "字幕整理"
    assert not hasattr(page, "tasks") and not hasattr(page, "mode_choice")
    assert len(page.findChildren(QCheckBox)) == 2  # Recursion and formatting only.
    assert page.table.columnCount() == 2
    assert page.splitter.orientation().name == "Horizontal"
    assert not page.export_button.isEnabled()
    assert not page.more_button.isEnabled()
    for label in page.findChildren(QLabel):
        assert not any(word in label.text() for word in ("Text/", "Original/", "Clean/", "任务", "组合"))


def test_auto_preview_then_direct_export(app, window, source, tmp_path, monkeypatch):
    page = window.pages[0]
    before = source.read_bytes()
    page.add_files([source])
    wait_task(app, window)
    assert len(page.results) == 1 and isinstance(page.results[0], Prepared)
    assert page.preview.toPlainText() == "<i>Hello</i>\n2026\n"
    assert page.export_button.isEnabled() and not (tmp_path / "example.txt").exists()
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    page.export_button.click()
    wait_task(app, window)
    assert (tmp_path / "example.txt").read_text(encoding="utf-8") == page.preview.toPlainText()
    assert source.read_bytes() == before
    assert not page.export_button.isEnabled()
    assert page.table.item(0, 1).text() == "已保存"
    assert page.table.item(0, 1).toolTip() == str(tmp_path / "example.txt")


def test_cancel_destination_is_zero_write_and_keeps_preview(app, window, source, tmp_path, monkeypatch):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: "")
    page.export()
    page.save_other("copy")
    assert window.worker is None and page.export_button.isEnabled()
    assert list(tmp_path.iterdir()) == [source]


def test_settings_invalidate_and_reset_preserves_sources(app, window, source):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    page.strip_tags.setChecked(True)
    assert not page.results and not page.export_button.isEnabled()
    page.prepare()
    wait_task(app, window)
    assert page.preview.toPlainText() == "Hello\n2026\n"
    page.layout_choice.setCurrentIndex(2)
    page.output_encoding.setCurrentIndex(1)
    page.reset_options()
    assert page.paths == [source] and page.options().layout == "keep"
    assert page.options().output_encoding == "utf-8" and not page.options().strip_tags
    assert not page.export_button.isEnabled()


def test_stale_source_rejected_after_preview(app, window, source, tmp_path, monkeypatch):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    source.write_text("changed", encoding="utf-8")
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    page.export()
    wait_task(app, window)
    assert not (tmp_path / "example.txt").exists()
    assert "来源已在预览后修改" in page.table.item(0, 1).toolTip()


def test_secondary_actions_preserve_bytes_even_when_body_fails(app, window, source, tmp_path, monkeypatch):
    source.write_bytes(b"\xff\x80undecodable")
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    assert isinstance(page.results[0], Failure) and page.more_button.isEnabled()
    page.output_encoding.setCurrentIndex(2)
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    for kind, name in (("copy", "example (2).srt"), ("raw", "example.txt")):
        page.save_other(kind)
        wait_task(app, window)
        assert (tmp_path / name).read_bytes() == source.read_bytes()


def test_folder_scan_auto_preview_relative_output_and_nonrecursive(app, window, tmp_path, monkeypatch):
    inputs = tmp_path / "input"
    source = inputs / "课程" / "demo.srt"
    source.parent.mkdir(parents=True)
    source.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    page = window.pages[0]
    page.add_files([inputs])
    wait_task(app, window)
    assert page.paths == [source] and page.relatives[source] == Path("课程")
    assert page.export_button.isEnabled()
    assert page.table.item(0, 0).toolTip() == str(source)
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(output))
    page.export()
    wait_task(app, window)
    assert (output / "课程" / "demo.txt").read_text() == "Hello\n"
    page.clear_files()
    page.recursive.setChecked(False)
    page.add_files([inputs])
    wait_task(app, window)
    assert page.paths == [] and not page.results


def test_mixed_files_failure_visibility_selection_and_remove(app, window, source, tmp_path, monkeypatch):
    txt = tmp_path / "notes.txt"
    txt.write_text("2026\nnotes", encoding="utf-8")
    bad = tmp_path / "bad.srt"
    bad.write_text("bad", encoding="utf-8")
    page = window.pages[0]
    page.add_files([source, txt, bad])
    wait_task(app, window)
    assert len(page.results) == 3 and isinstance(page.results[2], Failure)
    page.table.selectRow(1)
    assert page.preview.toPlainText() == "2026\nnotes\n"
    page.table.selectRow(2)
    assert "无法生成" in page.document_info.text()
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    page.export()
    wait_task(app, window)
    assert "已保存 2" in page.summary.text() and "未保存 1" in page.summary.text()
    page.remove_files()
    wait_task(app, window)
    assert bad not in page.paths and bad.exists()


def test_scan_cancellation_has_visible_warning_and_does_not_auto_restart(app, window, source):
    from srttools.workflow import Discovery
    page = window.pages[0]
    page.scanned([(source.parent, Discovery((source,), (Failure(source.parent, "扫描已取消"),)))])
    page.on_idle()
    assert window.worker is None and page.scan_status.isVisible()
    assert not page.results and not page.pending_preview


def test_task_lock_close_and_latest_logs(app, window):
    entered = Event()
    def operation(cancel, progress):
        entered.set()
        assert cancel.wait(5)
        return []
    window.start_task(operation, lambda _: None)
    assert entered.wait(5)
    worker = window.worker
    page = window.pages[0]
    assert not page.add_button.isEnabled() and not page.remove_button.isEnabled()
    assert not page.more_button.isEnabled() and not page.settings_button.isEnabled()
    window.start_task(lambda *_: None, lambda _: None)
    assert window.worker is worker
    assert not window.close()
    wait_task(app, window)
    assert page.add_button.isEnabled() and window.isVisible()
    for i in range(320):
        window.log(f"record-{i}")
    assert window.logs.toPlainText().splitlines()[0].endswith("record-319")
    assert len(window.logs.toPlainText().splitlines()) == 300
    assert window.logs.verticalScrollBar().value() == 0


def test_all_pages_sizes_and_range_reset(app, window):
    from srttools.smoke import check_layout
    check_layout(app, window)
    page = window.pages[1]
    page.start.setText("5")
    page.end.setText("10")
    page.rebase.setChecked(True)
    page.clip.setChecked(False)
    page.offset.setValue(200)
    page.output_format.setCurrentIndex(1)
    page.reset_options()
    options = page.options()
    assert (options.start, options.end, options.offset) == (120000, 180000, 0)
    assert options.clip and not options.rebase and options.output_format == "srt"
