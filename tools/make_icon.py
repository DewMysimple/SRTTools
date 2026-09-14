"""Draw a native vector-style subtitle mark into an ICO; no external assets."""
from pathlib import Path
from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QPen


def make_icon(path: Path):
    canvas = QImage(256, 256, QImage.Format.Format_ARGB32)
    canvas.fill(Qt.GlobalColor.transparent)
    painter = QPainter(canvas)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor("#152b3b"))
    painter.drawRoundedRect(QRectF(4, 4, 248, 248), 52, 52)
    painter.setBrush(QColor("#edf5f7"))
    painter.drawRoundedRect(QRectF(40, 56, 176, 132), 18, 18)
    painter.setPen(QPen(QColor("#166b79"), 12, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
    painter.drawLine(64, 102, 130, 102)
    painter.drawLine(151, 102, 191, 102)
    painter.drawLine(64, 140, 94, 140)
    painter.drawLine(115, 140, 191, 140)
    painter.end()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not canvas.save(str(path), "ICO"):
        raise RuntimeError("图标生成失败")


if __name__ == "__main__":
    make_icon(Path(__file__).resolve().parents[1] / "assets" / "srttools.ico")
