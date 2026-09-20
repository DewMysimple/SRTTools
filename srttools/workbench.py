"""A document-first workspace: one file list, one reader, direct save actions."""
import os
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QFormLayout, QFrame,
    QHBoxLayout, QHeaderView, QLabel, QMenu, QPlainTextEdit, QPushButton,
    QSizePolicy, QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .service import Failure, Options, Prepared
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
        self.pending_preview = False
        self.setAcceptDrops(True)
        window.idle.connect(self.on_idle)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(26, 24, 26, 18)
        outer.setSpacing(14)
        title = QLabel("字幕整理")
        title.setObjectName("pageTitle")
        outer.addWidget(title)
        hint = QLabel("导入字幕，读一遍，再保存成你需要的文字。")
        hint.setObjectName("hint")
        outer.addWidget(hint)

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
        self.settings_button = QPushButton("文字设置")
        self.settings_button.setCheckable(True)
        for widget in (self.add_button, self.folder_button, self.recursive):
            toolbar.addWidget(widget)
        toolbar.addStretch()
        toolbar.addWidget(self.settings_button)
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
        form.addRow("读取编码", self.encoding)
        row = QHBoxLayout()
        row.addWidget(self.layout_choice, 1)
        row.addWidget(self.output_encoding, 1)
        form.addRow("排版 / 保存编码", row)
        row = QHBoxLayout()
        row.addWidget(self.strip_tags)
        row.addStretch()
        row.addWidget(self.reset_button)
        form.addRow(row)
        self.settings.hide()
        self.settings_button.toggled.connect(self.settings.setVisible)
        controls.addWidget(self.settings)
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
        left.setContentsMargins(12, 12, 12, 12)
        self.source_summary = QLabel("文件  ·  0")
        self.source_summary.setObjectName("sectionTitle")
        left.addWidget(self.source_summary)
        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["文件名", "状态"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(1, 76)
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
        right.setContentsMargins(20, 16, 20, 16)
        self.document_title = QLabel("正文预览")
        self.document_title.setObjectName("sectionTitle")
        self.document_title.setWordWrap(True)
        right.addWidget(self.document_title)
        self.document_info = QLabel("SRT 与 TXT 都可以直接拖到这里")
        self.document_info.setObjectName("hint")
        self.document_info.setWordWrap(True)
        right.addWidget(self.document_info)
        self.preview = QPlainTextEdit()
        self.preview.setObjectName("documentReader")
        self.preview.setReadOnly(True)
        self.preview.setMinimumWidth(0)
        self.preview.setPlaceholderText("让字幕回到文字本身。\n\n添加文件后，这里会显示整理后的正文。\n时间轴和序号会自动去除，原文件不会改变。")
        right.addWidget(self.preview, 1)
        self.splitter.addWidget(library)
        self.splitter.addWidget(reader)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([280, 580])
        outer.addWidget(self.splitter, 1)

        self.footer = QWidget()
        footer = QVBoxLayout(self.footer)
        footer.setContentsMargins(0, 0, 0, 0)
        self.summary = QLabel("添加文件后自动预览 · 原文件始终保留")
        self.summary.setObjectName("hint")
        self.summary.setWordWrap(True)
        footer.addWidget(self.summary)
        actions = QHBoxLayout()
        self.more_button = QPushButton("其他保存方式")
        menu = QMenu(self.more_button)
        menu.addAction("复制原字幕到…", lambda: self.save_other("copy"))
        menu.addAction("另存为带时间轴的 TXT…", lambda: self.save_other("raw"))
        self.more_button.setMenu(menu)
        self.more_button.setToolTip("单独保存列表中的 SRT；不修改原文件，不与正文导出组合执行")
        self.more_button.setEnabled(False)
        actions.addWidget(self.more_button)
        actions.addStretch()
        self.preview_button = QPushButton("更新预览")
        self.preview_button.clicked.connect(self.prepare)
        self.export_button = QPushButton("导出正文…")
        self.export_button.setObjectName("primary")
        self.export_button.setEnabled(False)
        self.export_button.clicked.connect(self.export)
        actions.addWidget(self.preview_button)
        actions.addWidget(self.export_button)
        footer.addLayout(actions)
        outer.addWidget(self.footer)
        for widget in (self.encoding, self.output_encoding, self.layout_choice):
            widget.currentIndexChanged.connect(self.invalidate)
        self.strip_tags.toggled.connect(self.invalidate)

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
            self.scan_folders(folders)
        else:
            self.prepare()

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
        self.window.start_task(operation, self.scanned)

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
        self.pending_preview = bool(self.paths) and not cancelled

    def on_idle(self):
        if self.pending_preview:
            self.pending_preview = False
            self.prepare()

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
        self.more_button.setEnabled(any(path.suffix.lower() == ".srt" for path in self.paths))
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
        self.results = []
        self.pending_preview = False
        self.preview.clear()
        self.document_title.setText("正文预览")
        self.document_info.setText("点击更新预览以应用文字设置" if self.paths else "SRT 与 TXT 都可以直接拖到这里")
        self.export_button.setEnabled(False)
        self.export_button.setText("导出正文…")
        self.summary.setText(f"{len(self.paths)} 个文件 · 预览后即可导出" if self.paths else "添加文件后自动预览 · 原文件始终保留")
        self.refresh_files()

    def prepare(self):
        if not self.paths or self.window.worker:
            return
        paths, options = list(self.paths), self.options()
        self.invalidate()
        self.summary.setText("正在读取字幕…")
        self.window.start_task(lambda cancel, progress: prepare_documents(paths, options, cancel=cancel, progress=progress), self.prepared)

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
        self.summary.setText(f"{valid} 个文件可导出" + (f" · {len(results) - valid} 个读取失败，点击查看原因" if valid < len(results) else " · 直接保存到所选文件夹，同名自动编号"))
        self.export_button.setText(f"导出正文（{valid}）…")
        self.export_button.setEnabled(valid > 0)
        self.show_preview()

    def show_preview(self):
        row = self.table.currentRow()
        if not 0 <= row < len(self.results):
            return
        result = self.results[row]
        self.document_title.setText(result.source.name)
        self.document_title.setToolTip(str(result.source))
        if isinstance(result, Prepared):
            detail = f"{result.cue_count} 条字幕 · " if result.cue_count is not None else ""
            self.document_info.setText(detail + f"{len(result.preview):,} 字符 · 整理后的正文")
            text = result.preview
            suffix = "\n[仅显示前 50,000 字符；导出保留全文]" if len(text) > 50_000 else ""
            self.preview.setPlainText(text[:50_000] + suffix)
        else:
            self.document_info.setText("无法生成正文，请检查文件或读取编码")
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
        output = self.choose_destination("保存正文到（直接保存，不创建分类文件夹）")
        if output is None:
            return
        items, relatives = list(self.results), dict(self.relatives)
        self.export_button.setEnabled(False)
        self.window.start_task(lambda cancel, progress: export_documents(items, output, relatives, cancel, progress), self.exported)

    def save_other(self, kind):
        if self.window.worker:
            return
        output = self.choose_destination("复制原字幕到" if kind == "copy" else "保存带时间轴的 TXT 到")
        if output is None:
            return
        paths, options, relatives = list(self.paths), self.options(), dict(self.relatives)
        def operation(cancel, progress):
            items = prepare_documents(paths, options, kind, cancel, progress)
            return export_documents(items, output, relatives, cancel, progress)
        self.window.start_task(operation, lambda results: self.exported(results, secondary=kind))

    def exported(self, results, secondary=False):
        action = "复制字幕" if secondary == "copy" else "保存带时间轴的 TXT" if secondary else "导出正文"
        for row, result in enumerate(results):
            state = "已保存" if isinstance(result, Path) else "未保存"
            self.table.item(row, 1).setText(state)
            self.table.item(row, 1).setToolTip(str(result) if isinstance(result, Path) else result.message)
            self.window.log(f"{action}：{result}" if isinstance(result, Path) else f"{action} · {result.source.name}：{result.message}")
        success = sum(isinstance(result, Path) for result in results)
        self.summary.setText(f"{action}：已保存 {success} 个文件 · 未保存 {len(results) - success} 个 · 原文件保留")
        self.summary.setToolTip(str(self.output_directory))
        if not secondary:
            self.export_button.setEnabled(False)
            self.export_button.setText("已导出 · 可更新预览")

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and not self.window.worker:
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.add_files([Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()])
        event.acceptProposedAction()
