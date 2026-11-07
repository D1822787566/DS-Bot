import asyncio

from voice_output import VoiceOutput


class Bridge:
    def __init__(self):
        self.cancelled, self.progresses = [], []

    async def cancel(self, *args):
        self.cancelled.append(args)

    async def progress(self, event, **kwargs):
        self.progresses.append(kwargs)


class Playback:
    def __init__(self):
        self.chunks = []

    async def start(self):
        pass

    async def play(self, chunk):
        self.chunks.append(chunk)

    async def stop(self):
        pass


def event(kind, **payload):
    return {'type': kind, 'correlation': {'response_id': 'r', 'input_id': 'i', 'bot_id': 'a'}, 'payload': payload}


def test_slow_tts_does_not_block_event_receiver_and_switch_discards_old_pcm():
    async def run():
        started = asyncio.Event()

        class TTS:
            async def synthesize_stream(self, text, cancellation_token=None, *, voice=None):
                started.set()
                await asyncio.Event().wait()
                yield b'old'

        bridge, playback = Bridge(), Playback()
        output = VoiceOutput(bridge, TTS(), playback)
        await output.handle(event('output.started', tts_voice='v'))
        await output.handle(event('output.segment', segment_index=0, speak_text='你好'))
        await started.wait()
        await asyncio.wait_for(output.interrupt(), .5)
        assert playback.chunks == []
        assert bridge.cancelled == [('output', 'r')]
        await output.handle(event('output.segment', segment_index=1, speak_text='迟到的段'))
        await output.close()
        assert playback.chunks == []
    asyncio.run(run())


def test_delivery_and_continuation_begin_only_after_actual_audio_drain():
    async def run():
        ended, generated = [], []

        class TTS:
            async def synthesize_stream(self, text, cancellation_token=None, *, voice=None):
                yield text.encode()

        bridge, playback = Bridge(), Playback()
        output = VoiceOutput(bridge, TTS(), playback,
                             generated=lambda c, text: generated.append(text),
                             finished=lambda c, text: ended.append(text))
        await output.handle(event('output.started', tts_voice='v'))
        await output.handle(event('output.segment', segment_index=0, speak_text='你好'))
        await output.handle(event('output.ended', status='completed'))
        assert generated == []
        await output.drain()
        assert generated == ['你好'] and ended == ['你好'] and playback.chunks == ['你好'.encode()]
        assert bridge.progresses[-1]['terminal'] == 'delivered'
        await output.close()
    asyncio.run(run())
