"""Desktop shell: a WebView2 window that talks to the job queue."""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import webview
from webview.dom import DOMEventHandler

from . import __version__
from .engine import Engine
from .jobs import FINISHED, JobQueue
from .media import AUDIO_EXTENSIONS, SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS

log = logging.getLogger("mojiokoshi")

WEB = Path(__file__).with_name("web")
INK = {"dark": "#0b0b0c", "light": "#efebe2"}
PAPER = {"dark": "#ece8df", "light": "#151413"}


class Bridge:
    """Everything the page may call lives on ``window.pywebview.api``."""

    def __init__(self, app: "App") -> None:
        self._app = app

    def hello(self) -> dict:
        return self._app.hello()

    def browse(self) -> None:
        self._app.browse()

    def cancel(self, job_id: str) -> None:
        self._app.queue.cancel(job_id)

    def reveal(self, path: str) -> None:
        if Path(path).exists():
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])

    def open(self, path: str) -> None:
        if Path(path).exists():
            os.startfile(path)  # noqa: S606 - user-initiated, local file

    def read(self, path: str) -> str:
        return Path(path).read_text(encoding="utf-8")

    def theme(self, scheme: str) -> None:
        self._app.paint_title_bar(scheme)

    def quit(self) -> None:
        self._app.quit()


