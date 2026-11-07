"""Serial, interruptible TTS playback outside the Bridge event receiver."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import threading
from uuid import uuid4

from bridge_client import BridgeEvent


@dataclass
class _Response:
    correlation: dict
    voice: str | None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))
    cancelled: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None
    text: str = ''
    next_index: int = 0
    last_played: int = -1
    system: bool = False


class VoiceOutput:
    def __init__(self, bridge, tts, playback, *, owns=None, generated=None, finished=None, notify=None):
        self.bridge, self.tts, self.playback = bridge, tts, playback
        self.owns = owns or (lambda _correlation: True)
        self.generated = generated or (lambda *_args: None)
        self.finished = finished or (lambda *_args: None)
        self.notify = notify or (lambda *_args, **_fields: None)
        self.aborted = None
        self.active = None

    async def handle(self, event):
        value = event.raw if isinstance(event, BridgeEvent) else event
        kind, correlation, payload = value.get('type'), value.get('correlation', {}), value.get('payload', {})
        if not self.owns(correlation):
            return
        identifier = correlation.get('response_id')
        if not identifier:
            return
        if kind == 'output.started':
            if self.active:
                await self.interrupt()
            self.active = _Response(dict(correlation), payload.get('tts_voice'))
            self.active.task = asyncio.create_task(self._play(self.active))
            return
        response = self.active
        if response is None or response.correlation['response_id'] != identifier:
            return
        if kind == 'output.segment':
            text = payload.get('speak_text')
            if not isinstance(text, str) or not text.strip():
                return
            index = payload.get('segment_index', response.next_index)
            if index != response.next_index:
                await self.interrupt()
                self._error('output_sequence_mismatch')
                return
            response.next_index += 1
            response.text = (response.text + text)[-2000:]
            await self._enqueue(response, (event, text, payload.get('tts_voice') or response.voice))
        elif kind == 'output.ended':
            if payload.get('status', 'completed') != 'completed':
                if response.text:
                    self.generated(response.correlation, response.text)
                await self.interrupt()
                return
            await self._enqueue(response, (event, None, None))

    async def _enqueue(self, response, item):
        try:
            response.queue.put_nowait(item)
        except asyncio.QueueFull:
            await self.interrupt()
            self._error('output_backpressure')

    async def _play(self, response):
        try:
            while not response.cancelled.is_set():
                event, text, voice = await response.queue.get()
                try:
                    if text is None:
                        drainer = getattr(self.playback, 'drain', None)
                        if callable(drainer):
                            await drainer()
                        if not response.system:
                            await self._progress(event, terminal='delivered', last_completed=response.last_played)
                            self.generated(response.correlation, response.text)
                            self.finished(response.correlation, response.text)
                        return
                    starter = getattr(self.playback, 'start', None)
                    if callable(starter):
                        await starter()
                    self.notify('runtime.state', state='speaking', stage='synthesizing', result='processing', error_code='')
                    async for chunk in self.tts.synthesize_stream(text, response.cancelled, voice=voice):
                        if response.cancelled.is_set() or (not response.system and not self.owns(response.correlation)):
                            return
                        await self.playback.play(chunk)
                    if response.cancelled.is_set() or (not response.system and not self.owns(response.correlation)):
                        return
                    response.last_played += 1
                    if not response.system:
                        await self._progress(event, last_completed=response.last_played)
                finally:
                    response.queue.task_done()
        except asyncio.CancelledError:
            response.cancelled.set()
            raise
        except Exception:
            response.cancelled.set()
            await self.playback.stop()
            if response.text:
                self.generated(response.correlation, response.text)
            self._error('tts_playback_failed')
            if self.aborted:
                self.aborted(response.correlation, reason='tts_playback_failed')
        finally:
            if self.active is response:
                self.active = None

    async def _progress(self, event, **kwargs):
        callback = getattr(self.bridge, 'progress', None)
        if callable(callback):
            await callback(event, **kwargs)

    def _error(self, code):
        self.notify('runtime.state', state='listening', stage='playback', result=code, error_code=code)

    async def interrupt(self):
        response = self.active
        if response is None:
            return
        self.active = None
        response.cancelled.set()
        if response.task and not response.task.done():
            response.task.cancel()
        await self.playback.stop()
        if response.task:
            try:
                await asyncio.wait_for(asyncio.gather(response.task, return_exceptions=True), 1.0)
            except TimeoutError:
                # The provider's native worker may be inside a blocking socket.
                # Playback is already stopped; do not delay a wake switch.
                pass
        aborter = getattr(self, 'aborted', None)
        if aborter:
            aborter(response.correlation, reason='output_interrupted')
        if not response.system:
            try:
                await self.bridge.cancel('output', response.correlation['response_id'])
            except (ConnectionError, TimeoutError, RuntimeError):
                pass

    async def say(self, text, *, voice=None):
        await self.interrupt()
        response = _Response({'response_id': 'clarification-' + uuid4().hex}, voice, system=True)
        self.active = response
        response.queue.put_nowait((None, text, voice))
        response.queue.put_nowait((None, None, voice))
        response.task = asyncio.create_task(self._play(response))
        await response.task

    async def drain(self):
        response = self.active
        if response:
            # END terminates the worker; a segment-only drain is also useful to
            # callers testing playback without manufacturing an END event.
            join = asyncio.create_task(response.queue.join())
            done, _ = await asyncio.wait({join, response.task}, return_when=asyncio.FIRST_COMPLETED)
            if join not in done:
                join.cancel()
                await asyncio.gather(join, return_exceptions=True)

    async def close(self):
        await self.interrupt()
