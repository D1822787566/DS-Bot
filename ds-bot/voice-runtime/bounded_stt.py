"""A bounded offline-STT streaming envelope for LiveKit Agents 1.8.8.

ASR remains offline: VAD supplies a complete segment to the existing recognizer.
Unlike SDK StreamAdapter, its VAD reader never waits for ASR/owner/admission.
There is one active recognition across this adapter's streams and no waiting
audio segment. Busy segments keep START/END signaling and are discarded.
The emission tap relies on this pinned SDK's VADStream event channel/tee.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import inspect
import time

from livekit.agents import stt, utils
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN
from livekit.agents.vad import VADEventType


class BoundedSTTAdapter(stt.StreamAdapter):
    def __init__(self, *, stt, vad, on_busy=None):
        if on_busy is not None and (not callable(on_busy) or inspect.iscoroutinefunction(on_busy)):
            raise TypeError('on_busy_must_be_synchronous')
        super().__init__(stt=stt, vad=vad)
        self._on_busy = on_busy
        self._busy_owner = None
        self._streams = set()
        self._direct_task = None
        self._closed = False

    def _reserve(self, owner):
        if self._busy_owner is not None:
            return False
        self._busy_owner = owner
        return True

    def _release(self, owner):
        if self._busy_owner is owner:
            self._busy_owner = None

    def _notify_busy(self, event):
        if self._on_busy is None:
            return
        result = self._on_busy({
            'type': 'audio.segment.dropped',
            'reason': 'stt_busy',
            'samples_index': event.samples_index,
            'speech_duration': event.speech_duration,
        })
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            raise TypeError('on_busy_must_be_synchronous')

    async def recognize(self, buffer, *, language=NOT_GIVEN,
                        conn_options=DEFAULT_API_CONNECT_OPTIONS):
        if self._closed:
            raise RuntimeError('bounded_stt_closed')
        owner = object()
        if not self._reserve(owner):
            raise RuntimeError('stt_busy')
        self._direct_task = asyncio.current_task()
        try:
            # Delegate directly to preserve one metrics event and disallow SDK
            # retries of a segment whose admission/submit may have side effects.
            return await self.wrapped_stt.recognize(
                buffer, language=language, conn_options=replace(conn_options, max_retry=0))
        finally:
            self._direct_task = None
            self._release(owner)

    def stream(self, *, language=NOT_GIVEN, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        if self._closed:
            raise RuntimeError('bounded_stt_closed')
        stream = _BoundedRecognizeStream(
            self, language=language, conn_options=replace(conn_options, max_retry=0))
        self._streams.add(stream)
        return stream

    async def aclose(self):
        self._closed = True
        try:
            if self._direct_task is not None and self._direct_task is not asyncio.current_task():
                self._direct_task.cancel()
                await asyncio.gather(self._direct_task, return_exceptions=True)
            await asyncio.gather(*(stream.aclose() for stream in tuple(self._streams)))
        finally:
            self._streams.clear()
            await super().aclose()


class _BoundedRecognizeStream(stt.RecognizeStream):
    def __init__(self, adapter, *, language, conn_options):
        super().__init__(stt=adapter, conn_options=conn_options)
        self._adapter = adapter
        self._language = language

    async def _metrics_monitor_task(self, event_aiter):
        # The wrapped offline STT already emits recognition metrics, forwarded by
        # StreamAdapter. Drain this SDK tee peer without emitting a second copy.
        async for _ in event_aiter:
            pass

    async def _run(self):
        vad_stream = self._adapter._vad.stream()
        accepted_event = None
        send_vad_event = vad_stream._event_ch.send_nowait

        def capture_vad_event(event):
            nonlocal accepted_event
            # Pinned SDK VADStream tees this channel for metrics and recognition.
            # Decide at emission: a metrics peer may run far ahead of our reader.
            # Merely checking busy when *consuming* END would replay old segments
            # after recognition finishes. Only one reserved END retains PCM.
            if event.type == VADEventType.END_OF_SPEECH and self._adapter._reserve(self):
                accepted_event = event
                send_vad_event(event)
            else:
                if event.type == VADEventType.END_OF_SPEECH:
                    self._adapter._notify_busy(event)
                # Preserve every boundary/metric, but neither tee peer needs PCM
                # from dropped END or START/INFERENCE. Copy; never mutate VAD's
                # original prefix/utterance lists or underlying AudioFrames.
                send_vad_event(replace(event, frames=[]))

        vad_stream._event_ch.send_nowait = capture_vad_event
        # This slot transfers the one reserved segment to a fixed worker. The
        # adapter stays busy until that worker completes; nothing queues behind it.
        slot = asyncio.Queue(maxsize=1)

        async def forward_input():
            async for item in self._input_ch:
                if isinstance(item, self._FlushSentinel):
                    vad_stream.flush()
                else:
                    vad_stream.push_frame(item)
            vad_stream.end_input()

        async def drain_vad():
            nonlocal accepted_event
            async for event in vad_stream:
                if event.type == VADEventType.START_OF_SPEECH:
                    self._event_ch.send_nowait(stt.SpeechEvent(stt.SpeechEventType.START_OF_SPEECH))
                elif event.type == VADEventType.END_OF_SPEECH:
                    speech_end_time = time.time() - event.silence_duration - event.inference_duration
                    self._event_ch.send_nowait(stt.SpeechEvent(
                        stt.SpeechEventType.END_OF_SPEECH, speech_end_time=speech_end_time))
                    if event is accepted_event:
                        slot.put_nowait((event.frames, speech_end_time))
                        accepted_event = None
                # Do not retain the last dropped PCM while awaiting the next VAD
                # event. Never mutate event.frames: it may include VAD prefix data.
                event = None
            await slot.put(None)

        async def recognize_one_at_a_time():
            while True:
                item = await slot.get()
                if item is None:
                    return
                frames, speech_end_time = item
                try:
                    result = await self._adapter.wrapped_stt.recognize(
                        buffer=utils.merge_frames(frames), language=self._language,
                        conn_options=self._conn_options)
                    if result.alternatives and result.alternatives[0].text:
                        self._event_ch.send_nowait(stt.SpeechEvent(
                            stt.SpeechEventType.FINAL_TRANSCRIPT,
                            request_id=result.request_id, alternatives=[result.alternatives[0]],
                            speech_end_time=(result.speech_end_time
                                             if result.speech_end_time is not None else speech_end_time)))
                finally:
                    self._adapter._release(self)
                    item = frames = None

        tasks = [asyncio.create_task(forward_input()), asyncio.create_task(drain_vad()),
                 asyncio.create_task(recognize_one_at_a_time())]
        try:
            await asyncio.gather(*tasks)
        finally:
            await utils.aio.cancel_and_wait(*tasks)
            try:
                await vad_stream.aclose()
            finally:
                vad_stream._event_ch.send_nowait = send_vad_event
                accepted_event = None
                self._adapter._release(self)
                self._input_ch.close()
                while not self._input_ch.empty():
                    self._input_ch.recv_nowait()
                while not slot.empty():
                    slot.get_nowait()

    async def aclose(self):
        try:
            await super().aclose()
        finally:
            self._adapter._streams.discard(self)


