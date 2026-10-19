"""Headless mode: ``python -m mojiokoshi a.mp4 b.wav``."""

from __future__ import annotations

import sys

from .engine import Engine
from .jobs import DONE, FAILED, JobQueue


def run(paths: list[str], model: str, device: str, language: str | None) -> int:
    failures = 0

    def emit(event: str, payload: dict) -> None:
        nonlocal failures
        if event == "engine:state":
            if payload["state"] == "downloading":
                _line(f"モデルをダウンロード中  {payload['downloadProgress']:6.1%}")
            elif payload["state"] == "ready":
                _line(f"エンジン準備完了  {payload['model']} · {payload['deviceLabel']} · {payload['computeType']}", end="\n")
        elif event == "job:segment":
            _line(f"  {payload['progress']:6.1%}  {payload['segment']['text'][:60]}")
        elif event == "job:update":
            if payload["status"] == "decoding" and payload["progress"] == 0:
                _line(f"▸ {payload['name']}", end="\n")
            elif payload["status"] == DONE:
                _line(f"  ✓ {payload['output']}", end="\n")
            elif payload["status"] == FAILED:
                failures += 1
                _line(f"  ✗ {payload['error']}", end="\n")

    engine = Engine(model, device, on_state=lambda s: emit("engine:state", s))
    queue = JobQueue(engine, emit, language)
    jobs, rejected = queue.add(paths)
    for path in rejected:
        print(f"skip  {path}（対応していない形式）", file=sys.stderr)
    if not jobs:
        return 2
    queue.wait()
    return 1 if failures else 0


def _line(text: str, end: str = "") -> None:
    """Overwrite a live status line on a terminal; print only settled lines elsewhere."""
    if sys.stdout.isatty():
        sys.stdout.write("\r\x1b[2K" + text + end)
    elif end:
        sys.stdout.write(text + end)
    sys.stdout.flush()
