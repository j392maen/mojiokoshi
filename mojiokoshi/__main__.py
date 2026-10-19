"""``python -m mojiokoshi`` opens the window; with file arguments it runs headless."""

from __future__ import annotations

import argparse
import os
import sys

from .engine import DEFAULT_MODEL


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mojiokoshi",
        description="音声・動画を文字起こしし、同じフォルダに同じ名前の .txt を書き出します。",
    )
    parser.add_argument("files", nargs="*", help="音声・動画ファイルまたはフォルダ（省略するとウィンドウを開く）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Whisper モデル名・HF リポジトリ・ローカルパス（既定: {DEFAULT_MODEL}）")
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--language", default=None, help="言語コード（例: ja）。省略時は自動判定")
    parser.add_argument("--debug", action="store_true", help="WebView の開発者ツールを有効化")
    args = parser.parse_args(argv)

    if args.files:
        from . import cli

        return cli.run(args.files, args.model, args.device, args.language)

    from . import gui

    gui.run(args.model, args.device, args.language, debug=args.debug or bool(os.environ.get("MOJIOKOSHI_DEBUG")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
