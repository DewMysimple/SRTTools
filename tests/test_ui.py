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
    assert not hasattr(page, "more_button")
    assert page.output_format.currentText() == "纯文本 · .txt"
    assert not window.logs.isVisible() and not window.task_status.isVisible()
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
    assert page.export_button.isEnabled()  # Re-export the same immutable preview.
    assert page.table.item(0, 1).text() == "已保存"
    assert page.table.item(0, 1).toolTip() == str(tmp_path / "example.txt")


def test_cancel_destination_is_zero_write_and_keeps_preview(app, window, source, tmp_path, monkeypatch):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: "")
    page.export()
    assert window.worker is None and page.export_button.isEnabled()
    assert list(tmp_path.iterdir()) == [source]


def test_settings_live_update_and_reset_preserves_sources(app, window, source):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    page.strip_tags.setChecked(True)
    assert not page.results and not page.export_button.isEnabled()
    wait_task(app, window)
    assert page.preview.toPlainText() == "Hello\n2026\n"
    page.layout_choice.setCurrentIndex(2)
    page.output_encoding.setCurrentIndex(1)
    page.reset_options()
    assert page.paths == [source] and page.options().layout == "keep"
    assert page.options().output_encoding == "utf-8" and not page.options().strip_tags
    assert not page.export_button.isEnabled()
    wait_task(app, window)
    assert page.preview.toPlainText() == "<i>Hello</i>\n2026\n"


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


def test_every_format_requires_real_preview_before_export(app, window, source, tmp_path, monkeypatch):
    source.write_bytes(b"\xff\x80undecodable")
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    assert isinstance(page.results[0], Failure)
    page.output_encoding.setCurrentIndex(2)
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    for kind, name in ((1, "example (2).srt"), (2, "example.txt")):
        page.encoding.setCurrentIndex(0)
        page.output_format.setCurrentIndex(kind)
        wait_task(app, window)
        assert isinstance(page.results[0], Failure) and not page.export_button.isEnabled()
        page.export()
        assert not (tmp_path / name).exists()
        page.encoding.setCurrentIndex(5)  # Explicit cp1252 decoding makes the bytes readable.
        wait_task(app, window)
        assert page.preview.toPlainText() == source.read_bytes().decode("cp1252")
        assert not page.output_encoding.isEnabled() and not page.layout_choice.isEnabled()
        page.export()
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
    page.live.on_idle()
    assert window.worker is None and page.scan_status.isVisible()
    assert not page.results and not page.live.pending


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
    assert not page.output_format.isEnabled() and not page.settings_button.isEnabled()
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


@pytest.mark.parametrize("layout", [0, 1, 2])
@pytest.mark.parametrize("encoding", [0, 1, 2])
def test_live_settings_export_exact_preview_bytes(app, window, source, tmp_path, monkeypatch, layout, encoding):
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    page.settings_button.click()
    page.strip_tags.click()
    page.layout_choice.setCurrentIndex(layout)
    page.output_encoding.setCurrentIndex(encoding)
    # No manual prepare, refresh, or event handler call.
    assert not page.export_button.isEnabled() and not page.results
    wait_task(app, window)
    expected = page.preview.toPlainText()
    assert "<i>" not in expected and "-->" not in expected
    if layout == 2:
        assert expected == "Hello 2026\n"
    elif layout == 1:
        assert expected == "Hello 2026\n"
    else:
        assert expected == "Hello\n2026\n"
    item = page.results[0]
    assert item.data == expected.encode(page.output_encoding.currentData())
    assert page.document_title.text() == "example.txt"
    assert page.output_encoding.currentText() in page.document_info.text()
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    page.export_button.click()
    wait_task(app, window)
    assert (tmp_path / "example.txt").read_bytes() == item.data


