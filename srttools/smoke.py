"""Exercise all four real GUI workflows on generated, disposable input."""
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
        source = root / "演示字幕.srt"
        source.write_text(DEMO, encoding="utf-8", newline="")
        raw = source.read_bytes()
        for i, mode in ((0, "raw"), (0, "text"), (0, "clean"), (1, "range")):
            page = window.pages[i]
            window.navigation.setCurrentRow(i)
            if mode != "range":
                page.mode_choice.setCurrentIndex(page.mode_choice.findData(mode))
            page.add_files([source])
            page.output.setText(str(root))
            if page.mode == "range":
                page.rebase.setChecked(True)
            page.prepare()
            wait_task(app, window)
            assert len(page.results) == 1 and isinstance(page.results[0], Prepared), page.results
            expected = page.results[0].data
            suffix = page.results[0].suffix
            page.export()
            wait_task(app, window)
            assert (root / (source.stem + suffix)).read_bytes() == expected
            assert source.read_bytes() == raw
        assert (root / "演示字幕_original.txt").read_bytes() == raw
        cleaned = (root / "演示字幕_text.txt").read_text(encoding="utf-8")
        assert "-->" not in cleaned and "Keep the moments" in cleaned
        cropped = (root / "演示字幕_range.srt").read_text(encoding="utf-8")
        assert "00:00:00,000 --> 00:00:02,000" in cropped
        assert "范围之外" not in cropped
        # Exercise previously-converted TXT in the shared conversion workbench.
        page = window.pages[0]
        page.clear_files()
        page.add_files([root / "演示字幕_original.txt"])
        page.prepare()
        wait_task(app, window)
        assert "-->" not in page.results[0].preview
        # Range TXT uses the same selected cues and exposes cleanup controls.
        page = window.pages[1]
        page.output_format.setCurrentIndex(1)
        page.strip_tags.setChecked(True)
        page.prepare()
        wait_task(app, window)
        assert "<i>" not in page.results[0].preview and "范围之外" not in page.results[0].preview
        page.export()
        wait_task(app, window)
        assert (root / "演示字幕_range.txt").exists()

        for width, height in ((980, 620), (1180, 900), (1600, 1000)):
            window.resize(width, height)
            for i, mode in ((0, "raw"), (0, "text"), (0, "clean"), (1, "range")):
                window.navigation.setCurrentRow(i)
                if mode != "range":
                    window.pages[i].mode_choice.setCurrentIndex(window.pages[i].mode_choice.findData(mode))
                app.processEvents()
                scroll = window.stack.widget(i)
                assert scroll.horizontalScrollBar().maximum() == 0, (width, height, i)
                assert window.pages[i].table.horizontalScrollBar().maximum() == 0
                if height >= 900:
                    assert scroll.verticalScrollBar().maximum() == 0
                scroll.ensureWidgetVisible(window.pages[i].export_button)
                app.processEvents()
                button = window.pages[i].export_button
                assert scroll.viewport().rect().contains(button.mapTo(scroll.viewport(), button.rect().center()))
                assert window.grab().save(str(screenshot.with_name(f"page-{mode}-{width}.png")))
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
        page.add_files([source])
        page.mode_choice.setCurrentIndex(1)
        page.strip_tags.setChecked(True)
        page.prepare()
        wait_task(app, window)
        # Remove temporary private paths from documentation captures.
        page.output.setText("导出文件夹（点击「输出位置…」选择）")
        window.logs.clear()
        window.log("预览完成：1 个有效文件，已提取 4 条字幕正文。")
        app.processEvents()
        assert window.grab().save(str(screenshot))
