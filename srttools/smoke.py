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
    while window.worker is not None or any(page.live.pending or page.live.timer.isActive() for page in window.pages):
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
            app.processEvents()
            app.processEvents()
            scroll = page.scroll
            assert scroll.horizontalScrollBar().maximum() == 0, (width, height, i)
            if window.height() >= 900:
                assert scroll.verticalScrollBar().maximum() == 0, (width, height, i)
            assert page.table.horizontalScrollBar().maximum() == 0
            if i != 0:
                assert page.preview.height() >= 80 and page.table.height() >= 80
                scroll.ensureWidgetVisible(page.export_button)
            app.processEvents()
            assert window.rect().contains(page.export_button.mapTo(window, page.export_button.rect().center()))
            if i == 0:
                assert page.settings.isVisible() and page.output.isVisible()
                assert page.footer.geometry().height() < window.height() // 3
            if screenshot:
                assert window.grab().save(str(screenshot.with_name(f"page-{i}-{width}.png")))
    window.showMaximized()
    app.processEvents()
    for i in range(len(window.pages)):
        window.navigation.setCurrentRow(i)
        app.processEvents()
        assert window.pages[i].scroll.horizontalScrollBar().maximum() == 0
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
        page.output.setText(str(output))
        page.add_files([inputs])
        wait_task(app, window)
        assert len(page.results) == 3 and all(isinstance(item, Prepared) for item in page.results)
        assert list(output.iterdir()) == []
        with patch.object(QFileDialog, "getExistingDirectory", return_value=str(output)):
            page.export_button.click()
            wait_task(app, window)
            exported = output / "课程一" / "01 开始阅读.txt"
            assert exported.read_bytes() == page.results[0].data
            assert exported.read_text(encoding="utf-8") == page.preview.toPlainText()
            assert not (output / "Text").exists()
            page.output_format.setCurrentIndex(1)
            wait_task(app, window)
            assert page.timestamps.isChecked() and not page.timestamps.isEnabled()
            page.export()
            wait_task(app, window)
            assert (output / "课程一" / source.name).read_bytes() == page.results[0].data
            assert "未保存 1" in page.summary.text()  # Plain TXT cannot invent timestamps.
            page.output_format.setCurrentIndex(0)
            page.timestamps.setChecked(True)
            wait_task(app, window)
            page.export()
            wait_task(app, window)
            assert (output / "课程一" / "01 开始阅读 (2).txt").read_bytes() == page.results[0].data
        assert source.read_bytes() == raw

        # Real live changes (no explicit refresh) and the entire >50k preview.
        page.output_format.setCurrentIndex(0)
        page.timestamps.setChecked(False)
        page.layout_choice.setCurrentIndex(2)
        page.output_encoding.setCurrentIndex(2)
        page.strip_tags.setChecked(True)
        wait_task(app, window)
        assert page.results[0].data == page.preview.toPlainText().encode("utf-16")
        with patch.object(QFileDialog, "getExistingDirectory", return_value=str(output)):
            page.export_button.click()
            wait_task(app, window)
        assert (output / "课程一" / "01 开始阅读 (3).txt").read_bytes() == page.results[0].data
        page.reset_options()
        wait_task(app, window)

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
        # Pagination and long filenames must not crowd the narrow layout.
        page = window.pages[0]
        long_source = lesson / ("字幕示例的长文件名" * 8 + ".txt")
        long_source.write_text(("分页全文，结尾也能看到。\n" * 8000) + "全文结尾\n", encoding="utf-8")
        window.navigation.setCurrentRow(0)
        page.add_files([long_source])
        wait_task(app, window)
        page.table.selectRow(len(page.paths) - 1)
        reader = page.preview
        fragments = []
        for number in range(1, reader.number.maximum() + 1):
            reader.number.setValue(number)
            fragments.append(reader.toPlainText())
        assert "".join(fragments) == page.results[-1].preview
        assert fragments[-1].endswith("全文结尾\n")
        window.logs_button.setChecked(True)
        check_layout(app, window)
        window.logs_button.setChecked(False)
        page.remove_files()
        wait_task(app, window)
        window.resize(1180, 900)
        window.navigation.setCurrentRow(0)
        page = window.pages[0]
        page.output_format.setCurrentIndex(0)
        page.strip_tags.setChecked(True)
        wait_task(app, window)
        page.table.selectRow(0)
        # All visible strings are public demo data, never private paths.
        window.logs.clear()
        window.log("已读取 3 个文件，正文预览就绪。原文件保持不变。")
        page.scroll.verticalScrollBar().setValue(0)
        # Public screenshot must not show a personal account or temporary path.
        page.output.setText(r"D:\字幕输出")
        app.processEvents()
        app.processEvents()
        assert window.grab().save(str(screenshot))
