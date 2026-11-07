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
                await ws.send(json.dumps(envelope("device.wake.accepted", self.binding, 1,
                    submit["correlation"], dict(submit["payload"], session_id="session-b"))))
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
            accepted = await client.publish_wake({
                "wake_session_id": "wake-1", "bot_id": "bot-1",
                "wake_mapping_version": "epoch:1", "generation": 4,
            })
            self.assertEqual(accepted.type, "device.wake.accepted")
            self.assertEqual(accepted.payload["generation"], 4)
            for _ in range(20):
                if len(self.received) == 2:
                    break
                await asyncio.sleep(.01)
            self.assertEqual(self.received[-1]["type"], "device.wake")
            self.assertEqual(self.received[-1]["binding"], self.binding)

    async def replace_handler(self, handler):
        self.server.close()
        await self.server.wait_closed()
        self.server = await websockets.serve(handler, "127.0.0.1", 0)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def ready(self, ws):
        await ws.recv()
        await ws.send(json.dumps(envelope("bridge.ready", self.binding, 0, {}, {
            "runtime": "ds-bot-voice-runtime", "idempotency_retention_seconds": 86400,
        })))

    async def test_wake_rejection_resolves_the_request_with_a_meaningful_error(self):
        async def handler(ws):
            await self.ready(ws)
            wake = json.loads(await ws.recv())
            await ws.send(json.dumps(envelope("bridge.error", self.binding, 1,
                wake["correlation"], {"error_code": "invalid_wake"})))
            await ws.wait_closed()
        await self.replace_handler(handler)
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            with self.assertRaisesRegex(BridgeProtocolError, "invalid_wake"):
                await asyncio.wait_for(client.publish_wake({
                    "wake_session_id": "wake", "bot_id": "b", "wake_mapping_version": "epoch:1",
                    "generation": 1,
                }), 1)

    async def test_submit_carries_the_exact_wake_session_generation_and_segment_evidence(self):
        received = []
        async def handler(ws):
            await self.ready(ws)
            wake = json.loads(await ws.recv())
            await ws.send(json.dumps(envelope("device.wake.accepted", self.binding, 1,
                wake["correlation"], dict(wake["payload"], session_id="session-b"))))
            received.append(json.loads(await ws.recv()))
            await ws.send(json.dumps(envelope("input.accepted", self.binding, 2,
                received[-1]["correlation"], {"status": "queued"})))
            await ws.wait_closed()
        await self.replace_handler(handler)
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            await client.publish_wake({"wake_session_id": "wake", "bot_id": "b",
                "wake_mapping_version": "epoch:1", "generation": 3})
            await client.submit("hello", input_id="input", bot_id="b", session_id="session-b",
                wake_session_id="wake", generation=3, segment_id=1,
                speaker={"status": "owner_verified", "segment_id": 1})
            self.assertEqual(received[0]["payload"], {
                "text": "hello", "channel": "voice", "bot_id": "b", "session_id": "session-b",
                "wake_session_id": "wake", "generation": 3, "segment_id": 1,
                "speaker": {"status": "owner_verified", "segment_id": 1},
            })
            with self.assertRaisesRegex(ValueError, "wake"):
                await client.submit("late", bot_id="b", session_id="session-b", wake_session_id="wake",
                    generation=2, segment_id="segment", speaker={"status": "owner_verified"})

    async def test_role_changes_and_disconnect_invalidate_once_each(self):
        roster = {"activity_epoch": "epoch", "revision": 1, "roles": [{
            "bot_id": "b", "session_id": "session-b", "wake_names": ["小贝"], "profile_version": 1,
        }]}
        async def handler(ws):
            await self.ready(ws)
            request = json.loads(await ws.recv())
            await ws.send(json.dumps(envelope("roles.snapshot.result", self.binding, 1,
                request["correlation"], roster)))
            await ws.send(json.dumps(envelope("roles.changed", self.binding, 2, {}, roster)))
            await ws.close()
        await self.replace_handler(handler)
        changes = []
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            client.on_roles_changed = changes.append
            await client.connect()
            await client.subscribe_roles()
            with self.assertRaises(ConnectionError):
                await client.next_event()
        self.assertEqual(changes, [roster, None])

    async def test_wake_acceptance_must_echo_the_requested_bot_and_generation(self):
        async def handler(ws):
            await self.ready(ws)
            wake = json.loads(await ws.recv())
            await ws.send(json.dumps(envelope("device.wake.accepted", self.binding, 1,
                wake["correlation"], dict(wake["payload"], bot_id="another", session_id="session-b"))))
            await ws.wait_closed()
        await self.replace_handler(handler)
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            with self.assertRaisesRegex(BridgeProtocolError, "invalid_wake_acceptance"):
                await client.publish_wake({"wake_session_id": "wake", "bot_id": "b",
                    "wake_mapping_version": "epoch:1", "generation": 1})

    async def test_late_wake_acknowledgement_cannot_replace_a_newer_accepted_wake(self):
        async def handler(ws):
            await self.ready(ws)
            first = json.loads(await ws.recv())
            second = json.loads(await ws.recv())
            for sequence, wake in enumerate((second, first), 1):
                await ws.send(json.dumps(envelope("device.wake.accepted", self.binding, sequence,
                    wake["correlation"], dict(wake["payload"], session_id="session-b"))))
            await ws.wait_closed()
        await self.replace_handler(handler)
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            first = asyncio.create_task(client.publish_wake({"wake_session_id": "first", "bot_id": "b",
                "wake_mapping_version": "epoch:1", "generation": 1}))
            await asyncio.sleep(0)
            second = await client.publish_wake({"wake_session_id": "second", "bot_id": "b",
                "wake_mapping_version": "epoch:1", "generation": 2})
            self.assertEqual(second.payload["wake_session_id"], "second")
            with self.assertRaisesRegex(BridgeProtocolError, "invalid_wake_acceptance"):
                await first

    async def test_role_update_invalidates_pending_wake_acceptance(self):
        roster = {"activity_epoch": "epoch", "revision": 2, "roles": [{
            "bot_id": "b", "session_id": "session-b", "wake_names": ["new"], "profile_version": 2,
        }]}
        async def handler(ws):
            await self.ready(ws)
            wake = json.loads(await ws.recv())
            await ws.send(json.dumps(envelope("roles.changed", self.binding, 1, {}, roster)))
            await ws.send(json.dumps(envelope("device.wake.accepted", self.binding, 2,
                wake["correlation"], dict(wake["payload"], session_id="session-b"))))
            await ws.wait_closed()
        await self.replace_handler(handler)
        async with BridgeClient(self.url, "token", channel="voice", target_id="phone") as client:
            await client.connect()
            with self.assertRaisesRegex(BridgeProtocolError, "invalid_wake_acceptance"):
                await client.publish_wake({"wake_session_id": "wake", "bot_id": "b",
                    "wake_mapping_version": "epoch:1", "generation": 1})

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


