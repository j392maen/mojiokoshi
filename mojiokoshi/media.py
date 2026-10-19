"""Media discovery, decoding and waveform peaks."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 16_000

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
SUPPORTED_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS


class MediaError(Exception):
    """A file that cannot be turned into audio. The message is shown to the user."""


def is_supported(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS


def expand(paths: list[str | Path]) -> tuple[list[Path], list[Path]]:
    """Resolve dropped paths into (supported files, rejected paths).

    Folders are expanded one level deep so dropping a folder of recordings just works.
    """
    accepted: list[Path] = []
    rejected: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            children = sorted(p for p in path.iterdir() if is_supported(p))
            (accepted.extend(children) if children else rejected.append(path))
        elif is_supported(path):
            accepted.append(path)
        else:
            rejected.append(path)

    unique: dict[Path, None] = {}
    for p in accepted:
        unique.setdefault(p.resolve(), None)
    return list(unique), rejected


def output_path_for(source: Path) -> Path:
    """Same folder, same name, ``.txt``."""
    return source.with_suffix(".txt")


def decode(
    path: Path,
    on_progress: Callable[[float, float], None] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> np.ndarray:
    """Decode any container (mp4, wav, ...) to 16 kHz mono float32 via PyAV.

    ``on_progress(fraction, duration_sec)`` is called as decoding advances.
    """
    import av

    try:
        container = av.open(str(path), mode="r")
    except Exception as exc:  # PyAV raises a zoo of exception types
        raise MediaError(f"ファイルを開けませんでした（{exc.__class__.__name__}）") from exc

    chunks: list[np.ndarray] = []
    with container:
        if not container.streams.audio:
            raise MediaError("音声トラックが見つかりません")
        stream = container.streams.audio[0]
        stream.thread_type = "AUTO"
        duration = _duration_of(container, stream)
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        last_report = -1.0
        try:
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
                if on_progress and duration and frame.time is not None and frame.time - last_report >= 5:
                    last_report = frame.time
                    if should_stop():
                        raise InterruptedError
                    on_progress(min(frame.time / duration, 1.0), duration)
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
        except av.error.FFmpegError as exc:
            if not chunks:
                raise MediaError(f"デコードできませんでした（{exc.__class__.__name__}）") from exc
            # A truncated tail is common in recordings; keep what decoded cleanly.

    if not chunks:
        raise MediaError("音声トラックが空です")
    return (np.concatenate(chunks).astype(np.float32) / 32768.0)


def _duration_of(container, stream) -> float:
    if stream.duration and stream.time_base:
        return float(stream.duration * stream.time_base)
    if container.duration:
        return container.duration / 1_000_000
    return 0.0


def peaks(audio: np.ndarray, bins: int = 4000, range_db: float = 24.0) -> list[float]:
    """Loudness envelope for drawing (0..1).

    Speech sits in a narrow loudness band, so a linear scale draws a flat wall.
    Mapping the top ``range_db`` decibels to 0..1 keeps the texture of phrases
    and pauses visible even for a 1-hour lecture.
    """
    bins = max(1, min(bins, audio.size))
    usable = audio.size - audio.size % bins
    if usable <= 0:
        return [0.0] * bins
    frames = audio[:usable].reshape(bins, -1).astype(np.float64)
    db = 20 * np.log10(np.sqrt(np.mean(frames**2, axis=1)) + 1e-9)
    # Anchor at the loudest moments, but never let near-silence (< -60 dBFS)
    # be stretched up into a full-height waveform.
    ceiling = max(float(np.percentile(db, 99.5)), -60.0 + range_db)
    env = np.clip((db - (ceiling - range_db)) / range_db, 0.0, 1.0) ** 1.4
    return [round(float(v), 3) for v in env]
