"""The small, authenticated wire boundary shared by desktop and LiveKit TTS."""
from __future__ import annotations

import asyncio
import base64
import inspect
import json
import threading
import time
from hmac import compare_digest
from uuid import uuid4


PROTOCOL = 'shared-tts.v1'
SAMPLE_RATE = 16000
CHANNELS = 1
AUDIO_FORMAT = 'pcm_s16le'


def validate_request(message: dict) -> dict:
    if not isinstance(message, dict) or message.get('type') != 'synthesize':
        raise ValueError('invalid_request')
    required = ('request_id', 'response_id', 'text', 'voice')
    if any(not isinstance(message.get(key), str) or not message[key].strip() for key in required):
        raise ValueError('invalid_request')
    if len(message['text']) > 16_000:
        raise ValueError('text_too_long')
    if message.get('sample_rate') != SAMPLE_RATE or message.get('format') != AUDIO_FORMAT:
        raise ValueError('unsupported_audio_contract')
    return message


async def _send(send, message: dict) -> None:
    result = send(message)
    if inspect.isawaitable(result):
        await result


class SharedTTSWorker:
    """Serve one authenticated websocket connection.

    ``provider`` receives text, voice, sample rate and a threading Event. It may
    be synchronous (the retained Qwen client is) or asynchronous.
    """

    def __init__(self, provider, *, credential: str, chunk_bytes: int = 32 * 1024,
                 timeout: float = 30.0):
        self.provider = provider
        self.credential = credential
        self.chunk_bytes = chunk_bytes
        self.timeout = timeout
        self.authorized = False
        self._tasks: dict[str, asyncio.Task] = {}
        self._cancelled: set[str] = set()
        self._cancel_sent: set[str] = set()
        self._cancellations: dict[str, threading.Event] = {}

    async def handle_message(self, message: dict, send) -> None:
        if not isinstance(message, dict):
            await _send(send, {'type': 'error', 'error_code': 'invalid_request'})
            return
        kind = message.get('type')
        if kind == 'hello':
            if not isinstance(message.get('token'), str) or not compare_digest(message['token'], self.credential):
                await _send(send, {'type': 'error', 'error_code': 'unauthorized'})
                return
            self.authorized = True
            await _send(send, {'type': 'ready', 'protocol': PROTOCOL})
            return
        if not self.authorized:
            await _send(send, {'type': 'error', 'error_code': 'unauthorized'})
            return
        if kind == 'cancel':
            await self._cancel(message.get('response_id'), send)
            return
        if kind != 'synthesize':
            await _send(send, {'type': 'error', 'error_code': 'invalid_request'})
            return
        try:
            request = validate_request(message)
        except ValueError as error:
            await _send(send, {'type': 'error', 'error_code': str(error)})
            return
        response_id = request['response_id']
        if response_id in self._tasks:
            await _send(send, {'type': 'error', 'response_id': response_id, 'error_code': 'response_id_reused'})
            return
        cancellation = threading.Event()
        self._cancellations[response_id] = cancellation
        self._tasks[response_id] = asyncio.create_task(
            self._run(request, cancellation, send))

    async def _cancel(self, response_id, send) -> None:
        if not isinstance(response_id, str) or not response_id:
            await _send(send, {'type': 'error', 'error_code': 'invalid_request'})
            return
        self._cancelled.add(response_id)
        cancellation = self._cancellations.get(response_id)
        if cancellation is not None:
            # The provider sees this through its cancellation token. Do not
            # cancel the asyncio task: a synchronous provider must unwind first.
            cancellation.set()
        if response_id not in self._cancel_sent:
            self._cancel_sent.add(response_id)
            await _send(send, {'type': 'cancelled', 'response_id': response_id})

    async def _send_audio(self, request, response_id, chunk, cancellation, send) -> None:
        if not isinstance(chunk, bytes) or not chunk or len(chunk) % 2:
            raise ValueError('invalid_pcm')
        for offset in range(0, len(chunk), self.chunk_bytes):
            if cancellation.is_set() or response_id in self._cancelled:
                return
            await _send(send, {'type': 'audio', 'request_id': request['request_id'],
                               'response_id': response_id,
                               'sample_rate': SAMPLE_RATE, 'channels': CHANNELS,
                               'format': AUDIO_FORMAT,
                               'data': base64.b64encode(chunk[offset:offset + self.chunk_bytes]).decode('ascii')})

    async def _run_provider(self, request, cancellation, send) -> None:
        response_id = request['response_id']
        result = self.provider(request['text'], voice=request['voice'],
                               sample_rate=SAMPLE_RATE, cancellation=cancellation)
        if inspect.isawaitable(result):
            result = await result
        if hasattr(result, '__aiter__'):
            sent_audio = False
            async for chunk in result:
                if cancellation.is_set() or response_id in self._cancelled:
                    return
                sent_audio = True
                await self._send_audio(request, response_id, chunk, cancellation, send)
            if not sent_audio:
                raise ValueError('invalid_pcm')
            return
        if not isinstance(result, bytes) or not result or len(result) % 2:
            raise ValueError('invalid_pcm')
        if cancellation.is_set() or response_id in self._cancelled:
            return
        await self._send_audio(request, response_id, result, cancellation, send)

    async def _run_provider_with_timeout(self, request, cancellation, send) -> None:
        task = asyncio.create_task(self._run_provider(request, cancellation, send))
        try:
            await asyncio.wait_for(asyncio.shield(task), self.timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            # Set the provider token before cancelling the task.  Retained
            # providers use it to close their upstream websocket promptly.
            cancellation.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise

    async def _run(self, request, cancellation, send) -> None:
        response_id = request['response_id']
        try:
            if response_id in self._cancelled:
                return
            await self._run_provider_with_timeout(request, cancellation, send)
            if cancellation.is_set() or response_id in self._cancelled:
                return
            await _send(send, {'type': 'complete', 'request_id': request['request_id'],
                               'response_id': response_id, 'sample_rate': SAMPLE_RATE,
                               'channels': CHANNELS, 'format': AUDIO_FORMAT})
        except asyncio.CancelledError:
            cancellation.set()
            raise
        except Exception as error:
            if response_id not in self._cancelled:
                print(f"shared_tts provider failure: {type(error).__name__}", flush=True)
                await _send(send, {'type': 'error', 'request_id': request['request_id'],
                                   'response_id': response_id, 'error_code': 'synthesis_failed',
                                   'provider_error': type(error).__name__})

    async def close(self) -> None:
        """Stop provider work when the client websocket goes away."""
        for cancellation in self._cancellations.values():
            cancellation.set()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._cancellations.clear()

    async def wait(self, response_id: str) -> None:
        task = self._tasks.get(response_id)
        if task is not None:
            await task


class SharedTTSClient:
    def __init__(self, url: str, credential: str, *, voice: str = 'longanxiaoxin',
                 timeout: float = 30.0, connect=None):
        if not url:
            raise ValueError('TTS worker URL missing')
        self.url, self.credential, self.voice, self.timeout = url, credential, voice, timeout
        self._connect = connect

    async def synthesize_pcm16(self, text: str, cancellation_token=None, *,
                               voice: str | None = None) -> bytes:
        cancellation = cancellation_token or threading.Event()
        audio = bytearray()
        async for chunk in self.synthesize_pcm16_stream(
                text, cancellation_token=cancellation, voice=voice):
            audio.extend(chunk)
        if cancellation.is_set() or len(audio) % 2:
            return b''
        return bytes(audio)

    async def synthesize_pcm16_stream(self, text: str, cancellation_token=None, *,
                                      voice: str | None = None):
        if not text or not text.strip():
            return
        cancellation = cancellation_token or threading.Event()
        from websockets.asyncio.client import connect
        connector = self._connect or connect
        response_id, request_id = uuid4().hex, uuid4().hex
        deadline = time.monotonic() + self.timeout
        async with connector(self.url, additional_headers={'Authorization': 'Bearer ' + self.credential}) as socket:
            # The worker intentionally authenticates in-band so both native and
            # Python clients use the same protocol and diagnostics.
            await socket.send(json.dumps({'type': 'hello', 'token': self.credential}))
            await socket.send(json.dumps({'type': 'synthesize', 'request_id': request_id,
                                          'response_id': response_id, 'text': text,
                                          'voice': self.voice if voice is None else voice,
                                          'sample_rate': SAMPLE_RATE,
                                          'format': AUDIO_FORMAT}))
            cancel_sent = False
            while True:
                if cancellation.is_set() and not cancel_sent:
                    await socket.send(json.dumps({'type': 'cancel', 'response_id': response_id}))
                    cancel_sent = True
                if time.monotonic() > deadline:
                    if not cancel_sent:
                        await socket.send(json.dumps({'type': 'cancel', 'response_id': response_id}))
                    raise RuntimeError('TTS worker timed out')
                try:
                    raw = await asyncio.wait_for(socket.recv(), .1)
                except asyncio.TimeoutError:
                    continue
                message = json.loads(raw)
                kind = message.get('type')
                if kind == 'ready':
                    continue
                if kind == 'audio':
                    if message.get('request_id') != request_id or message.get('response_id') != response_id:
                        raise RuntimeError('TTS worker response mismatch')
                    if message.get('sample_rate') != SAMPLE_RATE or message.get('channels') != CHANNELS or message.get('format') != AUDIO_FORMAT:
                        raise RuntimeError('TTS worker audio contract mismatch')
                    if not cancellation.is_set():
                        yield base64.b64decode(message['data'], validate=True)
                elif kind == 'cancelled':
                    return
                elif kind == 'complete':
                    if message.get('request_id') != request_id or message.get('response_id') != response_id:
                        raise RuntimeError('TTS worker completion mismatch')
                    return
                elif kind == 'error':
                    error_code = str(message.get('error_code', 'failed'))
                    provider_error = message.get('provider_error')
                    suffix = f": {provider_error}" if isinstance(provider_error, str) else ''
                    raise RuntimeError('TTS worker ' + error_code + suffix)


async def serve_worker(provider, *, host='127.0.0.1', port=18891, credential='', chunk_bytes=32 * 1024):
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed

    async def handler(socket):
        worker = SharedTTSWorker(provider, credential=credential, chunk_bytes=chunk_bytes)
        try:
            async for raw in socket:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    await socket.send(json.dumps({'type': 'error', 'error_code': 'invalid_request'}))
                    continue
                await worker.handle_message(message, lambda value: socket.send(json.dumps(value)))
        except ConnectionClosed:
            pass
        finally:
            await worker.close()

    return await serve(handler, host, port, max_size=8 * 1024 * 1024)


