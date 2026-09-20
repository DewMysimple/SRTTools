"""Debounced, revision-safe live previews and a complete paged text reader."""
from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout, QWidget


class LivePreview(QObject):
    def __init__(self, page):
        super().__init__(page)
        self.page = page
        self.revision = 0
        self.pending = False
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(180)
        self.timer.timeout.connect(self.start)
        page.window.idle.connect(self.on_idle)

    def request(self, *_):
        self.revision += 1
        self.page.clear_preview()
        self.pending = bool(self.page.paths)
        window = self.page.window
        if window.worker and window.preview_owner is self.page:
            window.worker.cancel.set()
        self.timer.stop()
        if self.pending:
            self.timer.start()

    def start(self):
        self.timer.stop()
        if not self.pending or self.page.window.worker:
            return
        self.pending = False
        revision = self.revision
        try:
            operation = self.page.preview_operation()
        except ValueError as exc:
            self.page.preview_failed(str(exc))
            return
        def completed(results):
            if revision == self.revision:
                self.page.prepared(results)
        def failed(message):
            if revision == self.revision:
                self.page.preview_failed(message)
        self.page.window.start_task(operation, completed, preview_owner=self.page, failed=failed)

    def on_idle(self):
        if self.pending and not self.timer.isActive():
            self.start()

    def cancel(self):
        self.revision += 1
        self.pending = False
        self.timer.stop()
        self.page.clear_preview()
        self.page.preview_failed("预览已取消；修改设置或重新读取即可继续。")


class TextPreview(QWidget):
    """All characters remain accessible; pagination labels never enter the text."""
    PAGE_SIZE = 50_000

    def __init__(self):
        super().__init__()
        self.text = ""
        self.editor = QPlainTextEdit()
        self.editor.setObjectName("documentReader")
        self.editor.setReadOnly(True)
        # A wrapped visual line must not be mistaken for an exported newline.
        self.editor.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.editor.setMinimumWidth(0)
        self.editor.setMinimumHeight(80)
        self.navigation = QWidget()
        row = QHBoxLayout(self.navigation)
        row.setContentsMargins(0, 0, 0, 0)
        self.previous = QPushButton("上一页")
        self.next = QPushButton("下一页")
        self.number = QSpinBox()
        self.number.setPrefix("第 ")
        self.number.setSuffix(" 页")
        self.info = QLabel()
        self.info.setObjectName("hint")
        self.info.setWordWrap(True)
        row.addWidget(self.previous)
        row.addWidget(self.number)
        row.addWidget(self.next)
        row.addWidget(self.info, 1)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.editor, 1)
        layout.addWidget(self.navigation)
        self.previous.clicked.connect(lambda: self.number.setValue(self.number.value() - 1))
        self.next.clicked.connect(lambda: self.number.setValue(self.number.value() + 1))
        self.number.valueChanged.connect(self.show_page)
        self.setPlainText("")

    def setPlainText(self, text):
        # Display CRLF/CR as line breaks; never alter Prepared.data on export.
        self.text = text.replace("\r\n", "\n").replace("\r", "\n")
        pages = max(1, (len(self.text) + self.PAGE_SIZE - 1) // self.PAGE_SIZE)
        self.number.blockSignals(True)
        self.number.setRange(1, pages)
        self.number.setValue(1)
        self.number.blockSignals(False)
        self.navigation.setVisible(pages > 1)
        self.show_page()

    def show_page(self, *_):
        page = self.number.value()
        start = (page - 1) * self.PAGE_SIZE
        self.editor.setPlainText(self.text[start:start + self.PAGE_SIZE])
        self.previous.setEnabled(page > 1)
        self.next.setEnabled(page < self.number.maximum())
        self.info.setText(f"共 {self.number.maximum()} 页\n导出全部页")

    def clear(self):
        self.setPlainText("")

    def toPlainText(self):
        return self.editor.toPlainText()

    def setPlaceholderText(self, text):
        self.editor.setPlaceholderText(text)
