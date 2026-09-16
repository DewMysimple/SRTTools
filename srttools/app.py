"""GUI entry and isolated frozen-application smoke test."""
import argparse
import os
from pathlib import Path
import sys

from PySide6.QtCore import QTimer
from PySide6.QtGui import QFontDatabase, QIcon
from PySide6.QtWidgets import QApplication

from .ui import MainWindow


def main(argv=None):
    parser = argparse.ArgumentParser(description="SRTTools 字幕处理工具")
    parser.add_argument("--smoke-test", type=Path, metavar="SCREENSHOT", help="仅在演示数据上运行并保存窗口截图后退出")
    args = parser.parse_args(argv)
    # Automated resizing/maximizing must not flash windows on the user's desktop.
    # A dedicated test host can explicitly request QT_QPA_PLATFORM=windows.
    if args.smoke_test:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication(sys.argv[:1])
    if args.smoke_test and app.platformName() == "offscreen" and sys.platform == "win32":
        # The offscreen plugin has no Windows font discovery. Read OS fonts for
        # accurate Chinese screenshots; never bundle or redistribute OS fonts.
        fonts = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "Fonts"
        for name in ("segoeui.ttf", "msyh.ttc", "msyhbd.ttc"):
            if (fonts / name).is_file():
                QFontDatabase.addApplicationFont(str(fonts / name))
    app.setApplicationName("SRTTools")
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    app.setWindowIcon(QIcon(str(root / "assets" / "srttools.ico")))
    window = MainWindow()
    window.show()
    if args.smoke_test:
        from .smoke import run_smoke
        def smoke():
            try:
                run_smoke(app, window, args.smoke_test)
            except Exception:
                import traceback
                args.smoke_test.with_suffix(".error.txt").write_text(traceback.format_exc(), encoding="utf-8")
                app.exit(1)
            else:
                app.exit(0)
        QTimer.singleShot(200, smoke)
    return app.exec()