@pytest.mark.parametrize("fmt,suffix", [(1, ".srt"), (2, ".txt")])
@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "gb18030"])
def test_raw_formats_preview_and_export_same_bom_crlf_bytes(app, window, source, tmp_path, monkeypatch, fmt, suffix, encoding):
    content = "1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>你好</i>\r\n2026\r\n"
    raw = content.encode(encoding)
    source.write_bytes(raw)
    page = window.pages[0]
    page.output_format.setCurrentIndex(fmt)
    if encoding == "gb18030":
        page.encoding.setCurrentIndex(3)
    page.add_files([source])
    wait_task(app, window)
    assert page.preview.toPlainText() == content.replace("\r\n", "\n")
    assert page.results[0].data == raw
    assert page.document_title.text().endswith(suffix)
    assert not page.strip_tags.isEnabled() and not page.output_encoding.isEnabled()
    output = tmp_path / "out"
    output.mkdir()
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(output))
    page.export_button.click()
    wait_task(app, window)
    assert (output / ("example" + suffix)).read_bytes() == raw == source.read_bytes()


def test_full_long_text_is_accessible_and_no_pagination_labels_exported(app, window, tmp_path, monkeypatch):
    source = tmp_path / "long.txt"
    content = "每一行都保留 😀\n\n" * 12_000 + "这是结尾\n"
    source.write_text(content, encoding="utf-8", newline="")
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    reader = page.preview
    assert reader.number.maximum() > 2 and reader.navigation.isVisible()
    pages = []
    for number in range(1, reader.number.maximum() + 1):
        reader.number.setValue(number)
        pages.append(reader.toPlainText())
    expected = "".join(pages)
    assert expected == page.results[0].preview and expected.endswith("这是结尾\n")
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    page.export_button.click()
    wait_task(app, window)
    assert (tmp_path / "long (2).txt").read_bytes() == expected.encode("utf-8")
    assert source.read_text(encoding="utf-8") == content


def test_edits_during_preview_discard_old_completion_and_coalesce(app, window, source, monkeypatch):
    import srttools.workbench as workbench
    actual = workbench.prepare_documents
    entered, release = Event(), Event()
    calls, applied = [], []
    def slow(paths, options, kind, cancel, progress):
        calls.append((kind, options))
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
            # Intentionally return a stale successful result despite cancellation.
            return actual(paths, options, kind)
        return actual(paths, options, kind, cancel, progress)
    monkeypatch.setattr(workbench, "prepare_documents", slow)
    page = window.pages[0]
    original = page.prepared
    def record(results):
        applied.append(results)
        original(results)
    monkeypatch.setattr(page, "prepared", record)
    page.add_files([source])
    page.live.start()
    assert entered.wait(5)
    assert page.output_format.isEnabled() and page.settings_button.isEnabled()
    assert page.strip_tags.isEnabled() and not page.add_button.isEnabled()
    try:
        page.output_format.setCurrentIndex(1)
        page.output_format.setCurrentIndex(2)
        page.output_format.setCurrentIndex(0)
        page.strip_tags.setChecked(True)
        page.layout_choice.setCurrentIndex(2)
        assert window.worker.cancel.is_set()
        assert not page.export_button.isEnabled()
        assert not page.results and page.preview.toPlainText() == ""
    finally:
        release.set()
    wait_task(app, window)
    assert len(calls) == 2 and len(applied) == 1
    assert page.preview.toPlainText() == "Hello 2026\n"
    assert calls[-1][1].strip_tags and calls[-1][1].layout == "paragraph"


def test_cancel_pending_live_preview_does_not_restart(app, window, source, monkeypatch):
    import srttools.workbench as workbench
    entered = Event()
    def slow(paths, options, kind, cancel, progress):
        entered.set()
        assert cancel.wait(5)
        return []
    monkeypatch.setattr(workbench, "prepare_documents", slow)
    page = window.pages[0]
    page.add_files([source])
    page.live.start()
    assert entered.wait(5)
    page.strip_tags.setChecked(True)
    window.cancel_task()
    wait_task(app, window)
    assert not page.results and not page.live.pending and not page.export_button.isEnabled()
    assert "取消" in page.summary.text()


