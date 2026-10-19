"""Make the pip-installed CUDA runtime (cuBLAS / cuDNN) visible to CTranslate2 on Windows.

CTranslate2 4.x needs CUDA 12 + cuDNN 9. Instead of asking users to install the
CUDA Toolkit, we ship the DLLs via the ``nvidia-*-cu12`` wheels and register
their ``bin`` folders before the first model is created.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

_handles: list = []  # keep AddDllDirectory cookies alive for the process lifetime


def register_dll_dirs() -> list[Path]:
    if os.name != "nt":
        return []
    spec = importlib.util.find_spec("nvidia")
    if spec is None or not spec.submodule_search_locations:
        return []

    found: list[Path] = []
    for root in spec.submodule_search_locations:
        for bin_dir in sorted(Path(root).glob("*/bin")):
            if bin_dir in found:
                continue
            found.append(bin_dir)
            _handles.append(os.add_dll_directory(str(bin_dir)))

    if found:
        # CTranslate2 resolves some libraries lazily through the plain PATH search.
        os.environ["PATH"] = os.pathsep.join([*map(str, found), os.environ.get("PATH", "")])
    return found
