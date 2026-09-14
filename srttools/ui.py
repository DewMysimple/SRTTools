"""Static feature pages and a single controlled QThread task slot."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from threading import Event

from PySide6.QtCore import Qt, QThread, Signal, QUrl
from PySide6.QtGui import QDesktopServices, QTextCursor
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QFormLayout, QFrame,
    QHBoxLayout, QHeaderView, QLabel, QLineEdit, QListWidget, QMainWindow,
    QMessageBox, QPlainTextEdit, QProgressBar, QPushButton, QScrollArea,
    QSpinBox, QSplitter, QStackedWidget, QTableWidget, QTableWidgetItem,
    QVBoxLayout, QWidget,
)

from . import __version__
from .service import Failure, Options, Prepared, export_batch, prepare_batch
from .subtitles import parse_time

FEATURES = (
    ("raw", "原样转 TXT", "只换扩展名，保留序号、时间轴、编码和换行。"),
    ("text", "SRT 提取正文", "去除序号与时间轴，把字幕变成可阅读的文本。"),
    ("clean", "TXT 字幕清理", "清理 TXT 中残留的 SRT 时间轴与序号，保留正文。"),
    ("range", "时间范围导出", "截取指定时间段，导出新的 SRT 或纯文本。"),
)

STYLE = """
QMainWindow, QWidget#workspace { background: #f4f6fa; color: #192b3d; }
QWidget { font-family: 'Microsoft YaHei UI'; font-size: 10pt; }
QFrame#sidebar { background: #152b3b; border: none; }
QLabel#brand { color: #ffffff; font-size: 23pt; font-weight: 700; }
QLabel#sideNote { color: #b4c5d1; }
QListWidget#navigation { background: transparent; color: #d3e1eb; border: none; outline: none; }
QListWidget#navigation::item { padding: 14px 10px; margin: 3px 0; border-radius: 7px; }
QListWidget#navigation::item:selected { background: #28506a; color: white; }
QLabel#pageTitle { font-size: 21pt; font-weight: 700; color: #142e40; }
QLabel#hint { color: #52697d; }
QPushButton { padding: 7px 14px; background: white; border: 1px solid #cad5df; border-radius: 6px; }
QPushButton:hover { background: #eaf3f7; border-color: #438395; }
QPushButton#primary { background: #166b79; color: white; border: none; font-weight: 600; }
QPushButton:disabled { background: #e5eaf0; color: #8996a3; }
QLineEdit, QComboBox, QSpinBox { background: white; border: 1px solid #cbd5df; border-radius: 5px; padding: 5px; }
QTableWidget, QPlainTextEdit { background: white; border: 1px solid #d5dee7; border-radius: 6px; gridline-color: #e0e7ee; }
QHeaderView::section { background: #edf2f7; color: #425d70; padding: 7px; border: none; border-right: 1px solid #d5dee7; }
QProgressBar { border: none; border-radius: 3px; background: #e0e7ee; text-align: center; }
QProgressBar::chunk { background: #3d9aa7; }
QScrollArea { border: none; }
"""


def combo(items):
    widget = QComboBox()
    for label, value in items:
        widget.addItem(label, value)
    return widget


class Worker(QThread):
    completed = Signal(object)
    failed = Signal(str)
    progress = Signal(int, int, str)

    def __init__(self, operation, parent):
        super().__init__(parent)
        self.operation = operation
        self.cancel = Event()

    def run(self):
        try:
            result = self.operation(self.cancel, self.progress.emit)
            self.completed.emit(result)
        except Exception as exc:
            self.failed.emit(str(exc))


class FeaturePage(QWidget):
    def __init__(self, mode, title, description, window):
        super().__init__()
        self.mode, self.window = mode, window
        self.paths: list[Path] = []
        self.results: list[Prepared | Failure] = []
        self.setAcceptDrops(True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(22, 18, 22, 12)
        heading = QLabel(title)
        heading.setObjectName("pageTitle")
        outer.addWidget(heading)
        hint = QLabel(description)
        hint.setObjectName("hint")
        outer.addWidget(hint)

        self.controls = QWidget()
        control_layout = QVBoxLayout(self.controls)
        control_layout.setContentsMargins(0, 4, 0, 4)
        buttons = QHBoxLayout()
        add = QPushButton("＋ 添加文件")
        add.clicked.connect(self.choose_files)
        remove = QPushButton("移除选中")
        remove.clicked.connect(self.remove_files)
        clear = QPushButton("清空")
        clear.clicked.connect(self.clear_files)
        for button in (add, remove, clear):
            buttons.addWidget(button)
        buttons.addStretch()
        drag_hint = QLabel("支持多选，也可拖入文件")
        drag_hint.setObjectName("hint")
        buttons.addWidget(drag_hint)
        control_layout.addLayout(buttons)

        self.encoding = combo([("自动 · UTF-8 / BOM", "auto"), ("UTF-8", "utf-8-sig"),
                               ("UTF-16（含 BOM）", "utf-16"), ("简体中文 GB18030", "gb18030"),
                               ("繁体中文 Big5", "big5"), ("西欧 Windows-1252", "cp1252")])
        self.output_encoding = combo([("UTF-8", "utf-8"), ("UTF-8（含 BOM）", "utf-8-sig"), ("UTF-16", "utf-16")])
        self.layout_choice = combo([("保留分行与段落", "keep"), ("每条字幕一行", "lines"), ("合并为一段", "paragraph")])
        self.strip_tags = QCheckBox("去除常见字幕样式标签（如 <i>、<b>）")
        form = QFormLayout()
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        form.addRow("输入编码", self.encoding)
        if mode != "raw":
            row = QHBoxLayout()
            row.addWidget(self.output_encoding)
            row.addWidget(self.layout_choice)
            form.addRow("输出文本", row)
            form.addRow("", self.strip_tags)
        self.start = QLineEdit("00:02:00")
        self.end = QLineEdit("00:03:00")
        self.policy = combo([("与范围有交集", "overlap"), ("整条完全在范围内", "contained"), ("开始时间在范围内", "start")])
        self.output_format = combo([("SRT 字幕", "srt"), ("TXT 纯文本", "txt")])
        self.clip = QCheckBox("裁切跨边界字幕")
        self.clip.setChecked(True)
        self.rebase = QCheckBox("以范围起点为零")
        self.offset = QSpinBox()
        self.offset.setRange(-86_400_000, 86_400_000)
        self.offset.setSuffix(" ms")
        self.offset.setSingleStep(100)
        if mode == "range":
            times = QHBoxLayout()
            times.addWidget(self.start)
            times.addWidget(QLabel("至"))
            times.addWidget(self.end)
            form.addRow("时间范围", times)
            self.start.setToolTip("支持秒、分:秒、时:分:秒。例：120 / 02:00 / 00:02:00,000")
            self.end.setToolTip(self.start.toolTip())
            output = QHBoxLayout()
            output.addWidget(self.policy)
            output.addWidget(self.output_format)
            form.addRow("匹配 / 格式", output)
            timing = QHBoxLayout()
            timing.addWidget(self.clip)
            timing.addWidget(self.rebase)
            timing.addWidget(self.offset)
            form.addRow("时间调整", timing)
        control_layout.addLayout(form)
        outer.addWidget(self.controls)

        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["来源文件", "预览状态", "导出文件名"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().hide()
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setMinimumHeight(80)
        self.table.itemSelectionChanged.connect(self.show_preview)
        self.preview = QPlainTextEdit()
        self.preview.setReadOnly(True)
        self.preview.setPlaceholderText("添加文件 → 生成预览 → 检查结果 → 导出。来源文件始终保留。")
        self.preview.setMinimumHeight(80)
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.addWidget(self.table)
        splitter.addWidget(self.preview)
        splitter.setSizes([180, 240])
        outer.addWidget(splitter, 1)

        self.footer = QWidget()
        footer = QVBoxLayout(self.footer)
        footer.setContentsMargins(0, 2, 0, 0)
        folder = QHBoxLayout()
        self.output = QLineEdit()
        self.output.setPlaceholderText("选择输出文件夹；同名文件自动编号")
        browse = QPushButton("输出位置…")
        browse.clicked.connect(self.choose_output)
        folder.addWidget(self.output, 1)
        folder.addWidget(browse)
        footer.addLayout(folder)
        actions = QHBoxLayout()
        self.summary = QLabel("尚未添加文件")
        actions.addWidget(self.summary, 1)
        self.preview_button = QPushButton("生成预览")
        self.preview_button.clicked.connect(self.prepare)
        self.export_button = QPushButton("导出全部有效项")
        self.export_button.setObjectName("primary")
        self.export_button.setEnabled(False)
        self.export_button.clicked.connect(self.export)
        actions.addWidget(self.preview_button)
        actions.addWidget(self.export_button)
        footer.addLayout(actions)
        outer.addWidget(self.footer)
        for widget in (self.encoding, self.output_encoding, self.layout_choice, self.output_format, self.policy):
            widget.currentIndexChanged.connect(self.invalidate)
        for widget in (self.start, self.end):
            widget.textChanged.connect(self.invalidate)
        for widget in (self.strip_tags, self.clip, self.rebase):
            widget.toggled.connect(self.invalidate)
        self.offset.valueChanged.connect(self.invalidate)
        self.output_format.currentIndexChanged.connect(self.adjust_text_options)
        self.adjust_text_options()

    def adjust_text_options(self):
        enabled = self.mode != "range" or self.output_format.currentData() == "txt"
        self.layout_choice.setEnabled(enabled)
        self.strip_tags.setEnabled(enabled)

    def options(self):
        return Options(
            mode=self.mode, encoding=self.encoding.currentData(), output_encoding=self.output_encoding.currentData(),
            layout=self.layout_choice.currentData(), strip_tags=self.strip_tags.isChecked(),
            output_format=self.output_format.currentData(),
            start=parse_time(self.start.text()) if self.mode == "range" else 0,
            end=parse_time(self.end.text()) if self.mode == "range" else 60_000,
            policy=self.policy.currentData(), clip=self.clip.isChecked(), rebase=self.rebase.isChecked(),
            offset=self.offset.value(),
        )

    def choose_files(self):
        file_filter = "字幕和文本 (*.srt *.txt)" if self.mode == "clean" else "SRT 字幕 (*.srt)"
        names, _ = QFileDialog.getOpenFileNames(self, "添加字幕文件", "", file_filter)
        self.add_files([Path(name) for name in names])

    def add_files(self, paths):
        if self.window.worker:
            return
        for path in paths:
            if path not in self.paths:
                self.paths.append(path)
        self.invalidate()
        self.refresh_table()

    def remove_files(self):
        rows = {item.row() for item in self.table.selectedItems()}
        self.paths = [path for i, path in enumerate(self.paths) if i not in rows]
        self.invalidate()
        self.refresh_table()

    def clear_files(self):
        self.paths.clear()
        self.invalidate()
        self.refresh_table()

    def invalidate(self, *_):
        self.results = []
        self.export_button.setEnabled(False)
        self.preview.clear()
        self.summary.setText(f"{len(self.paths)} 个文件 · 请生成预览")
        self.refresh_table()

    def refresh_table(self):
        self.table.setRowCount(len(self.paths))
        lookup = {r.source: r for r in self.results}
        for i, path in enumerate(self.paths):
            result = lookup.get(path)
            state = "待预览"
            name = "—"
            if isinstance(result, Failure):
                state = "失败 · " + result.message
            elif isinstance(result, Prepared):
                state = f"{result.cue_count} 条字幕" if result.cue_count is not None else "可导出"
                state += f" · {len(result.data):,} 字节"
                name = path.stem[:160] + result.suffix
            for col, text in enumerate((path.name, state, name)):
                item = QTableWidgetItem(text)
                item.setToolTip(str(path) if col == 0 else text)
                self.table.setItem(i, col, item)

    def show_preview(self):
        row = self.table.currentRow()
        if not 0 <= row < len(self.paths):
            return
        result = next((r for r in self.results if r.source == self.paths[row]), None)
        if isinstance(result, Prepared):
            preview = result.preview[:50_000]
            if len(result.preview) > 50_000:
                preview += "\n\n[界面只预览前 50,000 字符，导出包含完整内容]"
            self.preview.setPlainText(preview)
        elif isinstance(result, Failure):
            self.preview.setPlainText(result.message)

    def choose_output(self):
        directory = QFileDialog.getExistingDirectory(self, "选择输出文件夹", self.output.text())
        if directory:
            self.output.setText(directory)
            self.output.setToolTip(directory)

    def prepare(self):
        if not self.paths:
            self.window.log("请先添加 SRT 或 TXT 文件。")
            return
        try:
            options = self.options()
        except ValueError as exc:
            self.window.log(str(exc))
            return
        paths = list(self.paths)
        self.invalidate()
        self.window.start_task(lambda cancel, progress: prepare_batch(paths, options, cancel, progress), self.prepared)

    def prepared(self, results):
        self.results = results
        self.refresh_table()
        valid = sum(isinstance(r, Prepared) for r in results)
        self.summary.setText(f"{valid} 个可导出 · {len(results)-valid} 个失败")
        self.export_button.setEnabled(valid > 0)
        self.window.log(f"预览完成：{valid} 个有效，{len(results)-valid} 个失败。")
        for result in results:
            if isinstance(result, Prepared):
                for warning in result.warnings:
                    self.window.log(f"{result.source.name}：{warning}")
        if results:
            self.table.selectRow(0)
            self.show_preview()

    def export(self):
        if not self.output.text().strip() or not Path(self.output.text()).is_dir():
            self.window.log("请先选择已存在的输出文件夹。")
            return
        items = [r for r in self.results if isinstance(r, Prepared)]
        directory = Path(self.output.text())
        self.window.start_task(lambda cancel, progress: export_batch(items, directory, cancel, progress), self.exported)

    def exported(self, results):
        successes = [r for r in results if isinstance(r, Path)]
        self.summary.setText(f"已导出 {len(successes)} 个 · 失败/取消 {len(results)-len(successes)} 个")
        for result in results:
            self.window.log(f"已导出：{result}" if isinstance(result, Path) else f"{result.source.name}：{result.message}")
        self.export_button.setEnabled(False)
        self.results = []

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and not self.window.worker:
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.add_files([Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()])
        event.acceptProposedAction()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.worker = None
        self.setWindowTitle(f"SRTTools {__version__} · 字幕处理工具")
        self.resize(1180, 900)
        self.setMinimumSize(850, 620)
        self.setStyleSheet(STYLE)
        root = QWidget()
        root.setObjectName("workspace")
        self.setCentralWidget(root)
        layout = QHBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        sidebar = QFrame()
        sidebar.setObjectName("sidebar")
        sidebar.setFixedWidth(212)
        side = QVBoxLayout(sidebar)
        side.setContentsMargins(18, 26, 18, 20)
        brand = QLabel("SRTTools")
        brand.setObjectName("brand")
        side.addWidget(brand)
        subtitle = QLabel("字幕，按你的方式整理")
        subtitle.setObjectName("sideNote")
        side.addWidget(subtitle)
        side.addSpacing(25)
        self.navigation = QListWidget()
        self.navigation.setObjectName("navigation")
        side.addWidget(self.navigation, 1)
        note = QLabel(f"本地处理 · 来源保留\nv{__version__}")
        note.setObjectName("sideNote")
        side.addWidget(note)
        guide = QPushButton("使用指南")
        guide.clicked.connect(self.open_guide)
        side.addWidget(guide)
        layout.addWidget(sidebar)
        right = QVBoxLayout()
        self.stack = QStackedWidget()
        self.pages = []
        for mode, title, description in FEATURES:
            self.navigation.addItem(title)
            page = FeaturePage(mode, title, description, self)
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setWidget(page)
            self.stack.addWidget(scroll)
            self.pages.append(page)
        self.navigation.currentRowChanged.connect(self.stack.setCurrentIndex)
        self.navigation.setCurrentRow(0)
        right.addWidget(self.stack, 1)
        status = QHBoxLayout()
        status.setContentsMargins(22, 0, 22, 0)
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.cancel = QPushButton("取消任务")
        self.cancel.clicked.connect(self.cancel_task)
        self.cancel.setEnabled(False)
        status.addWidget(self.progress, 1)
        status.addWidget(self.cancel)
        right.addLayout(status)
        self.logs = QPlainTextEdit()
        self.logs.setReadOnly(True)
        self.logs.setFixedHeight(80)
        self.logs.setPlaceholderText("操作日志 · 最新记录在最上方")
        right.addWidget(self.logs)
        layout.addLayout(right, 1)

    def log(self, message):
        content = f"{datetime.now():%H:%M:%S}  {message}\n" + self.logs.toPlainText()
        self.logs.setPlainText("\n".join(content.splitlines()[:300]))
        self.logs.moveCursor(QTextCursor.MoveOperation.Start)
        self.logs.verticalScrollBar().setValue(0)

    def set_busy(self, busy):
        self.navigation.setEnabled(not busy)
        for page in self.pages:
            page.controls.setEnabled(not busy)
            page.footer.setEnabled(not busy)
        self.cancel.setEnabled(busy)

    def start_task(self, operation, callback):
        if self.worker:
            return
        self.set_busy(True)
        self.progress.setValue(0)
        self.worker = Worker(operation, self)
        self.worker.completed.connect(callback)
        self.worker.failed.connect(self.log)
        self.worker.progress.connect(self.on_progress)
        self.worker.finished.connect(self.task_finished)
        self.worker.start()

    def on_progress(self, done, total, name):
        self.progress.setValue(round(done * 100 / max(total, 1)))
        self.progress.setFormat(f"{done} / {total}")

    def task_finished(self):
        self.worker.deleteLater()
        self.worker = None
        self.set_busy(False)

    def cancel_task(self):
        if self.worker:
            self.worker.cancel.set()
            self.cancel.setEnabled(False)
            self.log("已请求取消，等待当前文件处理结束。")

    def closeEvent(self, event):
        if self.worker:
            self.cancel_task()
            self.log("任务结束后可关闭窗口。")
            event.ignore()
        else:
            event.accept()

    def open_guide(self):
        import sys
        root = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]
        path = root / "使用说明.md" if getattr(sys, "frozen", False) else root / "docs" / "使用指南.md"
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(path))):
            QMessageBox.information(self, "使用指南", "请在程序目录打开使用说明.md。")
