import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from pathlib import Path
from threading import Event

import pytest
from PySide6.QtWidgets import QApplication, QComboBox

from srttools.smoke import wait_task
from srttools.service import Prepared
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
    page.beside.setChecked(True)
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
        for i in range(2):
            page = window.pages[i]
            window.navigation.setCurrentRow(i)
            for expanded in (False, True):
                if i == 0:
                    page.settings_button.setChecked(expanded)
                app.processEvents()
                app.processEvents()
                scroll = window.stack.widget(i)
                assert scroll.horizontalScrollBar().maximum() == 0
                if window.height() >= 900 and not expanded:
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


def test_visible_composable_tasks_export_together(app, window, tmp_path):
    assert window.navigation.count() == len(window.pages) == 2
    assert window.navigation.item(0).text() == "SRT 综合工作台"
    page = window.pages[0]
    assert not hasattr(page, "mode_choice")
    assert len(page.findChildren(QComboBox)) == 3
    assert all(toggle.isVisible() for toggle in page.tasks.values())
    source = tmp_path / "example.srt"
    raw = b"\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Hello</i>\r\n2026\r\n"
    source.write_bytes(raw)
    page.add_files([source])
    page.output.setText(str(tmp_path))
    for toggle in page.tasks.values():
        toggle.setChecked(True)
    page.strip_tags.setChecked(True)
    page.layout_choice.setCurrentIndex(1)
    page.prepare()
    wait_task(app, window)
    assert len(page.results) == 4
    assert all(isinstance(item.result, Prepared) for item in page.results)
    page.export()
    wait_task(app, window)
    for directory, name in (("Text/SRT", "example.srt"), ("Original", "example.txt")):
        assert (tmp_path / directory / name).read_bytes() == raw
    for directory in ("Text", "Clean"):
        assert (tmp_path / directory / "example.txt").read_bytes() == b"Hello 2026\n"
    assert source.read_bytes() == raw
    assert not page.export_button.isEnabled()
    assert all(page.table.item(row, 2).text() == "已完成" for row in range(4))


def test_task_or_output_change_invalidates_plan_and_preserves_inputs(app, window, tmp_path):
    source = tmp_path / "example.txt"
    source.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello", encoding="utf-8")
    page = window.pages[0]
    page.tasks["clean"].setChecked(True)
    page.strip_tags.setChecked(True)
    page.layout_choice.setCurrentIndex(2)
    page.output_encoding.setCurrentIndex(1)
    page.add_files([source])
    page.output.setText(str(tmp_path))
    page.prepare()
    wait_task(app, window)
    assert page.results[0].result is None
    assert isinstance(page.results[1].result, Prepared)
    page.tasks["raw"].setChecked(True)
    assert not page.results and not page.preview.toPlainText() and not page.export_button.isEnabled()
    assert page.paths == [source] and page.strip_tags.isChecked()
    page.prepare()
    wait_task(app, window)
    page.beside.setChecked(True)
    assert not page.results and not page.export_button.isEnabled()
    page.reset_button.click()
    assert page.selected_tasks() == ("text",) and page.paths == [source]
    assert page.output.text() == str(tmp_path) and page.beside.isChecked()
    assert page.options().encoding == "auto" and page.options().output_encoding == "utf-8"
    assert page.options().layout == "keep" and not page.options().strip_tags


def test_folder_scan_recursion_and_relative_output(app, window, tmp_path):
    source = tmp_path / "input" / "lesson"
    source.mkdir(parents=True)
    (source / "demo.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nHello", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    page = window.pages[0]
    page.output.setText(str(output))
    page.add_files([source.parent])
    wait_task(app, window)
    assert len(page.paths) == 1 and page.relatives[page.paths[0]] == Path("lesson")
    page.prepare()
    wait_task(app, window)
    assert page.results[0].target == output / "lesson" / "Text" / "demo.txt"
    page.export()
    wait_task(app, window)
    assert (output / "lesson" / "Text" / "demo.txt").read_text() == "Hello\n"
    page.clear_files()
    page.recursive.setChecked(False)
    page.add_files([source.parent])
    wait_task(app, window)
    assert page.paths == []


def test_toolbar_locked_during_task_and_range_reset(app, window):
    window.start_task(lambda cancel, _: cancel.wait(5), lambda _: None)
    page = window.pages[0]
    assert not page.folder_button.isEnabled() and not page.reset_button.isEnabled()
    assert all(not toggle.isEnabled() for toggle in page.tasks.values())
    window.cancel_task()
    wait_task(app, window)
    assert page.folder_button.isEnabled() and page.reset_button.isEnabled()
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


def test_raw_and_archive_ignore_text_settings_and_no_task_cannot_run(app, window, tmp_path):
    page = window.pages[0]
    page.strip_tags.setChecked(True)
    page.output_encoding.setCurrentIndex(2)
    page.tasks["text"].setChecked(False)
    page.tasks["raw"].setChecked(True)
    page.tasks["archive"].setChecked(True)
    assert not page.output_encoding.isEnabled() and not page.layout_choice.isEnabled() and not page.strip_tags.isEnabled()
    source = tmp_path / "bad.srt"
    source.write_bytes(b"\xff\x80undecodable")
    page.add_files([source])
    page.beside.setChecked(True)
    page.prepare()
    wait_task(app, window)
    assert len(page.results) == 2 and all(item.result.data == source.read_bytes() for item in page.results)
    page.tasks["text"].setChecked(True)
    assert page.output_encoding.isEnabled() and page.output_encoding.currentIndex() == 2
    assert page.strip_tags.isChecked()
    for toggle in page.tasks.values():
        toggle.setChecked(False)
    page.prepare()
    assert window.worker is None and not page.results and not page.export_button.isEnabled()
