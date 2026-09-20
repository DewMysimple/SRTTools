"""Exercise the document workspace and range exports offscreen on disposable data."""
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from PySide6.QtWidgets import QFileDialog

from .service import Prepared

DEMO = "1\n00:01:58,000 --> 00:02:02,000\n欢迎来到字幕工作台。\n\n2\n00:02:15,500 --> 00:02:18,000\n<i>把重要的片段，留下来。</i>\nKeep the moments that matter.\n\n3\n00:02:58,000 --> 00:03:05,000\n从字幕到文字，只需几步。\n\n4\n00:04:00,000 --> 00:04:03,000\n阅读、整理，然后保存。\n"


def wait_task(app, window):
    deadline = time.monotonic() + 30
    while window.worker is not None:
        app.processEvents()
        if time.monotonic() > deadline:
            window.cancel_task()
            raise RuntimeError("后台任务未在 30 秒内完成")
        time.sleep(0.005)
    app.processEvents()


def check_layout(app, window, screenshot=None):
    for width, height in ((980, 620), (1180, 900), (1600, 1000)):
        window.resize(width, height)
        for i, page in enumerate(window.pages):
            window.navigation.setCurrentRow(i)
            for expanded in (False, True) if i == 0 else (False,):
                if i == 0:
                    page.settings_button.setChecked(expanded)
                app.processEvents()
                app.processEvents()
                scroll = window.stack.widget(i)
                assert scroll.horizontalScrollBar().maximum() == 0, (width, height, i, expanded)
                if window.height() >= 900 and not expanded:
                    assert scroll.verticalScrollBar().maximum() == 0, (width, height, i)
                assert page.table.horizontalScrollBar().maximum() == 0
                scroll.ensureWidgetVisible(page.export_button)
                app.processEvents()
                assert scroll.viewport().rect().contains(page.export_button.mapTo(scroll.viewport(), page.export_button.rect().center()))
                if screenshot:
                    assert window.grab().save(str(screenshot.with_name(f"page-{i}-{width}-{'open' if expanded else 'closed'}.png")))
    window.showMaximized()
    app.processEvents()
    for i in range(len(window.pages)):
        window.navigation.setCurrentRow(i)
        app.processEvents()
        assert window.stack.widget(i).horizontalScrollBar().maximum() == 0
    window.showNormal()


def run_smoke(app, window, screenshot: Path):
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="srttools-smoke-") as directory:
        root = Path(directory)
        inputs = root / "input"
        lesson = inputs / "课程一"
        lesson.mkdir(parents=True)
        source = lesson / "01 开始阅读.srt"
        source.write_text(DEMO, encoding="utf-8", newline="")
        (lesson / "02 留下重要的片段.srt").write_text(DEMO, encoding="utf-8")
        (lesson / "03 整理为文字.txt").write_text("2026\n把零散的字幕，整理成可以阅读的文字。", encoding="utf-8")
        raw = source.read_bytes()
        output = root / "output"
        output.mkdir()
        page = window.pages[0]
        page.add_files([inputs])
        wait_task(app, window)
        assert len(page.results) == 3 and all(isinstance(item, Prepared) for item in page.results)
        assert list(output.iterdir()) == []
        with patch.object(QFileDialog, "getExistingDirectory", return_value=str(output)):
            page.export_button.click()
            wait_task(app, window)
            exported = output / "课程一" / "01 开始阅读.txt"
            assert "-->" not in exported.read_text(encoding="utf-8")
            assert not (output / "Text").exists()
            page.save_other("copy")
            wait_task(app, window)
            assert (output / "课程一" / source.name).read_bytes() == raw
            assert "未保存 1" in page.summary.text()  # TXT is not an SRT copy.
            page.save_other("raw")
            wait_task(app, window)
            assert (output / "课程一" / "01 开始阅读 (2).txt").read_bytes() == raw
        assert source.read_bytes() == raw

        page = window.pages[1]
        window.navigation.setCurrentRow(1)
        page.add_files([source])
        page.output.setText(str(output))
        page.rebase.setChecked(True)
        for fmt in (0, 1):
            page.output_format.setCurrentIndex(fmt)
            page.strip_tags.setChecked(True)
            page.prepare()
            wait_task(app, window)
            assert len(page.results) == 1 and isinstance(page.results[0], Prepared)
            assert "阅读、整理" not in page.results[0].preview
            if fmt == 0:
                assert "00:00:00,000 --> 00:00:02,000" in page.results[0].preview
            else:
                assert "<i>" not in page.results[0].preview
            page.export()
            wait_task(app, window)
        assert (output / "01 开始阅读_range.srt").exists() and (output / "01 开始阅读_range.txt").exists()
        assert source.read_bytes() == raw

        check_layout(app, window, screenshot)
        window.resize(1180, 900)
        window.navigation.setCurrentRow(0)
        page = window.pages[0]
        page.settings_button.setChecked(False)
        page.strip_tags.setChecked(True)
        page.prepare()
        wait_task(app, window)
        page.table.selectRow(0)
        # All visible strings are public demo data, never private paths.
        window.logs.clear()
        window.log("已读取 3 个文件，正文预览就绪。原文件保持不变。")
        window.stack.widget(0).verticalScrollBar().setValue(0)
        app.processEvents()
        app.processEvents()
        assert window.grab().save(str(screenshot))
