"""Resolve bundled or explicitly configured local runtime binaries."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping


def resolve_livekit_server(env: Mapping[str, str] | None = None, *, runtime_root: str | Path | None = None) -> str:
    values = os.environ if env is None else env
    explicit = values.get("LIVEKIT_SERVER")
    if explicit:
        return explicit
    root = Path(runtime_root or values.get("DS_BOT_LIVEKIT_RUNTIME_ROOT", ""))
    candidate = root / "rebuild" / "toolchain" / "livekit-1.13.10" / "livekit-server.exe"
    if candidate.is_file():
        return str(candidate)
    return "livekit-server"


def resolve_dotnet(env: Mapping[str, str] | None = None, *, root: str | Path | None = None) -> str:
    values = os.environ if env is None else env
    explicit = values.get("DS_BOT_DOTNET")
    if explicit:
        return explicit
    repository = Path(root) if root is not None else Path(__file__).resolve().parents[2]
    candidate = repository / ".tools" / "dotnet10" / "dotnet.exe"
    if candidate.is_file():
        return str(candidate)
    return "dotnet"


