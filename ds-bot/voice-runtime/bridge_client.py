"""Authenticated, schema-checked client for the local DS Bot Voice Bridge.

Reconnection only queries previously sent inputs. It never resends a submit or
migrates audio from an expired binding.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from wake_mapping import WakeMapping

from jsonschema import Draft202012Validator, FormatChecker
import websockets


class BridgeProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class BridgeEvent:
    type: str
    binding: dict | None
    correlation: dict
    payload: dict
    raw: dict

    @classmethod
    def parse(cls, value):
        return cls(value['type'], value['binding'], value['correlation'], value['payload'], value)


class BridgeClient:
    def __init__(self, url, credential, *, channel, target_id, schema_path=None):
        self.url, self.credential = url, credential
        self.channel, self.target_id = channel, target_id
        self.target_type = 'desktop_native' if channel == 'text' else 'voice_device'
        schema_path = schema_path or Path(__file__).resolve().parent / 'agent-events-v1.dsbot.schema.json'
        checker = FormatChecker()
        # jsonschema's optional RFC3339 package is not guaranteed to be installed.
        @checker.checks('date-time', raises=(ValueError, TypeError))
        def check_datetime(value):
            if not isinstance(value, str):
                return True
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.tzinfo is not None
        self.validator = Draft202012Validator(json.loads(Path(schema_path).read_text(encoding='utf-8')), format_checker=checker)
        self.binding = None
        self.ready_event = None
        self._socket = None
        self._reader = None
        self._send_lock = asyncio.Lock()
        self._events = asyncio.Queue(maxsize=64)
        self._waiters = []
        self._next_in = self._next_out = 0
        self.sent_inputs = set()
        self.roles = None
        self.on_roles_changed = None
        self._active_wake = None
        self._invalidation_pending = False
        self._wake_attempt = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def validate(self, value):
        try:
            self.validator.validate(value)
        except Exception as error:
            raise BridgeProtocolError('invalid_envelope') from error
        if value['type'] == 'input.submit' and not value['payload']['text'].strip():
            raise BridgeProtocolError('invalid_envelope')

    def _incoming(self, value):
        self.validate(value)
        if value['type'] not in {'bridge.ready', 'bridge.error', 'input.accepted', 'input.rejected',
                                 'input.status.result', 'run.started', 'run.ended', 'output.started',
                                 'output.segment', 'output.ended', 'cancel.result',
                                 'context.snapshot.result', 'roles.snapshot.result', 'roles.changed',
                                 'device.wake.accepted'}:
            raise BridgeProtocolError('invalid_state: event direction')
        if value['sequence'] != self._next_in:
            raise BridgeProtocolError('invalid_state: sequence')
        if self.binding is None:
            if value['type'] != 'bridge.ready' or value['binding'] is None:
                raise BridgeProtocolError('invalid_state: ready required')
            self.binding = value['binding']
        elif value['binding'] != self.binding or value['type'] in ('bridge.ready', 'bridge.hello'):
            raise BridgeProtocolError('invalid_state: binding')
        self._next_in += 1
        return BridgeEvent.parse(value)

    async def connect(self):
        await self.close()
        self.binding = None
        self._next_in = self._next_out = 0
        self._events = asyncio.Queue(maxsize=64)
        self._socket = await websockets.connect(self.url, additional_headers={'Authorization': 'Bearer ' + self.credential},
                                                max_size=65536, open_timeout=10, close_timeout=2)
        try:
            await self.send('bridge.hello', {}, {'client_version': '0.1', 'channel': self.channel, 'target_id': self.target_id})
            ready = self._incoming(json.loads(await asyncio.wait_for(self._socket.recv(), 10)))
            self.ready_event = ready
            self._invalidation_pending = True
            self._reader = asyncio.create_task(self._read())
            return ready
        except BaseException:
            await self.close()
            raise

    async def reconnect(self):
        await self.connect()
        # These are queries, never resubmissions of a potentially executed input.
        return {key: await self.status(key) for key in sorted(self.sent_inputs)}

    async def send(self, event_type, correlation, payload, *, binding=None, event_id=None):
        if binding is not None and binding != self.binding:
            raise ValueError('binding is authoritative')
        async with self._send_lock:
            if self._socket is None or (self.binding is None and event_type != 'bridge.hello'):
                raise ConnectionError('Bridge is not ready')
            value = {'protocol': 'agent-events.v1', 'event_id': event_id or uuid4().hex, 'type': event_type,
                     'binding': self.binding, 'sequence': self._next_out, 'correlation': correlation,
                     'payload': payload, 'occurred_at': datetime.now(timezone.utc).isoformat()}
            self.validate(value)
            # Remember the attempt before network IO: uncertain sends cannot be retried.
            if event_type == 'input.submit':
                self.sent_inputs.add(correlation['input_id'])
            await self._socket.send(json.dumps(value, ensure_ascii=False, allow_nan=False))
            self._next_out += 1
            return value['event_id']

    async def _read(self):
        error = ConnectionError('Bridge disconnected')
        socket = self._socket
        try:
            async for raw in socket:
                event = self._incoming(json.loads(raw))
                roster_event = event.type in ('roles.snapshot.result', 'roles.changed')
                if roster_event:
                    self._apply_roles(event.payload)
                if event.type in ('run.ended', 'input.rejected') or (event.type == 'input.status.result' and event.payload.get('status') not in ('queued', 'running', 'unknown')):
                    self.sent_inputs.discard(event.correlation.get('input_id'))
                matched = False
                for predicate, future in list(self._waiters):
                    if not future.done() and predicate(event):
                        future.set_result(event)
                        matched = True
                        break
                if not matched and not roster_event:
                    try:
                        self._events.put_nowait(event)
                    except asyncio.QueueFull as cause:
                        raise BridgeProtocolError('output_backpressure') from cause
        except asyncio.CancelledError:
            raise
        except Exception as cause:
            error = BridgeProtocolError(str(cause)) if isinstance(cause, BridgeProtocolError) else ConnectionError('Bridge disconnected')
        finally:
            self.binding = None
            self.ready_event = None
            self._clear_roles()
            for _, future in self._waiters:
                if not future.done():
                    future.set_exception(error)
            # Fail closed even when the consumer is slower than the transport.
            while not self._events.empty():
                self._events.get_nowait()
            self._events.put_nowait(error)
            await socket.close()

    async def next_event(self, timeout=130):
        value = await asyncio.wait_for(self._events.get(), timeout)
        if isinstance(value, Exception):
            raise value
        return value

    async def _request(self, event_type, correlation, payload, predicate):
        if len(self._waiters) >= 64:
            raise BridgeProtocolError('request_backpressure')
        future = asyncio.get_running_loop().create_future()
        waiter = (lambda event: predicate(event) or (event.type == 'bridge.error'
            and all(event.correlation.get(key) == value for key, value in correlation.items())), future)
        self._waiters.append(waiter)
        try:
            await self.send(event_type, correlation, payload)
            event = await asyncio.wait_for(future, 10)
            if event.type == 'bridge.error':
                raise BridgeProtocolError(event.payload.get('error_code', 'bridge_error'))
            return event
        finally:
            self._waiters.remove(waiter)

    async def submit(self, text, *, speaker=None, input_id=None, bot_id=None,
                     wake_session_id=None, session_id=None, generation=None, segment_id=None):
        if not isinstance(text, str) or not text.strip():
            raise ValueError('final transcript must contain text')
        if self.channel == 'voice' and (not speaker or speaker.get('status') != 'owner_verified'):
            raise ValueError('current segment requires owner verification')
        if self.channel == 'text' and speaker is not None:
            raise ValueError('text inputs cannot claim speaker identity')
        input_id = input_id or uuid4().hex
        payload = {'text': text, 'channel': self.channel}
        if bot_id is not None:
            if not isinstance(bot_id, str) or not bot_id.strip():
                raise ValueError('bot_id must be a nonblank string')
            payload['bot_id'] = bot_id
        if speaker is not None:
            payload['speaker'] = dict(speaker)
        ownership = {'wake_session_id': wake_session_id, 'session_id': session_id,
                     'generation': generation, 'segment_id': segment_id}
        if any(value is not None for value in ownership.values()):
            wake = self._active_wake
            valid_segment = ((type(segment_id) is int and segment_id > 0)
                             or (isinstance(segment_id, str) and bool(segment_id.strip())))
            if (not wake or self.binding is None or wake_session_id != wake['wake_session_id']
                    or bot_id != wake['bot_id'] or session_id != wake.get('session_id')
                    or type(generation) is not int or generation < 0 or generation != wake.get('generation')
                    or not valid_segment):
                raise ValueError('input requires the current accepted wake/session/generation')
            payload.update(ownership)
        return await self._request('input.submit', {'input_id': input_id}, payload,
                                   lambda e: e.type in ('input.accepted', 'input.rejected', 'input.status.result')
                                   and e.correlation.get('input_id') == input_id)

    async def publish_wake(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('wake payload must be an object')
        wake_session_id = payload.get('wake_session_id')
        bot_id = payload.get('bot_id')
        mapping_version = payload.get('wake_mapping_version')
        if not all(isinstance(value, str) and value.strip() for value in (wake_session_id, bot_id, mapping_version)):
            raise ValueError('invalid wake payload')
        generation = payload.get('generation')
        if generation is not None and (type(generation) is not int or generation < 0):
            raise ValueError('invalid wake generation')
        value = {
            'wake_session_id': wake_session_id, 'bot_id': bot_id,
            'wake_mapping_version': mapping_version,
            **({'generation': generation} if generation is not None else {}),
        }
        self._active_wake = None
        self._wake_attempt += 1
        attempt = self._wake_attempt
        binding, roles = self.binding, self.roles
        accepted = await self._request('device.wake', {'wake_session_id': wake_session_id}, value,
            lambda event: event.type == 'device.wake.accepted'
            and event.correlation.get('wake_session_id') == wake_session_id)
        if (attempt != self._wake_attempt or self.binding != binding or self.roles is not roles
                or any(accepted.payload.get(key) != item for key, item in value.items())):
            raise BridgeProtocolError('invalid_wake_acceptance')
        self._active_wake = dict(accepted.payload)
        return accepted

    async def context_snapshot(self, bot_id, user_id='owner', *, dialogue_active=False,
                               recent_reply=None):
        """Read a bounded role snapshot through the Bridge/Core boundary."""
        request_id = uuid4().hex
        payload = {'bot_id': bot_id, 'user_id': user_id,
                   'dialogue_active': bool(dialogue_active)}
        if recent_reply:
            payload['recent_reply'] = recent_reply
        return await self._request('context.snapshot.get', {'request_id': request_id}, payload,
                                   lambda e: e.type == 'context.snapshot.result'
                                   and e.correlation.get('request_id') == request_id)

    async def status(self, input_id):
        return await self._request('input.status', {'input_id': input_id}, {},
                                   lambda e: e.type == 'input.status.result' and e.correlation.get('input_id') == input_id)

    def _clear_roles(self):
        notify = self.roles is not None or self._invalidation_pending
        self.roles = None
        self._active_wake = None
        self._invalidation_pending = False
        if notify and self.on_roles_changed:
            self.on_roles_changed(None)

    def _apply_roles(self, value):
        WakeMapping.from_roster(value)
        if not self.binding or value['activity_epoch'] != self.binding['activity_epoch']:
            raise BridgeProtocolError('role_epoch_mismatch')
        if self.roles is not None and value['revision'] <= self.roles['revision']:
            if value['revision'] == self.roles['revision'] and value != self.roles:
                raise BridgeProtocolError('role_revision_reused')
            return
        self.roles = value
        self._active_wake = None
        if self.on_roles_changed:
            self.on_roles_changed(value)

    async def subscribe_roles(self):
        request_id = uuid4().hex
        return await self._request('roles.snapshot.get', {'request_id': request_id}, {},
            lambda e: e.type == 'roles.snapshot.result' and e.correlation.get('request_id') == request_id)

    async def cancel(self, scope, identifier):
        if scope not in ('input', 'run', 'output'):
            raise ValueError('invalid cancellation scope')
        correlation = {scope + '_id': identifier}
        if scope == 'output':
            correlation = {'response_id': identifier, 'target_id': self.target_id}
        future = asyncio.get_running_loop().create_future()
        # Allocate the request ID before sending so a fast response cannot race it.
        request_id = uuid4().hex
        waiter = (lambda e: e.type == 'cancel.result' and e.payload['request_event_id'] == request_id, future)
        self._waiters.append(waiter)
        try:
            await self.send(scope + '.cancel', correlation, {}, event_id=request_id)
            return await asyncio.wait_for(future, 10)
        finally:
            self._waiters.remove(waiter)

    async def progress(self, event, *, terminal=None, last_completed=None):
        index = event.payload.get('segment_index', -1) if last_completed is None else last_completed
        payload = {'last_completed_segment_index': index}
        if terminal:
            payload['status'] = terminal
        return await self.send('delivery.ended' if terminal else 'delivery.progress',
                               {'response_id': event.correlation['response_id'], 'target_id': self.target_id}, payload)

    async def close(self):
        if self._reader:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader
            self._reader = None
        if self._socket:
            await self._socket.close()
            self._socket = None
        self.binding = None
        self.ready_event = None
        self._clear_roles()


