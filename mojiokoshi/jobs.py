"""Job domain model and the single worker that runs them in order."""

from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import media, writer
from .engine import Engine, Segment

Emit = Callable[[str, dict], None]

QUEUED, DECODING, TRANSCRIBING, WRITING = "queued", "decoding", "transcribing", "writing"
DONE, FAILED, CANCELED = "done", "failed", "canceled"
FINISHED = {DONE, FAILED, CANCELED}


@dataclass
class Job:
    source: Path
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = QUEUED
    duration: float = 0.0
    progress: float = 0.0
    language: str | None = None
    language_probability: float = 0.0
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    characters: int = 0
    segments: list[Segment] = field(default_factory=list)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def output(self) -> Path:
        return media.output_path_for(self.source)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.source.name,
            "source": str(self.source),
            "directory": str(self.source.parent),
            "output": str(self.output),
            "outputName": self.output.name,
            "size": _size(self.source),
            "status": self.status,
            "duration": self.duration,
            "progress": round(self.progress, 4),
            "language": self.language,
            "languageProbability": round(self.language_probability, 3),
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "error": self.error,
            "characters": self.characters,
            "segmentCount": len(self.segments),
        }


class JobQueue:
    """Serial queue: one GPU, one job at a time; the UI thread never blocks."""

    def __init__(self, engine: Engine, emit: Emit, language: str | None = None) -> None:
        self.engine = engine
        self.language = language
        self._emit = emit
        self._jobs: dict[str, Job] = {}
        self._pending: queue.Queue[Job] = queue.Queue()
        self._worker = threading.Thread(target=self._run, name="mojiokoshi-worker", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------------ API
    def add(self, paths: list[str | Path]) -> tuple[list[Job], list[Path]]:
        files, rejected = media.expand(paths)
        active = {j.source for j in self._jobs.values() if j.status not in FINISHED}
        jobs = []
        for path in files:
            if path in active:
                continue  # already waiting or running
            job = Job(path)
            self._jobs[job.id] = job
            self._pending.put(job)
            jobs.append(job)
            self._emit("job:added", job.to_dict())
        return jobs, rejected

    def cancel(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job is None or job.status in FINISHED:
            return
        job.cancel_event.set()
        if job.status == QUEUED:
            self._finish(job, CANCELED)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def wait(self) -> None:
        """Block until every queued job has finished (CLI use)."""
        self._pending.join()

    # --------------------------------------------------------------- worker
    def _run(self) -> None:
        while True:
            job = self._pending.get()
            try:
                if not job.cancel_event.is_set():
                    self._process(job)
            finally:
                self._pending.task_done()

    def _process(self, job: Job) -> None:
        job.started_at = time.time()
        stop = job.cancel_event.is_set
        try:
            self._update(job, DECODING)
            audio = media.decode(
                job.source,
                on_progress=lambda fraction, duration: self._decode_progress(job, fraction, duration),
                should_stop=stop,
            )
            job.duration = audio.size / media.SAMPLE_RATE
            self._emit("job:waveform", {"id": job.id, "duration": job.duration, "peaks": media.peaks(audio)})

            self.engine.ensure_loaded()
            if stop():
                raise InterruptedError
            if self.language:
                job.language, job.language_probability = self.language, 1.0
            else:
                job.language, job.language_probability = self.engine.detect_language(audio)
            self._update(job, TRANSCRIBING, progress=0.0)

            for segment in self.engine.transcribe(audio, job.language):
                if stop():
                    raise InterruptedError
                job.segments.append(segment)
                job.progress = min(segment.end / job.duration, 0.999) if job.duration else 0.0
                self._emit(
                    "job:segment",
                    {
                        "id": job.id,
                        "progress": round(job.progress, 4),
                        "segment": {"index": segment.index, "start": segment.start, "end": segment.end, "text": segment.text},
                    },
                )

            self._update(job, WRITING)
            text = writer.render(job.segments)
            writer.write_atomic(job.output, text)
            job.characters = sum(len(s.text) for s in job.segments)
            self._finish(job, DONE)
        except InterruptedError:
            self._finish(job, CANCELED)
        except (media.MediaError, PermissionError) as exc:
            self._finish(job, FAILED, str(exc))
        except Exception as exc:  # keep the queue alive whatever happens to one file
            self._finish(job, FAILED, f"{exc.__class__.__name__}: {exc}")

    def _decode_progress(self, job: Job, fraction: float, duration: float) -> None:
        job.duration = duration
        self._update(job, DECODING, progress=fraction)

    def _update(self, job: Job, status: str, **changes) -> None:
        job.status = status
        for key, value in changes.items():
            setattr(job, key, value)
        self._emit("job:update", job.to_dict())

    def _finish(self, job: Job, status: str, error: str | None = None) -> None:
        job.finished_at = time.time()
        self._update(job, status, error=error, progress=1.0 if status == DONE else job.progress)


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0