def test_preview_worker_failure_is_visible_and_next_edit_recovers(app, window, source, monkeypatch):
    import srttools.workbench as workbench
    original = workbench.prepare_documents
    monkeypatch.setattr(workbench, "prepare_documents", lambda *_: (_ for _ in ()).throw(RuntimeError("test failure")))
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    assert "test failure" in page.summary.text() and not page.export_button.isEnabled()
    monkeypatch.setattr(workbench, "prepare_documents", original)
    page.strip_tags.setChecked(True)
    wait_task(app, window)
    assert page.preview.toPlainText() == "Hello\n2026\n" and page.export_button.isEnabled()


def test_export_uses_prepared_snapshot_and_failure_stays_visible_with_logs_closed(app, window, source, tmp_path, monkeypatch):
    import srttools.workbench as workbench
    page = window.pages[0]
    page.add_files([source])
    wait_task(app, window)
    item = page.results[0]
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_: str(tmp_path))
    monkeypatch.setattr(workbench, "prepare_documents", lambda *_: pytest.fail("Export must not regenerate content"))
    page.export_button.click()
    wait_task(app, window)
    assert (tmp_path / "example.txt").read_bytes() == item.data
    monkeypatch.setattr(workbench, "export_documents", lambda *_: (_ for _ in ()).throw(PermissionError("denied")))
    page.export_button.click()
    wait_task(app, window)
    assert not window.logs.isVisible() and "导出失败：denied" in page.summary.text()
    assert (tmp_path / "example.txt").read_bytes() == item.data


def test_clear_and_close_cancel_debounced_work(app, window, source):
    page = window.pages[0]
    page.add_files([source])
    assert page.live.timer.isActive()
    page.clear_files()
    wait_task(app, window)
    assert not page.results and not page.live.pending
    page.add_files([source])
    assert window.worker is None and page.live.pending
    window.close()
    assert not page.live.pending and not page.live.timer.isActive()


def test_preview_callbacks_stay_on_gui_thread_through_gc_and_repeated_edits(app, window, source, monkeypatch):
    import gc
    from PySide6.QtCore import QThread
    import srttools.workbench as workbench
    page = window.pages[0]
    actual, apply = workbench.prepare_documents, page.prepared
    entered, release = Event(), Event()
    applied = []
    def slow(*args):
        assert QThread.currentThread() != app.thread()
        entered.set()
        assert release.wait(5)
        return actual(*args)
    def on_result(results):
        assert QThread.currentThread() == app.thread()
        applied.append(results)
        apply(results)
    monkeypatch.setattr(workbench, "prepare_documents", slow)
    monkeypatch.setattr(page, "prepared", on_result)
    page.add_files([source])
    for index in range(12):
        entered.clear()
        release.clear()
        page.layout_choice.setCurrentIndex(index % 3)
        page.live.start()
        assert entered.wait(5)
        try:
            gc.collect()
            app.processEvents()
            assert window.worker is not None
        finally:
            release.set()
        wait_task(app, window)
        assert window.task_callback is None and window.failure_callback is None
        assert page.export_button.isEnabled()
    assert len(applied) == 12


def test_range_live_update_invalid_input_recovery_and_export_parity(app, window, source, tmp_path):
    page = window.pages[1]
    window.navigation.setCurrentRow(1)
    page.start.setText("1")
    page.end.setText("2")
    page.add_files([source])
    wait_task(app, window)
    assert "-->" in page.preview.toPlainText()
    page.start.setText("invalid")
    assert not page.results and not page.export_button.isEnabled()
    wait_task(app, window)
    assert not page.export_button.isEnabled() and "更新" not in page.summary.text()
    page.start.setText("1")
    page.rebase.setChecked(True)
    page.output.setText(str(tmp_path))
    for fmt in (0, 1):
        page.output_format.setCurrentIndex(fmt)
        page.strip_tags.setChecked(True)
        page.output_encoding.setCurrentIndex(2)
        wait_task(app, window)
        item = page.results[0]
        assert item.preview == page.preview.toPlainText()
        if fmt == 0:
            assert "00:00:00,000 --> 00:00:01,000" in item.preview
        else:
            assert "-->" not in item.preview and "<i>" not in item.preview
        page.export_button.click()
        wait_task(app, window)
        assert (tmp_path / (source.stem + item.suffix)).read_bytes() == item.data == item.preview.encode("utf-16")
