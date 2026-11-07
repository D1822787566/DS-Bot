"""Observe the existing speaker/AEC render callback; no second audio stream.

The pinned RTC OutputPlayer has no render observer. The small _apm forwarding
hook below keeps its AEC path intact. Cancellation closes that output player
and its mixer, then opens the same configured output; microphone/APM ownership
stays with MediaDevices. Playback activity is not a delivered acknowledgment.
"""
from __future__ import annotations

import asyncio
import time
import numpy as np


class _RenderTap:
    def __init__(self, owner, delegate, generation):
        self.owner, self.delegate, self.generation = owner, delegate, generation

    def process_reverse_stream(self, frame):
        owner = self.owner
        if owner.closed or self.generation != owner._generation:
            return
        if self.delegate is not None:
            self.delegate.process_reverse_stream(frame)
        # PortAudio thread: keep only a timestamp, never PCM or async work.
        if np.any(np.frombuffer(frame.data, dtype=np.int16)):
            owner._last_sound = owner.clock()


class WindowsPlayback:
    def __init__(self, factory, publish, device_id, session_id, *, target_id=None, clock=time.monotonic):
        self.factory, self.publish, self.clock = factory, publish, clock
        self.device_id, self.session_id = device_id, session_id
        self.target_id = target_id or device_id
        self.player = None
        self.binding = None
        self.response_id = None
        self.closed = False
        self._tracks = {}
        self._retired_bindings = set()
        self._generation = 0
        self._last_sound = float('-inf')
        self._playing = False
        self._paused = True  # A new device never resumes an unidentified old reply.
        self._event_sequence = -1
        self._playback_sequence = 0
        self._lock = asyncio.Lock()

    async def _open(self):
        self._generation += 1
        self._last_sound = float('-inf')
        self.player = self.factory()
        if not hasattr(self.player, '_apm'):
            await self.player.aclose()
            raise RuntimeError('unsupported_windows_playback_sdk')
        self.player._apm = _RenderTap(self, self.player._apm, self._generation)
        await self.player.start()

    async def start(self):
        async with self._lock:
            await self._open()

    async def add_track(self, track):
        async with self._lock:
            if self.closed or track.sid in self._tracks:
                return
            self._tracks[track.sid] = track
            if not self._paused:
                await self.player.add_track(track)

    async def remove_track(self, track):
        async with self._lock:
            if self._tracks.pop(track.sid, None) is not None and not self.closed:
                await self.player.remove_track(track)

    async def _report(self, playing):
        if playing == self._playing:
            return
        self._playing = playing
        if self.binding is not None and self.response_id:
            self._playback_sequence += 1
            await self.publish({
                'type': 'device.playback.started' if playing else 'device.playback.stopped',
                'device_id': self.device_id, 'session_id': self.session_id,
                'binding': dict(self.binding), 'response_id': self.response_id,
                'playback_sequence': self._playback_sequence})

    async def _stop(self):
        if self._paused:
            return
        self._paused = True
        self._generation += 1  # Ignore a retired output callback before closing it.
        await self.player.aclose()  # Discards old AudioStream/mixer/output buffer.
        await self._report(False)
        await self._open()

    async def suspend(self):
        async with self._lock:
            if self.closed:
                return
            await self._stop()
            if self.binding:
                self._retired_bindings.add(self.binding['channel_session_id'])
            self.binding = self.response_id = None

    async def receive(self, value):
        async with self._lock:
            if self.closed or not isinstance(value, dict):
                return
            if value.get('type') == 'device.playback.stop':
                if value.get('binding') == self.binding and value.get('response_id') == self.response_id:
                    await self._stop()
                return
            if value.get('type') != 'bridge.event' or not isinstance(value.get('event'), dict):
                return
            event = value['event']
            binding, sequence = event.get('binding'), event.get('sequence')
            if (event.get('protocol') != 'agent-events.v1' or not isinstance(binding, dict)
                    or set(binding) != {'device_id', 'activity_epoch', 'channel_session_id'}
                    or any(not isinstance(v, str) or not v or len(v) > 128 for v in binding.values())
                    or type(sequence) is not int or sequence < 0):
                return
            if event.get('type') == 'bridge.ready':
                if binding == self.binding or binding['channel_session_id'] in self._retired_bindings:
                    return
                if self.binding:
                    await self._stop()
                    self._retired_bindings.add(self.binding['channel_session_id'])
                self.binding, self.response_id = dict(binding), None
                self._event_sequence = sequence
                return
            if binding != self.binding or sequence <= self._event_sequence:
                return
            self._event_sequence = sequence
            correlation = event.get('correlation') or {}
            if correlation.get('target_id') != self.target_id:
                return
            if event.get('type') == 'output.started':
                identifier = correlation.get('response_id')
                if not isinstance(identifier, str) or not identifier or len(identifier) > 128:
                    return
                await self._report(False)
                self.response_id = identifier
                self._last_sound = float('-inf')
                if self._paused:
                    self._paused = False
                    for track in self._tracks.values():
                        await self.player.add_track(track)
            elif (event.get('type') == 'output.ended' and correlation.get('response_id') == self.response_id
                    and event.get('payload', {}).get('status') in ('cancelled', 'failed')):
                await self._stop()

    async def poll_once(self):
        async with self._lock:
            if not self.closed:
                await self._report(bool(self.response_id and not self._paused
                                        and self.clock() - self._last_sound < .25))

    async def monitor(self):
        while not self.closed:
            await asyncio.sleep(.05)
            await self.poll_once()

    async def aclose(self):
        async with self._lock:
            if self.closed:
                return
            self.closed = True
            self._generation += 1
            if self.player is not None:
                await self.player.aclose()
            self._tracks.clear()


