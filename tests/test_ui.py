import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from pathlib import Path
from threading import Event

import pytest
from PySide6.QtWidgets import QApplication

from srttools.smoke import wait_task
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
    page = window.pages[1]
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
        for i, page in enumerate(window.pages):
            window.navigation.setCurrentRow(i)
            app.processEvents()
            scroll = window.stack.widget(i)
            assert scroll.horizontalScrollBar().maximum() == 0
            if height >= 900:
                assert scroll.verticalScrollBar().maximum() == 0
            scroll.ensureWidgetVisible(page.export_button)
            app.processEvents()
            assert scroll.viewport().rect().contains(page.export_button.mapTo(scroll.viewport(), page.export_button.rect().center()))
