import threading
import io
import sys
from contextlib import redirect_stdout

from main import RuntimeDispatcher
import main as runtime_main


class BlockingProtocol:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.cancel_seen = threading.Event()

    def handle(self, message):
        if message["type"] == "synthesize":
            self.started.set()
            self.release.wait(1)
            yield {"type": "complete", "request_id": message["request_id"]}
        elif message["type"] == "cancel":
            self.cancel_seen.set()
            yield {"type": "cancelled", "request_id": message["request_id"]}


def test_dispatcher_accepts_cancel_while_synthesis_is_running():
    protocol = BlockingProtocol()
    output = []
    dispatcher = RuntimeDispatcher(protocol, output.append)
    dispatcher.submit({"type": "synthesize", "request_id": "r1"})
    assert protocol.started.wait(1)
    dispatcher.submit({"type": "cancel", "request_id": "r1"})
    assert protocol.cancel_seen.wait(1)
    protocol.release.set()
    dispatcher.join()
    assert output == [
        {"type": "cancelled", "request_id": "r1"},
        {"type": "complete", "request_id": "r1"},
    ]


def test_protocol_writer_survives_provider_stdout_redirection(monkeypatch):
    protocol_output = io.StringIO()
    diagnostics = io.StringIO()
    monkeypatch.setattr(sys, "stdout", protocol_output)
    with redirect_stdout(diagnostics):
        runtime_main.emit({"type": "cancelled", "request_id": "r1"}, output=protocol_output)
    assert '"cancelled"' in protocol_output.getvalue()
    assert diagnostics.getvalue() == ""


def test_dispatcher_limits_inference_per_model_but_keeps_control_responsive():
    protocol = BlockingProtocol()
    output = []
    dispatcher = RuntimeDispatcher(protocol, output.append)
    dispatcher.submit({"type": "synthesize", "request_id": "r1"})
    assert protocol.started.wait(1)
    try:
        dispatcher.submit({"type": "synthesize", "request_id": "r2"})
        assert {"type": "error", "request_id": "r2", "code": "models_busy", "message": "Speech model is busy"} in output
        dispatcher.submit({"type": "cancel", "request_id": "r1"})
        assert protocol.cancel_seen.is_set()
    finally:
        protocol.release.set()
        dispatcher.join()
