"""JSON-lines entrypoint for the isolated Local Voice speech process."""

from __future__ import annotations

import json
import sys
import threading

from protocol import RuntimeProtocol, parse_line
from service import load_from_environment


def emit(message, *, output=None):
    target = output if output is not None else sys.stdout
    target.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    target.flush()


class RuntimeDispatcher:
    """Keep stdin responsive so a cancel command can reach a running TTS job."""

    def __init__(self, protocol, output):
        self.protocol = protocol
        self.output = output
        self._threads = set()
        self._busy = set()
        self._lock = threading.Lock()

    def _run(self, message):
        try:
            for response in self.protocol.handle(message):
                self.output(response)
        finally:
            with self._lock:
                self._threads.discard(threading.current_thread())
                if isinstance(message, dict) and message.get("type") in {"transcribe", "synthesize"}:
                    self._busy.discard(message["type"])

    def submit(self, message):
        if isinstance(message, dict) and message.get("type") in {"transcribe", "synthesize"}:
            thread = threading.Thread(target=self._run, args=(message,), daemon=True)
            with self._lock:
                if message["type"] in self._busy:
                    self.output({"type": "error", "request_id": message.get("request_id"),
                                 "code": "models_busy", "message": "Speech model is busy"})
                    return
                self._busy.add(message["type"])
                self._threads.add(thread)
            thread.start()
            return
        self._run(message)

    def join(self):
        while True:
            with self._lock:
                threads = list(self._threads)
            if not threads:
                return
            for thread in threads:
                thread.join()


def main() -> int:
    # stdout belongs exclusively to the protocol. Keep an explicit handle;
    # third-party print/redirect_stdout calls must never redirect replies.
    protocol_output = sys.stdout
    sys.stdout = sys.stderr
    try:
        return serve(protocol_output)
    finally:
        sys.stdout = protocol_output


def serve(protocol_output) -> int:
    try:
        service = load_from_environment()
    except Exception as error:
        emit({"type": "error", "code": "runtime_not_ready", "message": str(error)[:240]}, output=protocol_output)
        return 2
    protocol = RuntimeProtocol(service)
    output_lock = threading.Lock()

    def safe_emit(message):
        with output_lock:
            emit(message, output=protocol_output)

    dispatcher = RuntimeDispatcher(protocol, safe_emit)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = parse_line(line)
        except Exception:
            safe_emit({"type": "error", "code": "invalid_json", "message": "invalid JSON"})
            continue
        dispatcher.submit(message)
    dispatcher.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