class App:
    def __init__(self, model: str, device: str, language: str | None) -> None:
        self.engine = Engine(model, device, on_state=lambda s: self.emit("engine:state", s))
        self.queue = JobQueue(self.engine, self.emit, language)
        self.window: webview.Window | None = None
        self._ready = threading.Event()
        self._force_close = False
        self._outbox: queue.SimpleQueue[tuple[str, dict]] = queue.SimpleQueue()
        threading.Thread(target=self._pump, name="mojiokoshi-ui-pump", daemon=True).start()

    # ---------------------------------------------------------------- events
    def emit(self, event: str, payload: dict) -> None:
        """Called from worker threads. Never blocks on the UI thread."""
        if self._ready.is_set():
            self._outbox.put((event, payload))
        # Before hello() the page pulls a full snapshot instead, so nothing is lost.

    def _pump(self) -> None:
        # run_js waits for the UI thread; doing that per segment would throttle the
        # GPU worker. Coalesce bursts into one call per frame-ish instead.
        while True:
            batch = [self._outbox.get()]
            time.sleep(1 / 30)
            while True:
                try:
                    batch.append(self._outbox.get_nowait())
                except queue.Empty:
                    break
            script = f"window.mojiokoshi&&window.mojiokoshi.batch({json.dumps(batch, ensure_ascii=False)})"
            try:
                self.window.run_js(script)
            except Exception:
                pass  # window is closing

    def hello(self) -> dict:
        self._ready.set()
        return {
            "version": __version__,
            "engine": self.engine.snapshot(),
            "jobs": [job.to_dict() for job in self.queue._jobs.values()],
            "extensions": {
                "video": sorted(e[1:] for e in VIDEO_EXTENSIONS),
                "audio": sorted(e[1:] for e in AUDIO_EXTENSIONS),
            },
        }

    def add(self, paths: list[str]) -> None:
        if not paths:
            return
        jobs, rejected = self.queue.add(paths)
        if rejected:
            self.emit("drop:rejected", {"names": [p.name for p in rejected]})

    def browse(self) -> None:
        # pywebview only accepts "[A-Za-z0-9_ ] (*.ext;*.ext)" filters — no "&".
        patterns = ";".join(f"*{e}" for e in sorted(SUPPORTED_EXTENSIONS))
        try:
            chosen = self.window.create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=True,
                file_types=(f"Audio and video ({patterns})", "All files (*.*)"),
            )
        except Exception:
            log.exception("file dialog failed")
            raise
        self.add(list(chosen or []))

    def on_drop(self, event: dict) -> None:
        try:
            files = event.get("dataTransfer", {}).get("files", [])
            paths = [f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")]
            log.info("drop: %d item(s), %d with a path", len(files), len(paths))
            if files and not paths:
                self.emit("app:toast", {"text": "ファイルの場所を取得できませんでした。「ファイルを選ぶ」から追加してください"})
            self.add(paths)
        except Exception:
            log.exception("drop failed")

    # ---------------------------------------------------------------- window
    def on_loaded(self) -> None:
        # No stop_propagation: the page's own drop listener must also see the event
        # to clear the drag-over state.
        self.window.dom.document.events.drop += DOMEventHandler(self.on_drop, prevent_default=True)
        threading.Thread(target=self._warm_up, daemon=True).start()

    def _warm_up(self) -> None:
        try:
            self.engine.ensure_loaded()
        except Exception:
            pass  # surfaced to the UI through engine:state

    def on_closing(self):
        busy = any(j.status not in FINISHED for j in self.queue._jobs.values())
        if busy and not self._force_close:
            self.emit("app:confirm-quit", {})
            return False
        return None

    def quit(self) -> None:
        self._force_close = True
        for job in self.queue._jobs.values():
            job.cancel_event.set()
        self.window.destroy()

    def paint_title_bar(self, scheme: str) -> None:
        """Tint the native Windows 11 caption so it melts into the page."""
        if os.name != "nt" or self.window is None or scheme not in INK:
            return
        try:
            import ctypes

            hwnd = self.window.native.Handle.ToInt32()
            dwm = ctypes.windll.dwmapi

            def attr(key: int, value: int) -> None:
                v = ctypes.c_int(value)
                dwm.DwmSetWindowAttribute(hwnd, key, ctypes.byref(v), ctypes.sizeof(v))

            attr(20, 1 if scheme == "dark" else 0)  # DWMWA_USE_IMMERSIVE_DARK_MODE
            attr(35, _colorref(INK[scheme]))  # DWMWA_CAPTION_COLOR
            attr(34, _colorref(INK[scheme]))  # DWMWA_BORDER_COLOR
            attr(36, _colorref(PAPER[scheme]))  # DWMWA_TEXT_COLOR
        except Exception:
            pass  # cosmetic only

    def set_icon(self) -> None:
        try:
            from System import Action  # pythonnet, provided by pywebview on Windows
            from System.Drawing import Icon

            form = self.window.native
            icon = Icon(str(WEB / "icon.ico"))
            form.Invoke(Action(lambda: setattr(form, "Icon", icon)))
        except Exception:
            pass  # cosmetic only

    def on_shown(self, scheme: str) -> None:
        self.paint_title_bar(scheme)
        self.set_icon()

    def run(self, debug: bool = False) -> None:
        scheme = _system_scheme()
        width, height = _initial_size()
        self.window = webview.create_window(
            "mojiokoshi",
            url=str(WEB / "index.html"),
            js_api=Bridge(self),
            width=width,
            height=height,
            min_size=(980, 660),
            background_color=INK[scheme],
            text_select=True,
        )
        self.window.events.loaded += self.on_loaded
        self.window.events.closing += self.on_closing
        self.window.events.shown += lambda: self.on_shown(scheme)
        if os.name == "nt":
            # Group under our own taskbar entry and icon rather than python.exe's.
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("mojiokoshi.app")
        webview.start(debug=debug, private_mode=False, storage_path=str(_data_dir() / "webview"))


def _initial_size() -> tuple[int, int]:
    """1320×860 where it fits; otherwise leave a margin so the window clears the taskbar."""
    try:
        screen = webview.screens[0]
        return min(1320, int(screen.width * 0.88)), min(860, int(screen.height * 0.86))
    except Exception:
        return 1200, 760


def _colorref(hex_color: str) -> int:
    r, g, b = (int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    return r | g << 8 | b << 16


def _system_scheme() -> str:
    try:
        import winreg

        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        light, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        return "light" if light else "dark"
    except OSError:
        return "dark"


def _data_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home())
    path = base / "mojiokoshi"
    path.mkdir(parents=True, exist_ok=True)
    return path


def run(model: str, device: str, language: str | None, debug: bool = False) -> None:
    logfile = _data_dir() / "mojiokoshi.log"
    if sys.stdout is None or sys.stderr is None:  # pythonw: give tqdm & friends somewhere to write
        stream = open(logfile, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    logging.basicConfig(
        filename=logfile,
        encoding="utf-8",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    App(model, device, language).run(debug=debug)
