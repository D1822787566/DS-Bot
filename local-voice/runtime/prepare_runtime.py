"""Prepare the isolated Local Voice Python environment.

The runtime never installs packages or downloads models. This script is the
explicit setup step used by the host or a developer before starting it.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import venv


ROOT = Path(__file__).resolve().parent
MANIFEST = "local-voice-environment.json"


def environment_python(directory: Path) -> Path:
    return directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(command, *, cwd=None):
    return subprocess.run(command, cwd=cwd, check=True)


def prepare_environment(directory: Path) -> Path:
    directory = directory.resolve()
    python = environment_python(directory)
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(directory)
    run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", str(ROOT / "requirements.txt")])
    # MeloTTS declares optional English/WebUI dependencies and pins an older
    # transformers/fugashi pair. The Chinese runtime uses its local shims and
    # the explicit baseline above, so install the package code without letting
    # its legacy metadata replace the runtime versions.
    run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-deps", "melotts==0.1.2"])
    smoke = (
        "import funasr, melo, numpy, torch; "
        "assert torch.__version__.split('+')[0] == '2.11.0'"
    )
    run([str(python), "-c", smoke])
    (directory / MANIFEST).write_text(json.dumps({"python": "3.12", "runtime": 1}), encoding="utf-8")
    return python


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        print(json.dumps({"type": "error", "code": "python_312_required"}), flush=True)
        return 1
    prepare_environment(Path(args.environment))
    print(json.dumps({"type": "ready", "environment": str(Path(args.environment).resolve())}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
