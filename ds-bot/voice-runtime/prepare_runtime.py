"""Create and validate DS Bot's private Python 3.12 speech environment.

Only structured, non-sensitive progress is written to stdout. Provider/pip
output stays inside this process so credentials in URLs cannot reach the UI.
An interrupted installation never creates a ready manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

MANIFEST = "ds-bot-environment.json"
SMOKE_IMPORTS = """
import jsonschema, websockets, numpy, pypinyin, aiohttp
import torch, torchaudio, sherpa_onnx, sounddevice
from funasr import AutoModel
from livekit import rtc
from livekit.plugins.silero.onnx_model import OnnxModel
assert torch.__version__.split('+')[0] == '2.11.0'
assert torchaudio.__version__.split('+')[0] == '2.11.0'
"""


def progress(stage):
    print(json.dumps({"type": "runtime.progress", "stage": stage}), flush=True)


def require_python(version=None):
    if tuple((sys.version_info if version is None else version)[:2]) != (3, 12):
        raise RuntimeError("python_312_required")


def environment_python(directory):
    return directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def prepare_environment(directory, requirements, *, runner=subprocess.run, creator=None):
    directory, requirements = Path(directory).resolve(), Path(requirements).resolve()
    fingerprint = hashlib.sha256(requirements.read_bytes() + SMOKE_IMPORTS.encode()).hexdigest()
    manifest = directory / MANIFEST
    expected = {"version": 1, "python": "3.12", "requirements_sha256": fingerprint}
    python = environment_python(directory)
    options = {"capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace"}
    progress("environment_checking")
    try:
        cached = json.loads(manifest.read_text(encoding="utf-8")) == expected
    except (OSError, ValueError):
        cached = False
    if cached and python.is_file():
        if runner([str(python), "-c", SMOKE_IMPORTS], **options).returncode == 0:
            progress("environment_ready")
            return python
    # A previous successful setup can lose only its manifest during an app
    # upgrade or interrupted cleanup. Validate the existing interpreter before
    # attempting a destructive reinstall, then restore the manifest atomically.
    if python.is_file() and not manifest.exists():
        if (runner([str(python), "-m", "pip", "check"], **options).returncode == 0
                and runner([str(python), "-c", SMOKE_IMPORTS], **options).returncode == 0):
            directory.mkdir(parents=True, exist_ok=True)
            temporary = manifest.with_suffix(".tmp")
            temporary.write_text(json.dumps(expected), encoding="utf-8")
            temporary.replace(manifest)
            progress("environment_ready")
            return python
    manifest.unlink(missing_ok=True)
    progress("environment_creating")
    if creator is None:
        venv.EnvBuilder(with_pip=True).create(directory)
    else:
        creator(directory)
    progress("environment_installing")
    result = runner([str(python), "-m", "pip", "install", "--force-reinstall", "--disable-pip-version-check", "--no-input", "-r", str(requirements)], **options)
    if result.returncode:
        raise RuntimeError("dependency_install_failed")
    progress("environment_verifying")
    if runner([str(python), "-m", "pip", "check"], **options).returncode:
        raise RuntimeError("dependency_conflict")
    if runner([str(python), "-c", SMOKE_IMPORTS], **options).returncode:
        raise RuntimeError("dependency_import_failed")
    directory.mkdir(parents=True, exist_ok=True)
    temporary = manifest.with_suffix(".tmp")
    temporary.write_text(json.dumps(expected), encoding="utf-8")
    temporary.replace(manifest)
    progress("environment_ready")
    return python


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    args = parser.parse_args()
    try:
        require_python()
        prepare_environment(args.environment, Path(__file__).with_name("requirements.txt"))
    except Exception as error:
        allowed = {"python_312_required", "dependency_install_failed", "dependency_conflict", "dependency_import_failed"}
        code = str(error) if str(error) in allowed else "environment_setup_failed"
        stage = {"dependency_install_failed": "environment_installing", "dependency_conflict": "environment_verifying", "dependency_import_failed": "environment_verifying"}.get(code, "environment_setup")
        print(json.dumps({"type": "runtime.state", "state": "error", "stage": stage, "error_code": code}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
