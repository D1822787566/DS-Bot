"""Download the pinned Local Voice model assets during setup, never serving."""

from __future__ import annotations

import argparse
from pathlib import Path


PARAFORMER_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
MELO_REPO = "myshell-ai/MeloTTS-Chinese"


def download(root: Path) -> None:
    root = root.resolve()
    asr = root / "paraformer-zh"
    tts = root / "melotts-zh"
    asr.mkdir(parents=True, exist_ok=True)
    tts.mkdir(parents=True, exist_ok=True)
    from modelscope.hub.snapshot_download import snapshot_download
    from huggingface_hub import hf_hub_download

    snapshot_download(PARAFORMER_ID, local_dir=str(asr), revision="v2.0.4")
    for filename in ("config.json", "checkpoint.pth"):
        hf_hub_download(MELO_REPO, filename=filename, local_dir=str(tts))
    print(f"models_ready: {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    download(Path(parser.parse_args().root))
