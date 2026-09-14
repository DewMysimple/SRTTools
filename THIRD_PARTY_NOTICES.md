# Third-party components

SRTTools uses unmodified Python 3.14 and PySide6 / Shiboken6 6.11.2 (Qt 6).
Qt dynamic libraries remain replaceable in `_internal`. Application source is
available in the SRTTools repository. No subtitle processing service is contacted.

- Python: PSF license, included in `licenses/Python-LICENSE.txt`.
- PySide6 / Shiboken6 / Qt: LGPL v3 and component licenses. LGPL v3 and GPL v3
  terms are included in `licenses`. Bundled Qt component notices are also in `_internal`.
- PyInstaller: GPL v2 or later with the bootloader exception allowing bundled
  application distribution. Build dependency only; see https://pyinstaller.org/en/stable/license.html .

Qt for Python sources: https://code.qt.io/cgit/pyside/pyside-setup.git/

Qt sources: https://code.qt.io/cgit/qt/

Licensing details: https://doc.qt.io/qtforpython-6/licenses.html

Dependency versions: `requirements.txt` and `requirements-dev.txt` in the source repository.
