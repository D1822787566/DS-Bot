import asyncio
import json
import unittest
from datetime import datetime, timezone

import websockets

from bridge_client import BridgeClient, BridgeEvent, BridgeProtocolError


def envelope(event_type, binding, sequence, correlation, payload):
    return {
        "protocol": "agent-events.v1",
        "event_id": f"event-{sequence}-{event_type}",
        "type": event_type,
        "binding": binding,
        "sequence": sequence,
        "correlation": correlation,
        "payload": payload,
        "occurred_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


class BridgeClientTests(unittest.IsolatedAsyncioTestCase):
    def test_default_target_type_keeps_native_and_runtime_boundaries(self):
        self.assertEqual(BridgeClient('ws://127.0.0.1', 'token', channel='text', target_id='desktop').target_type,
                         'desktop_native')
        self.assertEqual(BridgeClient('ws://127.0.0.1', 'token', channel='voice', target_id='phone').target_type,
                         'voice_device')

    def test_normative_fixtures_and_real_calendar_date(self):
        from pathlib import Path
        client = BridgeClient('ws://127.0.0.1', 'token', channel='text', target_id='phone')
        examples = json.loads((Path(__file__).resolve().parent / 'agent-events-v1.dsbot.examples.json').read_text(encoding='utf-8'))
        for example in examples['valid']:
            client.validate(example['event'])
        for example in examples['invalid']:
            with self.assertRaises(BridgeProtocolError, msg=example['name']):
                client.validate(example['event'])
        value = dict(examples['valid'][0]['event'], occurred_at='2026-02-30T00:00:00Z')
        with self.assertRaises(BridgeProtocolError):
            client.validate(value)

    async def asyncSetUp(self):
        self.binding = {
            "device_id": "windows-1",
            "activity_epoch": "epoch",
            "channel_session_id": "session",
        }
        self.received = []

        async def handler(ws):
            hello = json.loads(await ws.recv())
            self.received.append(hello)
            await ws.send(json.dumps(envelope("bridge.ready", self.binding, 0, {}, {
                "runtime": "ds-bot-voice-runtime",
                "idempotency_retention_seconds": 86400,
            })))
            try:
                submit = json.loads(await ws.recv())
            except websockets.ConnectionClosed:
                return
            self.received.append(submit)
            if submit["type"] == "device.wake":
                await ws.wait_closed()
                return
            await ws.send(json.dumps(envelope("input.accepted", self.binding, 1,
                                               {"input_id": submit["correlation"]["input_id"]},
                                               {"status": "queued"})))
            await ws.send(json.dumps(envelope("output.segment", self.binding, 2,
                                               {"run_id": "run", "input_id": submit["correlation"]["input_id"],
                                                "response_id": "response", "target_id": "phone"},
                                               {"segment_index": 0, "display_text": "你好", "speak_text": "你好"})))
            try:
                self.received.append(json.loads(await ws.recv()))
            except websockets.ConnectionClosed:
                pass
            await ws.wait_closed()

        self.server = await websockets.serve(handler, "127.0.0.1", 0)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def test_handshake_submit_and_sequence_are_contract_checked(self):
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            ready = await client.connect()
            self.assertEqual(ready.binding, self.binding)
            accepted = await client.submit("你好", speaker={
                "status": "owner_verified", "score": .9, "model_id": "cam++", "profile_version": "v1"
            }, input_id="input-1")
            self.assertEqual(accepted.type, "input.accepted")
            self.assertEqual(self.received[0]["sequence"], 0)
            self.assertEqual(self.received[1]["sequence"], 1)
            segment = await client.next_event()
            self.assertEqual(segment.payload["speak_text"], "你好")
            await client.progress(segment, terminal="delivered")
            for _ in range(20):
                if len(self.received) == 3:
                    break
                await asyncio.sleep(.01)
            self.assertEqual(self.received[-1]['type'], 'delivery.ended')

    async def test_wake_candidate_uses_the_authenticated_bridge_binding(self):
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            await client.publish_wake({
                "wake_session_id": "wake-1", "bot_id": "bot-1",
                "wake_mapping_version": "epoch:1",
            })
            for _ in range(20):
                if len(self.received) == 2:
                    break
                await asyncio.sleep(.01)
            self.assertEqual(self.received[-1]["type"], "device.wake")
            self.assertEqual(self.received[-1]["binding"], self.binding)

    async def test_wrong_binding_and_unknown_identity_are_rejected_before_send(self):
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            with self.assertRaises(ValueError):
                await client.submit("x", speaker={"status": "unknown"})
            with self.assertRaises(ValueError):
                await client.send("input.status", {"input_id": "x"}, {}, binding={"bad": True})

    async def test_incoming_sequence_gap_is_protocol_error(self):
        async def bad_handler(ws):
            await ws.recv()
            await ws.send(json.dumps(envelope("bridge.ready", self.binding, 0, {}, {
            "runtime": "ds-bot-voice-runtime",
                "idempotency_retention_seconds": 86400,
            })))
            await ws.send(json.dumps(envelope("output.segment", self.binding, 2,
                                              {'run_id': 'r', 'response_id': 's', 'target_id': 'phone'}, {
                "segment_index": 0, "display_text": "x", "speak_text": "x"
            })))

        self.server.close()
        await self.server.wait_closed()
        self.server = await websockets.serve(bad_handler, "127.0.0.1", 0)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"
        async with BridgeClient(self.url, "token", channel="text", target_id="phone") as client:
            await client.connect()
            with self.assertRaises(BridgeProtocolError):
                await client.next_event()


if __name__ == "__main__":
    unittest.main()


