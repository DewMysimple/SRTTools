"""One visible, composable workflow: sources, tasks, output plan, execution."""
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QFormLayout, QFrame,
    QGridLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QPlainTextEdit,
    QPushButton, QSizePolicy, QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .service import Failure, Options, Prepared
from .workflow import Discovery, TASKS, discover, execute, plan


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
        self.setAcceptDrops(True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(22, 18, 22, 12)
        title = QLabel("SRT 综合工作台")
        title.setObjectName("pageTitle")
        outer.addWidget(title)
        hint = QLabel("批量导入 · 组合任务 · 预览输出 · 一次执行")
        hint.setObjectName("hint")
        outer.addWidget(hint)

        self.controls = QWidget()
        controls = QVBoxLayout(self.controls)
        controls.setContentsMargins(0, 4, 0, 0)
        toolbar = QHBoxLayout()
        self.add_button = QPushButton("＋ 文件")
        self.add_button.clicked.connect(self.choose_files)
        self.folder_button = QPushButton("＋ 文件夹")
        self.folder_button.clicked.connect(self.choose_folder)
        self.recursive = QCheckBox("包含子文件夹")
        self.recursive.setChecked(True)
        self.recursive.setToolTip("文件夹扫描和拖入文件夹时生效；跳过 Text、SRT、Original、Clean 输出目录及链接")
        remove = QPushButton("移除选中")
        remove.clicked.connect(self.remove_files)
        clear = QPushButton("清空")
        clear.clicked.connect(self.clear_files)
        for widget in (self.add_button, self.folder_button, self.recursive):
            toolbar.addWidget(widget)
        toolbar.addStretch()
        toolbar.addWidget(remove)
        toolbar.addWidget(clear)
        controls.addLayout(toolbar)
        self.source_summary = QLabel("01  来源文件 · 可拖入 SRT、TXT 或文件夹")
        self.source_summary.setObjectName("hint")
        controls.addWidget(self.source_summary)
        self.files = self.make_table(["来源文件", "扫描相对目录"], 76)
        self.files.setMaximumHeight(90)
        controls.addWidget(self.files)
        self.scan_status = QLabel()
        self.scan_status.setWordWrap(True)
        self.scan_status.setVisible(False)
        controls.addWidget(self.scan_status)
        task_heading = QHBoxLayout()
        task_heading.addWidget(QLabel("02  选择要完成的任务 · 可多选组合"), 1)
        self.reset_button = QPushButton("重置选项")
        self.reset_button.setToolTip("恢复正文提取和默认参数，保留文件、扫描记录和输出位置")
        self.reset_button.clicked.connect(self.reset_options)
        task_heading.addWidget(self.reset_button)
        controls.addLayout(task_heading)
        cards = QGridLayout()
        self.tasks = {}
        descriptions = {
            "text": "去掉序号与时间轴 → Text/",
            "archive": "原字节复制，保留来源 → SRT/ 或 Text/SRT/",
            "raw": "保留编码、序号与时间轴 → Original/",
            "clean": "清理 TXT / SRT 中的字幕结构 → Clean/",
        }
        for index, (task, label) in enumerate(TASKS.items()):
            card = QFrame()
            card.setObjectName("taskCard")
            content = QVBoxLayout(card)
            content.setContentsMargins(10, 7, 10, 7)
            content.setSpacing(3)
            toggle = QCheckBox(label)
            toggle.setChecked(task == "text")
            self.tasks[task] = toggle
            content.addWidget(toggle)
            description = QLabel(descriptions[task])
            description.setObjectName("hint")
            description.setWordWrap(True)
            content.addWidget(description)
            cards.addWidget(card, index // 2, index % 2)
        controls.addLayout(cards)

        self.settings_button = QPushButton("展开文本设置 · 编码 / 排版 / 样式")
        self.settings_button.setCheckable(True)
        self.settings = QWidget()
        form = QFormLayout(self.settings)
        form.setContentsMargins(0, 2, 0, 2)
        self.encoding = choice([("自动 · UTF-8 / BOM", "auto"), ("UTF-8", "utf-8-sig"),
                                ("UTF-16（含 BOM）", "utf-16"), ("简体中文 GB18030", "gb18030"),
                                ("繁体中文 Big5", "big5"), ("西欧 Windows-1252", "cp1252")])
        self.output_encoding = choice([("UTF-8", "utf-8"), ("UTF-8（含 BOM）", "utf-8-sig"), ("UTF-16", "utf-16")])
        self.layout_choice = choice([("保留分行与段落", "keep"), ("每条字幕一行", "lines"), ("合并为一段", "paragraph")])
        self.strip_tags = QCheckBox("去除常见字幕样式标签")
        form.addRow("读取编码", self.encoding)
        output_settings = QHBoxLayout()
        output_settings.addWidget(self.output_encoding)
        output_settings.addWidget(self.layout_choice)
        form.addRow("正文输出", output_settings)
        form.addRow("", self.strip_tags)
        self.settings.setVisible(False)
        self.settings_button.toggled.connect(self.toggle_settings)
        controls.addWidget(self.settings_button)
        controls.addWidget(self.settings)

        output_row = QHBoxLayout()
        self.beside = QCheckBox("在来源旁生成")
        self.beside.setToolTip("每个来源的父目录下创建 Text / SRT 等输出子目录，不移动来源")
        self.output = QLineEdit()
        self.output.setPlaceholderText("选择输出根目录；扫描的子目录层级会保留")
        self.browse = QPushButton("输出位置…")
        self.browse.clicked.connect(self.choose_output)
        output_row.addWidget(self.beside)
        output_row.addWidget(self.output, 1)
        output_row.addWidget(self.browse)
        controls.addLayout(output_row)
        self.route_hint = QLabel()
        self.route_hint.setObjectName("hint")
        self.route_hint.setWordWrap(True)
        controls.addWidget(self.route_hint)
        outer.addWidget(self.controls)

        self.table = self.make_table(["来源 / 任务", "计划输出（同名自动编号）", "状态"], 88)
        self.table.itemSelectionChanged.connect(self.show_preview)
        self.preview = QPlainTextEdit()
        self.preview.setReadOnly(True)
        self.preview.setMinimumHeight(75)
        self.preview.setPlaceholderText("03  先预览计划，再选择某一任务查看内容。预览不创建文件或目录。")
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Ignored)
        splitter.setMinimumHeight(168)
        splitter.addWidget(self.table)
        splitter.addWidget(self.preview)
        splitter.setSizes([150, 170])
        outer.addWidget(splitter, 1)
        self.footer = QWidget()
        footer = QHBoxLayout(self.footer)
        footer.setContentsMargins(0, 0, 0, 0)
        self.summary = QLabel("等待添加文件")
        self.summary.setWordWrap(True)
        footer.addWidget(self.summary, 1)
        self.preview_button = QPushButton("预览任务计划")
        self.preview_button.clicked.connect(self.prepare)
        self.export_button = QPushButton("执行有效任务")
        self.export_button.setObjectName("primary")
        self.export_button.setEnabled(False)
        self.export_button.clicked.connect(self.export)
        footer.addWidget(self.preview_button)
        footer.addWidget(self.export_button)
        outer.addWidget(self.footer)
        for toggle in self.tasks.values():
            toggle.toggled.connect(self.task_changed)
        for widget in (self.encoding, self.output_encoding, self.layout_choice):
            widget.currentIndexChanged.connect(self.invalidate)
        self.strip_tags.toggled.connect(self.invalidate)
        self.output.textChanged.connect(self.invalidate)
        self.beside.toggled.connect(self.output_changed)
        self.task_changed()

    @staticmethod
    def make_table(headers, height):
        table = QTableWidget(0, len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        table.verticalHeader().hide()
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.setMinimumHeight(height)
        return table

    def toggle_settings(self, visible):
        self.settings.setVisible(visible)
        self.settings_button.setText(("收起" if visible else "展开") + "文本设置 · 编码 / 排版 / 样式")

    def selected_tasks(self):
        return tuple(task for task, toggle in self.tasks.items() if toggle.isChecked())

    def task_changed(self):
        tasks = self.selected_tasks()
        text_enabled = "text" in tasks or "clean" in tasks
        for widget in (self.output_encoding, self.layout_choice, self.strip_tags):
            widget.setEnabled(text_enabled)
        routes = []
        if "text" in tasks:
            routes.append("正文 → Text/")
        if "archive" in tasks:
            routes.append("字幕副本 → " + ("Text/SRT/" if "text" in tasks else "SRT/"))
        if "raw" in tasks:
            routes.append("原样 TXT → Original/")
        if "clean" in tasks:
            routes.append("清理文本 → Clean/")
        self.route_hint.setText("；".join(routes) or "请至少勾选一项任务。")
        self.invalidate()

    def output_changed(self):
        self.output.setEnabled(not self.beside.isChecked())
        self.browse.setEnabled(not self.beside.isChecked())
        self.invalidate()

    def reset_options(self):
        for task, toggle in self.tasks.items():
            toggle.setChecked(task == "text")
        for widget in (self.encoding, self.output_encoding, self.layout_choice):
            widget.setCurrentIndex(0)
        self.strip_tags.setChecked(False)
        self.recursive.setChecked(True)
        self.invalidate()

    def options(self):
        return Options(encoding=self.encoding.currentData(), output_encoding=self.output_encoding.currentData(),
                       layout=self.layout_choice.currentData(), strip_tags=self.strip_tags.isChecked())

    def choose_files(self):
        names, _ = QFileDialog.getOpenFileNames(self, "添加字幕或文本", "", "字幕和文本 (*.srt *.txt)")
        self.add_files([Path(name) for name in names])

    def choose_folder(self):
        directory = QFileDialog.getExistingDirectory(self, "扫描文件夹")
        if directory:
            self.scan_folders([Path(directory)])

    def scan_folders(self, roots):
        recursive = self.recursive.isChecked()
        excluded = Path(self.output.text()).absolute() if self.output.text().strip() and not self.beside.isChecked() else None
        def operation(cancel, progress):
            results = []
            for root in roots:
                if cancel.is_set():
                    results.append((root.absolute(), Discovery((), (Failure(root, "扫描已取消，此目录未扫描。"),))))
                    break
                try:
                    results.append((root.absolute(), discover(root, recursive, cancel, progress, excluded)))
                except (OSError, ValueError) as exc:
                    results.append((root.absolute(), Discovery((), (Failure(root, str(exc)),))))
            return results
        self.invalidate()
        self.window.start_task(operation, self.scanned)

    def scanned(self, results):
        for root, discovery in results:
            self.scan_issues.extend(discovery.issues)
            for path in discovery.paths:
                if path not in self.paths:
                    self.paths.append(path)
                    self.relatives[path] = path.parent.relative_to(root)
        self.scan_status.setVisible(bool(self.scan_issues))
        self.scan_status.setText(f"扫描提示 {len(self.scan_issues)} 项（未读取或已跳过）；完整详情见悬停与日志。")
        self.scan_status.setToolTip("\n".join(f"{r.source}：{r.message}" for r in self.scan_issues))
        for _, discovery in results:
            for issue in discovery.issues:
                self.window.log(f"扫描：{issue.source} · {issue.message}")
        self.refresh_files()
        self.window.log(f"扫描完成：列表共 {len(self.paths)} 个文件；提示 {len(self.scan_issues)} 项。")

    def add_files(self, paths):
        if self.window.worker:
            return
        folders = []
        for original in paths:
            path = original.absolute()
            if path.is_dir():
                folders.append(path)
            elif path not in self.paths:
                self.paths.append(path)
                self.relatives[path] = Path()
        self.invalidate()
        self.refresh_files()
        if folders:
            self.scan_folders(folders)

    def refresh_files(self):
        self.files.setRowCount(len(self.paths))
        for row, path in enumerate(self.paths):
            for column, text in enumerate((path.name, str(self.relatives.get(path, Path())))):
                item = QTableWidgetItem(text)
                item.setToolTip(str(path) if column == 0 else text)
                self.files.setItem(row, column, item)
        self.source_summary.setText(f"01  来源文件 · {len(self.paths)} 个 · 拖入文件或文件夹可继续添加")
        self.summary.setText(f"{len(self.paths)} 个来源 · 请预览任务计划")

    def remove_files(self):
        rows = {item.row() for item in self.files.selectedItems()}
        self.paths = [path for index, path in enumerate(self.paths) if index not in rows]
        self.relatives = {path: self.relatives[path] for path in self.paths}
        self.invalidate()
        self.refresh_files()

    def clear_files(self):
        self.paths.clear()
        self.relatives.clear()
        self.scan_issues.clear()
        self.scan_status.hide()
        self.invalidate()
        self.refresh_files()

    def invalidate(self, *_):
        self.results = []
        self.table.setRowCount(0)
        self.preview.clear()
        self.export_button.setEnabled(False)
        self.summary.setText(f"{len(self.paths)} 个来源 · 请预览任务计划")

    def choose_output(self):
        directory = QFileDialog.getExistingDirectory(self, "选择输出根目录", self.output.text())
        if directory:
            self.output.setText(directory)
            self.output.setToolTip(directory)

    def prepare(self):
        if not self.paths:
            self.window.log("请先添加文件或扫描文件夹。")
            return
        if not self.selected_tasks():
            self.window.log("请至少勾选一项任务。")
            return
        if not self.beside.isChecked() and not self.output.text().strip():
            self.window.log("请选择输出根目录，或勾选在来源旁生成。")
            return
        paths, tasks, options = list(self.paths), self.selected_tasks(), self.options()
        directory = None if self.beside.isChecked() else Path(self.output.text())
        relatives = dict(self.relatives)
        self.invalidate()
        self.window.start_task(lambda cancel, progress: plan(paths, tasks, options, directory, relatives, cancel, progress), self.prepared)

    def prepared(self, results):
        self.results = results
        self.table.setRowCount(len(results))
        valid = failed = skipped = 0
        for row, item in enumerate(results):
            if isinstance(item.result, Prepared):
                valid += 1
                state = f"就绪 · {len(item.result.data):,} 字节"
                for warning in item.result.warnings:
                    self.window.log(f"{item.source.name} / {TASKS[item.task]}：{warning}")
            elif isinstance(item.result, Failure):
                failed += 1
                state = "失败 · " + item.result.message
            else:
                skipped += 1
                state = item.message
            for column, text in enumerate((f"{item.source.name} · {TASKS[item.task]}", str(item.target), state)):
                cell = QTableWidgetItem(text)
                cell.setToolTip(str(item.source) if column == 0 else text)
                self.table.setItem(row, column, cell)
        self.summary.setText(f"{valid} 项就绪 · {failed} 项失败 · {skipped} 项不适用")
        self.export_button.setText(f"执行 {valid} 项有效任务")
        self.export_button.setEnabled(valid > 0)
        self.window.log("任务计划：" + self.summary.text() + "；预览未写入任何文件。")
        if results:
            self.table.selectRow(0)

    def show_preview(self):
        row = self.table.currentRow()
        if not 0 <= row < len(self.results):
            return
        item = self.results[row]
        result = item.result
        text = result.preview if isinstance(result, Prepared) else result.message if isinstance(result, Failure) else item.message
        suffix = "\n[仅显示前 50,000 字符；输出保留全文]" if len(text) > 50_000 else ""
        self.preview.setPlainText(f"{TASKS[item.task]} → {item.target}\n\n{text[:50_000]}{suffix}")

    def export(self):
        items = [item for item in self.results if isinstance(item.result, Prepared)]
        if not items or self.window.worker:
            return
        self.export_button.setEnabled(False)
        self.window.start_task(lambda cancel, progress: execute(items, cancel, progress), self.exported)

    def exported(self, results):
        rows = [index for index, item in enumerate(self.results) if isinstance(item.result, Prepared)]
        for row, result in zip(rows, results):
            state = "已完成" if isinstance(result, Path) else "失败 / 取消 · " + result.message
            self.table.item(row, 2).setText(state)
            self.table.item(row, 2).setToolTip(state)
            if isinstance(result, Path):
                self.table.item(row, 1).setText(str(result))
                self.table.item(row, 1).setToolTip(str(result))
            self.window.log(f"已生成：{result}" if isinstance(result, Path) else f"{result.source.name}：{result.message}")
        success = sum(isinstance(result, Path) for result in results)
        self.summary.setText(f"已生成 {success} 个文件 · 失败 / 取消 {len(results) - success} 项 · 来源保留")
        self.export_button.setEnabled(False)

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and not self.window.worker:
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.add_files([Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()])
        event.acceptProposedAction()
