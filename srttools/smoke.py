"""Exercise real combinable workspace and range workflows on disposable data."""
from pathlib import Path
import tempfile
import time

from .service import Prepared

DEMO = "1\n00:01:58,000 --> 00:02:02,000\n欢迎来到字幕工作台。\n\n2\n00:02:15,500 --> 00:02:18,000\n<i>把重要的片段，留下来。</i>\nKeep the moments that matter.\n\n3\n00:02:58,000 --> 00:03:05,000\n从字幕到文字，只需几步。\n\n4\n00:04:00,000 --> 00:04:03,000\n这是范围之外的字幕。\n"


def wait_task(app, window):
    deadline = time.monotonic() + 30
    while window.worker is not None:
        app.processEvents()
        if time.monotonic() > deadline:
            window.cancel_task()
            raise RuntimeError("后台任务未在 30 秒内完成")
        time.sleep(0.005)
    app.processEvents()


def run_smoke(app, window, screenshot: Path):
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="srttools-smoke-") as directory:
        root = Path(directory)
        inputs = root / "input"
        inputs.mkdir()
        lesson = inputs / "课程一"
        lesson.mkdir()
        source = lesson / "演示字幕.srt"
        source.write_text(DEMO, encoding="utf-8", newline="")
        raw = source.read_bytes()
        output = root / "output"
        output.mkdir()
        page = window.pages[0]
        page.output.setText(str(output))
        page.add_files([inputs])
        wait_task(app, window)
        assert page.paths == [source]
        for toggle in page.tasks.values():
            toggle.setChecked(True)
        page.prepare()
        wait_task(app, window)
        assert len(page.results) == 4 and all(isinstance(item.result, Prepared) for item in page.results)
        assert list(output.iterdir()) == []  # Preview is read-only.
        page.export()
        wait_task(app, window)
        exports = output / "课程一"
        assert (exports / "Text/SRT/演示字幕.srt").read_bytes() == raw
        assert (exports / "Original/演示字幕.txt").read_bytes() == raw
        for folder in ("Text", "Clean"):
            text = (exports / folder / "演示字幕.txt").read_text(encoding="utf-8")
            assert "-->" not in text and "Keep the moments" in text
        assert source.read_bytes() == raw

        # The reference script's archive-only path is SRT/, not Text/SRT/.
        for task, toggle in page.tasks.items():
            toggle.setChecked(task == "archive")
        page.prepare()
        wait_task(app, window)
        page.export()
        wait_task(app, window)
        assert (exports / "SRT/演示字幕.srt").read_bytes() == raw

        page.clear_files()
        page.add_files([exports / "Original/演示字幕.txt"])
        for task, toggle in page.tasks.items():
            toggle.setChecked(task == "clean")
        page.prepare()
        wait_task(app, window)
        assert "-->" not in page.results[0].result.preview
        page.export()
        wait_task(app, window)
        assert (output / "Clean/演示字幕.txt").exists()

        # Independent time-range workspace still supports both output formats.
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
            assert "范围之外" not in page.results[0].preview
            if fmt == 0:
                assert "00:00:00,000 --> 00:00:02,000" in page.results[0].preview
            else:
                assert "<i>" not in page.results[0].preview
            page.export()
            wait_task(app, window)
        assert (output / "演示字幕_range.srt").exists() and (output / "演示字幕_range.txt").exists()
        assert source.read_bytes() == raw

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
                        assert scroll.verticalScrollBar().maximum() == 0, (width, height, i, window.size(), scroll.verticalScrollBar().maximum())
                    assert page.table.horizontalScrollBar().maximum() == 0
                    scroll.ensureWidgetVisible(page.export_button)
                    app.processEvents()
                    assert scroll.viewport().rect().contains(page.export_button.mapTo(scroll.viewport(), page.export_button.rect().center()))
                    assert window.grab().save(str(screenshot.with_name(f"page-{i}-{width}-{'open' if expanded else 'closed'}.png")))
        window.showMaximized()
        app.processEvents()
        for i in range(len(window.pages)):
            window.navigation.setCurrentRow(i)
            app.processEvents()
            assert window.stack.widget(i).horizontalScrollBar().maximum() == 0
        window.showNormal()
        window.resize(1180, 900)
        window.navigation.setCurrentRow(0)
        page = window.pages[0]
        page.clear_files()
        page.add_files([inputs])
        wait_task(app, window)
        for task, toggle in page.tasks.items():
            toggle.setChecked(task in {"text", "archive"})
        page.settings_button.setChecked(False)
        page.strip_tags.setChecked(True)
        page.prepare()
        wait_task(app, window)
        # Sanitize display-only fields after validation; no private paths in docs.
        page.output.blockSignals(True)
        page.output.setText("演示输出")
        page.output.blockSignals(False)
        for row, item in enumerate(page.results):
            relative = item.target.relative_to(output)
            page.table.item(row, 1).setText("演示输出/" + relative.as_posix())
        page.table.clearSelection()
        page.preview.setPlainText("提取正文 → 演示输出/课程一/Text/演示字幕.txt\n\n" + page.results[0].result.preview)
        window.logs.clear()
        window.log("任务计划：提取正文 + 归档 SRT，共 2 项就绪；来源文件保留。")
        window.stack.widget(0).verticalScrollBar().setValue(0)
        app.processEvents()
        assert window.grab().save(str(screenshot))
