"""Speech-to-text engine: model download, GPU→CPU fallback, and transcription."""

from __future__ import annotations

import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from . import cuda
from .media import SAMPLE_RATE

# Plain HTTP downloads write into the cache progressively, which lets us report
# byte progress; the Xet backend only materialises files at the very end.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

DEFAULT_MODEL = "large-v3-turbo"
_MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]


@dataclass(frozen=True)
class Segment:
    index: int
    start: float
    end: float
    text: str


class Engine:
    """Thread-safe, lazily loaded faster-whisper model.

    ``on_state`` receives a snapshot dict whenever the engine state changes, so the
    UI can show downloading / loading / ready without polling.
    """

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        device: str = "auto",
        on_state: Callable[[dict], None] | None = None,
    ) -> None:
        self.model_name = model
        self.requested_device = device
        self.state = "idle"
        self.device: str | None = None
        self.device_label: str | None = None
        self.compute_type: str | None = None
        self.download_progress = 0.0
        self.error: str | None = None
        self._on_state = on_state or (lambda _: None)
        self._model = None
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- state
    def snapshot(self) -> dict:
        return {
            "model": self.model_name,
            "state": self.state,
            "device": self.device,
            "deviceLabel": self.device_label,
            "computeType": self.compute_type,
            "downloadProgress": round(self.download_progress, 4),
            "error": self.error,
        }

    def _set(self, state: str, **changes) -> None:
        self.state = state
        for key, value in changes.items():
            setattr(self, key, value)
        self._on_state(self.snapshot())

    # --------------------------------------------------------------- loading
    def ensure_loaded(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            try:
                path = self._fetch()
                self._load(path)
            except Exception as exc:
                self._set("error", error=str(exc) or exc.__class__.__name__)
                raise

    def _fetch(self) -> str:
        if Path(self.model_name).is_dir():
            return self.model_name

        from faster_whisper.utils import _MODELS
        from huggingface_hub import snapshot_download

        repo_id = _MODELS.get(self.model_name, self.model_name)
        try:
            return snapshot_download(repo_id, allow_patterns=_MODEL_FILES, local_files_only=True)
        except Exception:
            pass  # not cached yet

        self._set("downloading", download_progress=0.0)
        done = threading.Event()
        watcher = threading.Thread(target=self._watch_download, args=(repo_id, done), daemon=True)
        watcher.start()
        try:
            return snapshot_download(repo_id, allow_patterns=_MODEL_FILES)
        finally:
            done.set()
            watcher.join(timeout=1)

    def _watch_download(self, repo_id: str, done: threading.Event) -> None:
        """Report byte progress by watching the HF cache folder grow."""
        from fnmatch import fnmatch

        from huggingface_hub import HfApi, constants
        from huggingface_hub.file_download import repo_folder_name

        try:
            info = HfApi().model_info(repo_id, files_metadata=True)
            total = sum(
                s.size or 0
                for s in info.siblings
                if any(fnmatch(s.rfilename, pattern) for pattern in _MODEL_FILES)
            )
        except Exception:
            return
        folder = Path(constants.HF_HUB_CACHE) / repo_folder_name(repo_id=repo_id, repo_type="model")
        while not done.wait(0.4):
            try:
                size = sum(f.stat().st_size for f in folder.rglob("*") if f.is_file() and not f.is_symlink())
            except OSError:
                continue
            progress = min(size / total, 0.995) if total else 0.0
            if progress - self.download_progress >= 0.002:
                self._set("downloading", download_progress=progress)

    def _load(self, path: str) -> None:
        from faster_whisper import WhisperModel

        self._set("loading")
        candidates: list[tuple[str, str]] = []
        if self.requested_device in ("auto", "cuda"):
            cuda.register_dll_dirs()
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                candidates.append(("cuda", "float16"))
        if self.requested_device in ("auto", "cpu"):
            candidates.append(("cpu", "int8"))

        last_error: Exception | None = None
        for device, compute_type in candidates:
            try:
                model = WhisperModel(
                    path,
                    device=device,
                    compute_type=compute_type,
                    cpu_threads=max(4, (os.cpu_count() or 8) // 2),
                )
                # Warm-up surfaces missing cuDNN / driver problems now rather than mid-job.
                model.detect_language(np.zeros(SAMPLE_RATE, dtype=np.float32))
            except Exception as exc:
                last_error = exc
                continue
            self._model = model
            self._set(
                "ready",
                device=device,
                compute_type=compute_type,
                device_label=_gpu_name() if device == "cuda" else "CPU",
                download_progress=1.0,
                error=None,
            )
            return
        raise RuntimeError(f"モデルを読み込めませんでした: {last_error}")

    # ---------------------------------------------------------- transcribing
    def detect_language(self, audio: np.ndarray) -> tuple[str, float]:
        """Decide the language from the first 90 s of sound.

        Running VAD over a whole lecture just for this costs ~7 s; skipping the
        leading silence and listening to a short stretch costs ~0.2 s.
        """
        self.ensure_loaded()
        second = SAMPLE_RATE
        frames = audio[: audio.size - audio.size % second].reshape(-1, second)
        loud = np.flatnonzero(np.sqrt(np.mean(frames**2, axis=1)) > 0.005)  # ≈ -46 dBFS
        start = int(loud[0]) * second if loud.size else 0
        language, probability, _ = self._model.detect_language(
            audio[start : start + 90 * second], language_detection_segments=3
        )
        return language, float(probability)

    def transcribe(self, audio: np.ndarray, language: str) -> Iterator[Segment]:
        """Yield segments as they are decoded. The call itself runs VAD and feature
        extraction over the whole file, which takes a while for long recordings."""
        self.ensure_loaded()
        raw_segments, _ = self._model.transcribe(
            audio,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # A punctuated prompt + conditioning keeps the punctuation style across the
            # whole file; faster-whisper resets the prompt whenever it falls back on
            # temperature, which is what keeps long recordings out of repetition loops.
            initial_prompt=_STYLE_PROMPTS.get(language),
            condition_on_previous_text=True,
        )
        index = 0
        for s in raw_segments:
            text = s.text.strip()
            if not text:
                continue
            yield Segment(index, float(s.start), float(s.end), text)
            index += 1


# Whisper copies the punctuation style of its prompt. Without one, Japanese and
# Chinese often come back as unpunctuated, space-separated phrases.
_STYLE_PROMPTS = {
    "ja": "はい、それでは、始めましょう。よろしくお願いします。",
    "zh": "好的，我们现在开始。请多关照。",
}


def _gpu_name() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
        name = out.splitlines()[0] if out else ""
    except (OSError, subprocess.SubprocessError):
        name = ""
    return name.replace("NVIDIA ", "").replace("GeForce ", "") or "CUDA GPU"

