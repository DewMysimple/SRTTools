"""Clean Windows onedir build and flat-root portable ZIP."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    if sys.platform != "win32":
        raise SystemExit("请在 Windows 上构建便携 EXE。")
    target = ROOT / "dist" / "SRTTools"
    if target.resolve() != ROOT.resolve() / "dist" / "SRTTools":
        raise SystemExit("拒绝构建到重定向的 dist 目录。")
    check = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "if (Get-Process SRTTools -ErrorAction SilentlyContinue) { exit 1 }"], check=False)
    if check.returncode:
        raise SystemExit("请先退出 SRTTools，再重新构建。")
    from make_icon import make_icon
    make_icon(ROOT / "assets" / "srttools.ico")
    environment = os.environ.copy()
    windows = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    environment["PATH"] = os.pathsep.join(map(str, (
        Path(sys.executable).parent, Path(sys.base_prefix), Path(sys.base_prefix) / "DLLs",
        windows / "System32", windows,
    )))
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
        "--name", "SRTTools", "--manifest", str(ROOT / "windows.manifest"),
        "--icon", str(ROOT / "assets" / "srttools.ico"), "--add-data", f"{ROOT / 'assets'};assets",
        "--exclude-module", "PySide6.QtWebEngineCore", "--exclude-module", "PySide6.QtWebEngineWidgets",
        "--exclude-module", "PySide6.QtQml", "--exclude-module", "PySide6.QtQuick",
        "--exclude-module", "tkinter", "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"),
        str(ROOT / "run_srttools.py"),
    ], cwd=ROOT, env=environment, check=True)
    shutil.copy2(ROOT / "docs" / "使用指南.md", target / "使用说明.md")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", target / "THIRD_PARTY_NOTICES.md")
    shutil.copytree(ROOT / "licenses", target / "licenses", dirs_exist_ok=True)
    shutil.make_archive(str(ROOT / "dist" / "SRTTools"), "zip", root_dir=target)
    archive = ROOT / "dist" / "SRTTools.zip"
    with zipfile.ZipFile(archive) as package:
        assert "SRTTools.exe" in package.namelist()
        assert "SRTTools/SRTTools.exe" not in package.namelist()
        assert package.testzip() is None
    print(target / "SRTTools.exe")
    print(archive)


if __name__ == "__main__":
    main()
