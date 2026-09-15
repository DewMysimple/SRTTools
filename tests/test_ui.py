import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from pathlib import Path
from threading import Event

import pytest
from PySide6.QtWidgets import QApplication

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


def test_stale_options_disable_export_and_latest_logs_stay_first(app, window, tmp_path):
    source = tmp_path / "example.srt"
    source.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello", encoding="utf-8")
    page = window.pages[0]
    page.mode_choice.setCurrentIndex(1)
    page.add_files([source])
    page.prepare()
    wait_task(app, window)
    assert page.export_button.isEnabled()
    page.strip_tags.setChecked(True)
    assert not page.export_button.isEnabled() and not page.results
    for i in range(320):
        window.log(f"record-{i}")
    assert window.logs.toPlainText().splitlines()[0].endswith("record-319")
    assert len(window.logs.toPlainText().splitlines()) == 300
    assert window.logs.verticalScrollBar().value() == 0


def test_task_close_requests_cancel_and_prevents_second_task(app, window):
    entered = Event()
    def operation(cancel, progress):
        entered.set()
        assert cancel.wait(5)
        return []
    window.start_task(operation, lambda _: None)
    assert entered.wait(5)
    worker = window.worker
    window.start_task(lambda *_: None, lambda _: None)
    assert window.worker is worker
    assert not window.close()
    wait_task(app, window)
    assert window.isVisible() and window.worker is None


def test_all_pages_width_and_scroll_to_actions(app, window):
    for width, height in ((980, 620), (1180, 900), (1600, 1000)):
        window.resize(width, height)
        for i, mode in ((0, "raw"), (0, "text"), (0, "clean"), (1, "range")):
            page = window.pages[i]
            window.navigation.setCurrentRow(i)
            if mode != "range":
                page.mode_choice.setCurrentIndex(page.mode_choice.findData(mode))
            app.processEvents()
            scroll = window.stack.widget(i)
            assert scroll.horizontalScrollBar().maximum() == 0
            if window.height() >= 900:
                assert scroll.verticalScrollBar().maximum() == 0
            scroll.ensureWidgetVisible(page.export_button)
            app.processEvents()
            assert scroll.viewport().rect().contains(page.export_button.mapTo(scroll.viewport(), page.export_button.rect().center()))
            assert page.table.horizontalScrollBar().maximum() == 0
    window.showMaximized()
    app.processEvents()
    for i in range(2):
        window.navigation.setCurrentRow(i)
        app.processEvents()
        assert window.stack.widget(i).horizontalScrollBar().maximum() == 0


def test_unified_toolbar_preserves_files_and_exports_all_three_modes(app, window, tmp_path):
    assert window.navigation.count() == window.stack.count() == len(window.pages) == 2
    assert window.navigation.item(0).text() == "文本转换"
    assert window.pages[1].mode == "range"
    source = tmp_path / "example.srt"
    raw = b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Hello</i>\r\n2026\r\n"
    source.write_bytes(raw)
    page = window.pages[0]
    page.add_files([source])
    page.output.setText(str(tmp_path))
    for mode, suffix in (("text", "_text.txt"), ("raw", "_original.txt"), ("clean", "_clean.txt")):
        page.mode_choice.setCurrentIndex(page.mode_choice.findData(mode))
        page.strip_tags.setChecked(True)
        page.layout_choice.setCurrentIndex(1)
        assert page.paths == [source] and page.output.text() == str(tmp_path)
        assert page.output_encoding.isEnabled() == (mode != "raw")
        assert page.strip_tags.isEnabled() == page.layout_choice.isEnabled() == (mode != "raw")
        page.prepare()
        wait_task(app, window)
        assert isinstance(page.results[0], Prepared)
        assert page.results[0].suffix == suffix
        page.export()
        wait_task(app, window)
        output = (tmp_path / (source.stem + suffix)).read_bytes()
        assert output == (raw if mode == "raw" else b"Hello 2026\n")
        assert source.read_bytes() == raw


def test_mode_switch_invalidates_preview_and_keeps_text_preferences(app, window, tmp_path):
    source = tmp_path / "example.txt"
    source.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello", encoding="utf-8")
    page = window.pages[0]
    page.mode_choice.setCurrentIndex(2)
    page.strip_tags.setChecked(True)
    page.layout_choice.setCurrentIndex(2)
    page.output_encoding.setCurrentIndex(1)
    page.add_files([source])
    page.prepare()
    wait_task(app, window)
    assert page.export_button.isEnabled()
    page.mode_choice.setCurrentIndex(0)
    assert not page.results and not page.preview.toPlainText() and not page.export_button.isEnabled()
    assert page.table.item(0, 2).text() == "—"
    page.prepare()
    wait_task(app, window)
    assert isinstance(page.results[0], Failure)  # TXT is not silently treated as SRT.
    page.mode_choice.setCurrentIndex(2)
    assert page.strip_tags.isChecked() and page.layout_choice.currentIndex() == 2
    assert page.output_encoding.currentIndex() == 1
    page.output.setText(str(tmp_path))
    page.reset_button.click()
    assert page.mode == "clean" and page.paths == [source] and page.output.text() == str(tmp_path)
    assert page.options().encoding == "auto" and page.options().output_encoding == "utf-8"
    assert page.options().layout == "keep" and not page.options().strip_tags


def test_toolbar_locked_during_task_and_range_reset(app, window):
    window.start_task(lambda cancel, _: cancel.wait(5), lambda _: None)
    page = window.pages[0]
    assert not page.mode_choice.isEnabled() and not page.reset_button.isEnabled()
    window.cancel_task()
    wait_task(app, window)
    assert page.mode_choice.isEnabled() and page.reset_button.isEnabled()
    page = window.pages[1]
    window.navigation.setCurrentRow(1)
    page.start.setText("5")
    page.end.setText("10")
    page.rebase.setChecked(True)
    page.clip.setChecked(False)
    page.offset.setValue(200)
    page.output_format.setCurrentIndex(1)
    page.strip_tags.setChecked(True)
    page.reset_button.click()
    options = page.options()
    assert (options.start, options.end, options.offset) == (120000, 180000, 0)
    assert options.clip and not options.rebase and options.output_format == "srt"
    assert page.output_encoding.isEnabled() and not page.strip_tags.isEnabled()
