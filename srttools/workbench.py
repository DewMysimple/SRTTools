"""A document-first workspace: one file list, one reader, direct save actions."""
import os
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QFormLayout, QFrame,
    QHBoxLayout, QHeaderView, QLabel, QPushButton,
    QSizePolicy, QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .service import Failure, Options, Prepared
from .preview import LivePreview, TextPreview
from .workflow import Discovery, discover, export_documents, prepare_documents


def choice(items):
    widget = QComboBox()
    for label, value in items:
        widget.addItem(label, value)
    return widget


class SrtWorkbench(QWidget):
    def __init__(self, window):
        super().__init__()
        self.window = window
        self.paths = []
        self.relatives = {}
        self.results = []
        self.scan_issues = []
        self.output_directory = None
        self.saved_paths = {}
        self.live = LivePreview(self)
        self.setAcceptDrops(True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(26, 24, 26, 18)
        outer.setSpacing(12)
        title = QLabel("字幕整理")
        title.setObjectName("pageTitle")
        outer.addWidget(title)

        self.controls = QWidget()
        controls = QVBoxLayout(self.controls)
        controls.setContentsMargins(0, 0, 0, 0)
        controls.setSpacing(10)
        toolbar = QHBoxLayout()
        self.add_button = QPushButton("添加文件")
        self.add_button.clicked.connect(self.choose_files)
        self.folder_button = QPushButton("添加文件夹")
        self.folder_button.clicked.connect(self.choose_folder)
        self.recursive = QCheckBox("包含子文件夹")
        self.recursive.setChecked(True)
        self.recursive.setToolTip("添加文件夹时生效；不跟随链接，跳过本次已选保存目录")
        self.settings_button = QPushButton("格式设置")
        self.settings_button.setCheckable(True)
        for widget in (self.add_button, self.folder_button, self.recursive):
            toolbar.addWidget(widget)
        toolbar.addStretch()
        controls.addLayout(toolbar)

        self.settings = QFrame()
        self.settings.setObjectName("settingsPanel")
        form = QFormLayout(self.settings)
        self.encoding = choice([("自动 · UTF-8 / BOM", "auto"), ("UTF-8", "utf-8-sig"),
                                ("UTF-16（含 BOM）", "utf-16"), ("简体中文 GB18030", "gb18030"),
                                ("繁体中文 Big5", "big5"), ("西欧 Windows-1252", "cp1252")])
        self.output_encoding = choice([("UTF-8", "utf-8"), ("UTF-8（含 BOM）", "utf-8-sig"), ("UTF-16", "utf-16")])
        self.layout_choice = choice([("保留分行与段落", "keep"), ("每条字幕一行", "lines"), ("合并为一段", "paragraph")])
        self.strip_tags = QCheckBox("去除字幕样式标签")
        self.reset_button = QPushButton("恢复默认")
        self.reset_button.clicked.connect(self.reset_options)
        form.addRow("正文排版", self.layout_choice)
        form.addRow("保存编码", self.output_encoding)
        form.addRow("读取编码", self.encoding)
        row = QHBoxLayout()
        row.addWidget(self.strip_tags)
        row.addStretch()
        row.addWidget(self.reset_button)
        form.addRow(row)
        self.settings.hide()
        self.settings_button.toggled.connect(self.settings.setVisible)
        outer.addWidget(self.controls)

        self.scan_status = QLabel()
        self.scan_status.setWordWrap(True)
        self.scan_status.hide()
        outer.addWidget(self.scan_status)

        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.setChildrenCollapsible(False)
        self.splitter.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Ignored)
        self.splitter.setMinimumHeight(230)
        library = QFrame()
        library.setObjectName("libraryPanel")
        library.setMinimumWidth(215)
        left = QVBoxLayout(library)
        left.setContentsMargins(10, 14, 10, 10)
        self.source_summary = QLabel("文件  ·  0")
        self.source_summary.setObjectName("sectionTitle")
        left.addWidget(self.source_summary)
        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["文件名", "状态"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(1, 64)
        self.table.verticalHeader().hide()
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setMinimumHeight(80)
        self.table.itemSelectionChanged.connect(self.show_preview)
        left.addWidget(self.table, 1)
        self.list_controls = QWidget()
        row = QHBoxLayout(self.list_controls)
        row.setContentsMargins(0, 0, 0, 0)
        self.remove_button = QPushButton("移除")
        self.remove_button.clicked.connect(self.remove_files)
        self.clear_button = QPushButton("清空")
        self.clear_button.clicked.connect(self.clear_files)
        row.addWidget(self.remove_button)
        row.addWidget(self.clear_button)
        row.addStretch()
        left.addWidget(self.list_controls)

        reader = QFrame()
        reader.setObjectName("readerPanel")
        reader.setMinimumWidth(250)
        right = QVBoxLayout(reader)
        right.setContentsMargins(18, 16, 18, 16)
        self.format_controls = QWidget()
        format_row = QHBoxLayout(self.format_controls)
        format_row.setContentsMargins(0, 0, 0, 0)
        format_row.addWidget(QLabel("导出为"))
        self.output_format = choice([("纯文本 · .txt", "text"),
                                     ("原字幕副本 · .srt", "copy"),
                                     ("带时间轴文本 · .txt", "raw")])
        self.output_format.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        format_row.addWidget(self.output_format, 1)
        format_row.addWidget(self.settings_button)
        right.addWidget(self.format_controls)
        right.addWidget(self.settings)
        self.format_info = QLabel()
        self.format_info.setObjectName("hint")
        self.format_info.setWordWrap(True)
        right.addWidget(self.format_info)
        self.document_title = QLabel("导出预览")
        self.document_title.setObjectName("sectionTitle")
        self.document_title.setWordWrap(True)
        right.addWidget(self.document_title)
        self.document_info = QLabel("添加文件后，自动显示最终文件内容")
        self.document_info.setObjectName("hint")
        self.document_info.setWordWrap(True)
        right.addWidget(self.document_info)
        self.preview = TextPreview()
        self.preview.setMinimumWidth(0)
        self.preview.setPlaceholderText("添加 SRT 或 TXT 文件\n\n选好格式，预览会自动更新。\n导出保存的就是这里的内容。")
        right.addWidget(self.preview, 1)
        self.splitter.addWidget(library)
        self.splitter.addWidget(reader)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([240, 620])
        outer.addWidget(self.splitter, 1)

        self.footer = QWidget()
        footer = QHBoxLayout(self.footer)
        footer.setContentsMargins(0, 0, 0, 0)
        self.summary = QLabel("本地处理 · 原文件保留")
        self.summary.setObjectName("hint")
        self.summary.setWordWrap(True)
        footer.addWidget(self.summary, 1)
        self.preview_button = QPushButton("重新读取")
        self.preview_button.setToolTip("文件在外部改动或取消预览后，重新读取；设置变化会自动更新")
        self.preview_button.clicked.connect(self.prepare)
        self.export_button = QPushButton("导出 TXT…")
        self.export_button.setObjectName("primary")
        self.export_button.setEnabled(False)
        self.export_button.clicked.connect(self.export)
        footer.addWidget(self.preview_button)
        footer.addWidget(self.export_button)
        outer.addWidget(self.footer)
        for widget in (self.encoding, self.output_encoding, self.layout_choice, self.output_format):
            widget.currentIndexChanged.connect(self.invalidate)
        self.strip_tags.toggled.connect(self.invalidate)
        self.adjust_format()

    def adjust_format(self):
        text = self.output_format.currentData() == "text"
        for widget in (self.output_encoding, self.layout_choice, self.strip_tags):
            widget.setEnabled(text)
        self.format_info.setText(
            f"去掉序号与时间轴 · {self.layout_choice.currentText()} · {self.output_encoding.currentText()}"
            if text else "保留序号、时间轴、原编码与换行；只复制，不改写内容")
        self.settings.setToolTip("原样保存不应用正文排版、去标签或保存编码设置" if not text else "修改后自动更新预览")

    def extension(self):
        return "SRT" if self.output_format.currentData() == "copy" else "TXT"

    def options(self):
        return Options(encoding=self.encoding.currentData(), output_encoding=self.output_encoding.currentData(),
                       layout=self.layout_choice.currentData(), strip_tags=self.strip_tags.isChecked())

    def reset_options(self):
        for widget in (self.encoding, self.output_encoding, self.layout_choice):
            widget.setCurrentIndex(0)
        self.strip_tags.setChecked(False)
        self.invalidate()

    def choose_files(self):
        names, _ = QFileDialog.getOpenFileNames(self, "添加字幕或文本", "", "字幕和文本 (*.srt *.txt)")
        self.add_files([Path(name) for name in names])

    def choose_folder(self):
        directory = QFileDialog.getExistingDirectory(self, "添加字幕文件夹")
        if directory:
            self.add_files([Path(directory)])

    def add_files(self, paths):
        if self.window.worker or not paths:
            return
        folders = []
        seen = {os.path.normcase(str(path)) for path in self.paths}
        for original in paths:
            path = original.absolute()
            if path.is_dir():
                folders.append(path)
            elif os.path.normcase(str(path)) not in seen:
                self.paths.append(path)
                self.relatives[path] = Path()
                seen.add(os.path.normcase(str(path)))
        self.invalidate()
        if folders:
            self.live.pending = False
            self.live.timer.stop()
            self.scan_folders(folders)

    def scan_folders(self, roots):
        recursive, excluded = self.recursive.isChecked(), self.output_directory
        def operation(cancel, progress):
            results = []
            for root in roots:
                if cancel.is_set():
                    results.append((root, Discovery((), (Failure(root, "扫描已取消，此目录未扫描。"),))))
                    break
                try:
                    results.append((root, discover(root, recursive, cancel, progress, excluded)))
                except (OSError, ValueError) as exc:
                    results.append((root, Discovery((), (Failure(root, str(exc)),))))
            return results
        self.window.start_task(operation, self.scanned, failed=lambda message: self.preview_failed(f"扫描失败：{message}"))

    def scanned(self, results):
        seen = {os.path.normcase(str(path)) for path in self.paths}
        cancelled = False
        for root, discovery in results:
            self.scan_issues.extend(discovery.issues)
            for path in discovery.paths:
                if os.path.normcase(str(path)) not in seen:
                    self.paths.append(path)
                    self.relatives[path] = path.parent.relative_to(root)
                    seen.add(os.path.normcase(str(path)))
            for issue in discovery.issues:
                cancelled |= "取消" in issue.message
                self.window.log(f"扫描：{issue.source} · {issue.message}")
        self.scan_status.setVisible(bool(self.scan_issues))
        self.scan_status.setText(f"扫描有 {len(self.scan_issues)} 项提示，列表可能不完整。详情见悬停与日志。")
        self.scan_status.setToolTip("\n".join(f"{r.source}：{r.message}" for r in self.scan_issues))
        self.invalidate()
        cancelled |= bool(self.window.worker and self.window.worker.cancel.is_set())
        if cancelled:
            self.live.cancel()

    def refresh_files(self):
        current = self.table.currentRow()
        self.table.blockSignals(True)
        self.table.setRowCount(len(self.paths))
        for row, path in enumerate(self.paths):
            relative = self.relatives.get(path, Path()) / path.name
            cell = QTableWidgetItem(str(relative))
            cell.setToolTip(str(path))
            self.table.setItem(row, 0, cell)
            self.table.setItem(row, 1, QTableWidgetItem("待预览"))
        self.table.blockSignals(False)
        self.source_summary.setText(f"文件  ·  {len(self.paths)}")
        if self.paths:
            self.table.selectRow(max(0, min(current, len(self.paths) - 1)))

    def remove_files(self):
        if self.window.worker:
            return
        rows = {item.row() for item in self.table.selectedItems()}
        self.paths = [path for index, path in enumerate(self.paths) if index not in rows]
        self.relatives = {path: self.relatives[path] for path in self.paths}
        self.invalidate()
        self.prepare()

    def clear_files(self):
        if self.window.worker:
            return
        self.paths.clear()
        self.relatives.clear()
        self.scan_issues.clear()
        self.scan_status.hide()
        self.invalidate()

    def invalidate(self, *_):
        self.adjust_format()
        self.live.request()

    def clear_preview(self):
        self.results = []
        self.saved_paths = {}
        self.preview.clear()
        self.document_title.setText("导出预览")
        self.document_title.setToolTip("")
        self.document_info.setText("正在更新预览…" if self.paths else "添加文件后，自动显示最终文件内容")
        self.export_button.setEnabled(False)
        self.export_button.setText(f"导出 {self.extension()}…")
        self.summary.setText("正在更新预览…" if self.paths else "本地处理 · 原文件保留")
        self.refresh_files()

    def prepare(self):
        self.invalidate()
        self.live.start()

    def preview_operation(self):
        paths, options, kind = list(self.paths), self.options(), self.output_format.currentData()
        return lambda cancel, progress: prepare_documents(paths, options, kind, cancel, progress)

    def preview_failed(self, message):
        self.document_info.setText(message)
        self.summary.setText(message)

    def prepared(self, results):
        self.results = results
        valid = sum(isinstance(result, Prepared) for result in results)
        for row, result in enumerate(results):
            state = "可导出" if isinstance(result, Prepared) else "读取失败"
            self.table.item(row, 1).setText(state)
            self.table.item(row, 1).setToolTip(state if isinstance(result, Prepared) else result.message)
            if isinstance(result, Failure):
                self.window.log(f"{result.source.name}：{result.message}")
            else:
                for warning in result.warnings:
                    self.window.log(f"{result.source.name}：{warning}")
        self.summary.setText(f"全部 {valid} 个有效文件 · " + (f"{len(results) - valid} 个失败，点选查看" if valid < len(results) else "同名自动编号"))
        self.export_button.setText(f"导出 {self.extension()}（{valid}）…")
        self.export_button.setEnabled(valid > 0)
        self.show_preview()

    def show_preview(self):
        row = self.table.currentRow()
        if not 0 <= row < len(self.results):
            return
        result = self.results[row]
        saved = self.saved_paths.get(result.source)
        name = saved.name if saved else result.source.stem[:160] + result.suffix if isinstance(result, Prepared) else result.source.name
        self.document_title.setText(name)
        self.document_title.setToolTip(str(saved) if saved else f"来源：{result.source}\n保存到所选目录；同名自动编号。")
        if isinstance(result, Prepared):
            detail = f"{result.cue_count} 条字幕 · " if result.cue_count is not None else ""
            if self.output_format.currentData() == "text":
                encoding = self.output_encoding.currentText()
            else:
                encoding = result.encoding.upper()
                if result.encoding == "utf-8-sig":
                    encoding = "UTF-8（含 BOM）" if result.data.startswith(b"\xef\xbb\xbf") else "UTF-8"
            self.document_info.setText(f"{self.extension()} · {encoding} · " + detail + f"{len(result.preview):,} 字符 · 最终文件内容")
            self.preview.setPlainText(result.preview)
        else:
            self.document_info.setText("无法生成预览，请检查文件或读取编码；此项不会导出")
            self.preview.setPlainText(result.message)

    def choose_destination(self, title):
        directory = QFileDialog.getExistingDirectory(self, title, str(self.output_directory or ""))
        if not directory:
            return None
        self.output_directory = Path(directory).absolute()
        return self.output_directory

    def export(self):
        if self.window.worker or not any(isinstance(item, Prepared) for item in self.results):
            return
        output = self.choose_destination(f"保存预览中的 {self.extension()} 文件到（同名自动编号）")
        if output is None:
            return
        items, relatives = list(self.results), dict(self.relatives)
        self.export_button.setEnabled(False)
        self.window.start_task(lambda cancel, progress: export_documents(items, output, relatives, cancel, progress),
                               self.exported, failed=lambda message: self.summary.setText(f"导出失败：{message}"))

    def exported(self, results):
        action = self.output_format.currentText()
        self.saved_paths = {item.source: result for item, result in zip(self.results, results) if isinstance(result, Path)}
        for row, result in enumerate(results):
            state = "已保存" if isinstance(result, Path) else "未保存"
            self.table.item(row, 1).setText(state)
            self.table.item(row, 1).setToolTip(str(result) if isinstance(result, Path) else result.message)
            self.window.log(f"{action}：{result}" if isinstance(result, Path) else f"{action} · {result.source.name}：{result.message}")
        success = sum(isinstance(result, Path) for result in results)
        self.summary.setText(f"{action}：已保存 {success} 个文件 · 未保存 {len(results) - success} 个 · 原文件保留")
        self.summary.setToolTip(str(self.output_directory))
        self.export_button.setEnabled(any(isinstance(item, Prepared) for item in self.results))
        self.export_button.setText(f"再次导出 {self.extension()}…")
        self.show_preview()

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and not self.window.worker:
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.add_files([Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()])
        event.acceptProposedAction()
