"""Turn segments into a plain-text transcript and write it without ever leaving a half file."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from .engine import Segment


def render(segments: Iterable[Segment]) -> str:
    """One utterance per line — easy to read, diff and paste."""
    lines = [s.text for s in segments]
    return "\n".join(lines) + "\n" if lines else ""


def write_atomic(path: Path, text: str) -> None:
    """Write next to the target, then swap it in, so readers never see a partial transcript."""
    temp = path.with_name(f".{path.name}.part")
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
    except PermissionError as exc:
        temp.unlink(missing_ok=True)
        raise PermissionError(f"書き込めません：{path.parent}（読み取り専用か、ファイルが開かれています）") from exc
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
