"""Retained Qwen tts_v2 wire protocol, isolated from the retired Gateway pipeline."""
import asyncio
import json
from pathlib import Path
import threading
import time
from uuid import uuid4

from websockets.sync.client import connect as websocket_connect


class RetainedTTS:
    def __init__(self, config_path=None, *, config=None, connect=websocket_connect):
        if config is None:
            config = {}
            for line in Path(config_path).read_text(encoding='utf-8-sig').splitlines():
                if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    config[key.strip()] = value.strip().strip('"').strip("'")
        self.key = config.get('TTS_API_KEY', '')
        self.voice = config.get('TTS_VOICE') or 'longanxiaoxin'
        self.model = config.get('TTS_MODEL', 'qwen-audio-3.0-tts-flash')
        self.url = config.get('TTS_WS_URL', 'wss://maas.qianwenaiapi.com/api-ws/v1/inference')
        if not self.key:
            raise ValueError('TTS_API_KEY missing')
        if config.get('TTS_AUDIO_FORMAT', 'pcm') != 'pcm' or int(config.get('TTS_SAMPLE_RATE', 16000)) != 16000:
            raise ValueError('Retained TTS requires pcm / 16000 Hz')
        if config.get('TTS_PROVIDER', 'dashscope_tts_v2') != 'dashscope_tts_v2':
            raise ValueError('Unsupported TTS_PROVIDER')
        self.connect = connect

    async def synthesize(self, text, cancellation_token=None, *, voice=None):
        cancelled = cancellation_token or threading.Event()
        try:
            return await asyncio.to_thread(self._synthesize, text, cancelled, voice=voice)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async def synthesize_stream(self, text, cancellation_token=None, *, voice=None):
        """Yield provider PCM frames as the duplex websocket receives them."""
        cancelled = cancellation_token or threading.Event()
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        def publish(kind, value=None):
            loop.call_soon_threadsafe(queue.put_nowait, (kind, value))

        def run():
            try:
                self._synthesize_stream(text, cancelled,
                                        lambda chunk: publish('audio', chunk), voice=voice)
                publish('done')
            except BaseException as error:
                publish('error', error)

        task = asyncio.create_task(asyncio.to_thread(run))
        finished = False
        try:
            while True:
                kind, value = await queue.get()
                if kind == 'audio':
                    yield value
                elif kind == 'done':
                    finished = True
                    return
                else:
                    finished = True
                    raise value
        finally:
            # This token belongs to the whole response.  Finishing one
            # sentence must not cancel later sentences or suppress complete.
            if not finished:
                cancelled.set()
            if not task.done():
                await task

    def _synthesize(self, text, cancelled, *, voice=None):
        audio = bytearray()
        self._synthesize_stream(text, cancelled, audio.extend, voice=voice)
        return bytes(audio)

    def _synthesize_stream(self, text, cancelled, emit, *, voice=None):
        if cancelled.is_set() or not text.strip():
            return
        selected_voice = self.voice if voice is None else voice
        if not isinstance(selected_voice, str) or not selected_voice.strip():
            raise ValueError('voice is required')
        task = uuid4().hex
        socket = None
        total_bytes = 0
        def send(action, payload):
            socket.send(json.dumps({'header': {'action': action, 'task_id': task, 'streaming': 'duplex'}, 'payload': payload}))
        try:
            socket = self.connect(self.url, additional_headers={'Authorization': 'Bearer ' + self.key}, open_timeout=10, close_timeout=1)
            send('run-task', {'task_group': 'audio', 'task': 'tts', 'function': 'SpeechSynthesizer',
                'model': self.model, 'input': {}, 'parameters': {
                    'text_type': 'PlainText', 'voice': selected_voice, 'format': 'pcm', 'sample_rate': 16000}})
            started = False
            deadline = time.monotonic() + 30
            while True:
                if cancelled.is_set():
                    send('finish-task', {'input': {'directive': 'cancel'}})
                    return b''
                if time.monotonic() > deadline:
                    raise RuntimeError('TTS timed out')
                try:
                    frame = socket.recv(timeout=.1)
                except TimeoutError:
                    continue
                if isinstance(frame, bytes):
                    total_bytes += len(frame)
                    emit(frame)
                    if total_bytes > 16000 * 2 * 120:
                        raise RuntimeError('TTS audio exceeds bounded response')
                    continue
                name = json.loads(frame).get('header', {}).get('event')
                if name == 'task-started' and not started:
                    started = True
                    send('continue-task', {'input': {'text': text}})
                    send('finish-task', {'input': {}})
                elif name == 'task-failed':
                    raise RuntimeError('TTS request rejected')
                elif name == 'task-finished':
                    if not total_bytes or total_bytes % 2:
                        raise RuntimeError('TTS empty or incomplete PCM')
                    return
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError('TTS connection or protocol failed') from None
        finally:
            if socket is not None:
                socket.close()


