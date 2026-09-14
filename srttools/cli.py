"""Headless command line using the same preparation/export service as the GUI."""
import argparse
from pathlib import Path

from .service import Failure, Options, Prepared, export_batch, prepare_batch
from .subtitles import parse_time


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="SRTTools — 字幕转换与范围导出；始终生成新文件")
    parser.add_argument("mode", choices=["raw", "text", "clean", "range"])
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("-o", "--output", type=Path, help="已存在的输出目录；不提供时仅预览")
    parser.add_argument("--encoding", default="auto", choices=["auto", "utf-8-sig", "utf-16", "gb18030", "big5", "cp1252"])
    parser.add_argument("--output-encoding", default="utf-8", choices=["utf-8", "utf-8-sig", "utf-16"])
    parser.add_argument("--start", default="0", type=parse_time)
    parser.add_argument("--end", default="60", type=parse_time)
    parser.add_argument("--format", default="srt", choices=["srt", "txt"])
    parser.add_argument("--policy", default="overlap", choices=["overlap", "contained", "start"])
    parser.add_argument("--no-clip", action="store_true")
    parser.add_argument("--rebase", action="store_true")
    parser.add_argument("--offset-ms", type=int, default=0)
    parser.add_argument("--strip-tags", action="store_true")
    parser.add_argument("--layout", default="keep", choices=["keep", "lines", "paragraph"])
    args = parser.parse_args(argv)
    options = Options(args.mode, args.encoding, args.output_encoding, args.layout, args.strip_tags,
                      args.format, args.start, args.end, args.policy, not args.no_clip, args.rebase, args.offset_ms)
    results = prepare_batch(args.files, options)
    failed = False
    for result in results:
        if isinstance(result, Failure):
            print(f"失败：{result.source.name} — {result.message}")
            failed = True
        else:
            print(f"{result.source.name} → {result.source.stem}{result.suffix} · {len(result.data)} bytes")
            for warning in result.warnings:
                print(f"提示：{warning}")
            if args.output is None:
                print(result.preview[:2000])
    if args.output:
        for result in export_batch([r for r in results if isinstance(r, Prepared)], args.output):
            if isinstance(result, Failure):
                print(f"失败：{result.source.name} — {result.message}")
                failed = True
            else:
                print(f"已导出：{result}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
