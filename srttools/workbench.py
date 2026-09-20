"""A document-first workspace: one file list, one reader, direct save actions."""
import os
from pathlib import Path

from PySide6.QtCore import Qt, QStandardPaths
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QGridLayout, QFrame,
    QHBoxLayout, QHeaderView, QLabel, QLineEdit, QPushButton,
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


def default_output_directory():
    return Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DesktopLocation)) / "Test"


class SrtWorkbench(QWidget):
    def __init__(self, window):
        super().__init__()
        self.window = window
        self.paths = []
        self.relatives = {}
        self.results = []
        self.scan_issues = []
        self.saved_paths = {}
        self.live = LivePreview(self)
        self.setAcceptDrops(True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 16, 18, 8)
        outer.setSpacing(10)
        heading = QHBoxLayout()
        title = QLabel("字幕整理")
        title.setObjectName("pageTitle")
        heading.addWidget(title)
        heading.addStretch()
        outer.addLayout(heading)

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
        for widget in (self.add_button, self.folder_button, self.recursive):
            toolbar.addWidget(widget)
        toolbar.addStretch()
        controls.addLayout(toolbar)
        heading.addWidget(self.controls)

        self.settings = QFrame()
        self.settings.setObjectName("settingsPanel")
        form = QGridLayout(self.settings)
        form.setContentsMargins(12, 10, 12, 10)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(6)
        settings_title = QLabel("02  导出设置")
        settings_title.setObjectName("sectionTitle")
        self.encoding = choice([("自动 · UTF-8 / BOM", "auto"), ("UTF-8", "utf-8-sig"),
                                ("UTF-16（含 BOM）", "utf-16"), ("简体中文 GB18030", "gb18030"),
                                ("繁体中文 Big5", "big5"), ("西欧 Windows-1252", "cp1252")])
        self.output_encoding = choice([("UTF-8", "utf-8"), ("UTF-8（含 BOM）", "utf-8-sig"), ("UTF-16", "utf-16")])
        self.layout_choice = choice([("保留分行与段落", "keep"), ("每条字幕一行", "lines"), ("合并为一段", "paragraph")])
        self.strip_tags = QCheckBox("清除格式标记")
        self.strip_tags.setToolTip("例如 <i>文字</i> → 文字；清除常见 HTML 样式标签并还原 &amp; 等转义字符。\n没有这些标记时，勾选与否不会改变文字；不会删除时间戳。")
        self.reset_button = QPushButton("恢复默认")
        self.reset_button.clicked.connect(self.reset_options)
        form.addWidget(settings_title, 0, 0, 1, 2)
        form.addWidget(self.reset_button, 0, 3, alignment=Qt.AlignmentFlag.AlignRight)
        self.format_controls = QWidget()
        format_row = QHBoxLayout(self.format_controls)
        format_row.setContentsMargins(0, 0, 0, 0)
        self.output_format = choice([("TXT", "txt"), ("SRT", "srt")])
        format_row.addWidget(self.output_format)
        self.timestamps = QCheckBox("保留时间戳")
        format_row.addWidget(self.timestamps)
        format_row.addStretch()
        form.addWidget(QLabel("文件格式"), 1, 0)
        form.addWidget(self.format_controls, 1, 1, 1, 3)
        form.addWidget(QLabel("正文排版"), 2, 0)
        form.addWidget(self.layout_choice, 2, 1)
        form.addWidget(QLabel("保存编码"), 2, 2)
        form.addWidget(self.output_encoding, 2, 3)
        form.addWidget(QLabel("读取编码"), 3, 0)
        form.addWidget(self.encoding, 3, 1)
        form.addWidget(self.strip_tags, 3, 2, 1, 2)
        for widget in (self.layout_choice, self.encoding, self.output_encoding):
            widget.setMinimumWidth(0)
            widget.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        form.setColumnStretch(1, 1)
        form.setColumnStretch(3, 1)
        self.format_info = QLabel()
        self.format_info.setObjectName("hint")
        self.format_info.setWordWrap(True)
        form.addWidget(self.format_info, 4, 0, 1, 4)

        self.scan_status = QLabel()
        self.scan_status.setWordWrap(True)
        self.scan_status.hide()
        outer.addWidget(self.scan_status)

        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.setChildrenCollapsible(False)
        self.splitter.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Ignored)
        self.splitter.setMinimumHeight(355)
        library = QFrame()
        library.setObjectName("libraryPanel")
        library.setMinimumWidth(195)
        left = QVBoxLayout(library)
        left.setContentsMargins(10, 14, 10, 10)
        self.source_summary = QLabel("01  来源文件 · 0")
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

        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(10)
        content_layout.addWidget(self.settings)
        reader = QFrame()
        reader.setObjectName("readerPanel")
        reader.setMinimumWidth(300)
        reader.setMinimumHeight(130)
        right = QVBoxLayout(reader)
        right.setContentsMargins(12, 10, 12, 10)
        preview_title = QLabel("03  内容预览")
        preview_title.setObjectName("sectionTitle")
        right.addWidget(preview_title)
        self.document_title = QLabel("导出预览")
        self.document_title.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        self.document_title.setTextFormat(Qt.TextFormat.PlainText)
        right.addWidget(self.document_title)
        self.document_info = QLabel("添加文件后，自动显示最终文件内容")
        self.document_info.setObjectName("hint")
        self.document_info.setWordWrap(True)
        right.addWidget(self.document_info)
        self.style_info = QLabel("格式标记示例：<i>文字</i> → 文字；无标记时勾选前后相同")
        self.style_info.setTextFormat(Qt.TextFormat.PlainText)
        self.style_info.setObjectName("hint")
        self.style_info.setWordWrap(True)
        right.addWidget(self.style_info)
        self.preview = TextPreview()
        self.preview.setMinimumWidth(0)
        self.preview.setPlaceholderText("添加 SRT 或 TXT 文件\n\n选好格式，预览会自动更新。\n导出保存的就是这里的内容。")
        right.addWidget(self.preview, 1)
        content_layout.addWidget(reader, 1)
        self.splitter.addWidget(library)
        self.splitter.addWidget(content)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([210, 650])
        outer.addWidget(self.splitter, 1)

        self.footer = QFrame()
        self.footer.setObjectName("outputPanel")
        footer = QVBoxLayout(self.footer)
        footer.setContentsMargins(18, 10, 18, 10)
        folder = QHBoxLayout()
        output_title = QLabel("04  输出位置")
        output_title.setObjectName("sectionTitle")
        folder.addWidget(output_title)
        self.output = QLineEdit(str(default_output_directory()))
        self.output.setMinimumWidth(0)
        self.output.setToolTip(self.output.text())
        self.output.textChanged.connect(self.destination_changed)
        folder.addWidget(self.output, 1)
        self.browse_button = QPushButton("浏览…")
        self.browse_button.clicked.connect(self.choose_destination)
        folder.addWidget(self.browse_button)
        footer.addLayout(folder)
        actions = QHBoxLayout()
        self.summary = QLabel("本地处理 · 原文件保留")
        self.summary.setObjectName("hint")
        self.summary.setWordWrap(True)
        actions.addWidget(self.summary, 1)
        self.preview_button = QPushButton("重新读取")
        self.preview_button.setToolTip("文件在外部改动或取消预览后，重新读取；设置变化会自动更新")
        self.preview_button.clicked.connect(self.prepare)
        self.export_button = QPushButton("导出全部文件")
        self.export_button.setToolTip("保存列表中所有预览成功的文件，不只是当前查看的一行；失败项不会导出。")
        self.export_button.setObjectName("primary")
        self.export_button.setEnabled(False)
        self.export_button.clicked.connect(self.export)
        actions.addWidget(self.preview_button)
        actions.addWidget(self.export_button)
        footer.addLayout(actions)
        # MainWindow places this footer outside the scrollable content.
        for widget in (self.encoding, self.output_encoding, self.layout_choice, self.output_format):
            widget.currentIndexChanged.connect(self.invalidate)
        self.strip_tags.toggled.connect(self.invalidate)
        self.timestamps.toggled.connect(self.invalidate)
        self.adjust_format()

    def adjust_format(self):
        srt = self.output_format.currentData() == "srt"
        if srt:
            self.timestamps.blockSignals(True)
            self.timestamps.setChecked(True)
            self.timestamps.blockSignals(False)
        self.timestamps.setEnabled(not srt)
        timed = self.timestamps.isChecked()
        self.layout_choice.model().item(2).setEnabled(not timed)
        if timed and self.layout_choice.currentData() == "paragraph":
            self.layout_choice.blockSignals(True)
            self.layout_choice.setCurrentIndex(0)
            self.layout_choice.blockSignals(False)
        self.format_info.setText("SRT 必须包含时间戳；保留原时间，按当前设置生成字幕。" if srt else
                                 "TXT · 包含字幕序号、时间戳与正文；不会生成新的时间。" if timed else
                                 "TXT · 只导出正文，不含字幕序号和时间戳。")
        self.timestamps.setToolTip("SRT 格式必须包含时间戳；如需无时间戳请选择 TXT。" if srt else "勾选保留原字幕时间戳；取消只输出文字。")
        self.layout_choice.setToolTip("保留时间戳时不能合并全部字幕为一段。" if timed else "调整正文的分行和段落")

    def extension(self):
        return self.output_format.currentData().upper()

    def options(self):
        return Options(encoding=self.encoding.currentData(), output_encoding=self.output_encoding.currentData(),
                       layout=self.layout_choice.currentData(), strip_tags=self.strip_tags.isChecked(),
                       output_format=self.output_format.currentData(), include_timestamps=self.timestamps.isChecked())

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
        self.source_summary.setText(f"01  来源文件 · {len(self.paths)}")
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
        self.style_info.setText("正在检查格式标记…" if self.paths else "格式标记示例：<i>文字</i> → 文字；无标记时勾选前后相同")
        self.export_button.setEnabled(False)
        self.export_button.setText("导出全部文件")
        self.summary.setText("正在更新预览…" if self.paths else "本地处理 · 原文件保留")
        self.refresh_files()

    def prepare(self):
        self.invalidate()
        self.live.start()

    def preview_operation(self):
        paths, options = list(self.paths), self.options()
        return lambda cancel, progress: prepare_documents(paths, options, "document", cancel, progress)

    def preview_failed(self, message):
        self.document_info.setText(message)
        self.style_info.clear()
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
        self.summary.setText(f"待导出：{valid} 个 {self.extension()} 文件 · " +
                             (f"{len(results) - valid} 个失败项不导出，点选查看" if valid < len(results) else "同名自动编号"))
        self.export_button.setText("导出全部文件")
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
        destination = self.output_directory
        planned = destination / self.relatives.get(result.source, Path()) / name if destination else "请填写绝对输出路径"
        self.document_title.setToolTip(str(saved) if saved else f"来源：{result.source}\n输出：{planned}\n同名自动编号，不覆盖。")
        if isinstance(result, Prepared):
            detail = f"{result.cue_count} 条字幕 · " if result.cue_count is not None else ""
            encoding = self.output_encoding.currentText()
            self.document_info.setText(f"{self.extension()} · {encoding} · " + detail + f"{len(result.preview):,} 字符 · 最终文件内容")
            self.preview.setPlainText(result.preview)
            self.style_info.setText(("已清除格式标记，如 <i>、<b>；文字保留" if self.strip_tags.isChecked() else
                                     "检测到格式标记，如 <i>、<b>；当前保留，可勾选清除") if result.has_style_markup else
                                    "未发现可清除的格式标记；勾选与否，文字相同")
        else:
            self.document_info.setText("无法生成预览，请检查文件或读取编码；此项不会导出")
            self.style_info.clear()
            self.preview.setPlainText(result.message)

    @property
    def output_directory(self):
        value = self.output.text().strip()
        path = Path(value)
        return path if value and path.is_absolute() else None

    def destination_changed(self):
        self.output.setToolTip(self.output.text())
        self.saved_paths.clear()
        self.show_preview()

    def choose_destination(self):
        directory = QFileDialog.getExistingDirectory(self, "选择输出文件夹", self.output.text())
        if directory:
            self.output.setText(directory)

    def export(self):
        if self.window.worker or not any(isinstance(item, Prepared) for item in self.results):
            return
        output = self.output_directory
        if output is None:
            self.summary.setText("请填写完整的绝对输出路径，或点击“浏览…”选择文件夹。")
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
        self.export_button.setText("再次导出全部文件")
        self.show_preview()

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and not self.window.worker:
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.add_files([Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()])
        event.acceptProposedAction()
