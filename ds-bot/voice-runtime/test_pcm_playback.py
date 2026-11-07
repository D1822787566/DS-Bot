"""Exercise the real resampler without opening an audio device."""
import asyncio
import threading

import numpy as np
import pytest

from main import WindowsPcmPlayback


class Stream:
    def __init__(self):
        self.writes = []
        self.closed = False

    def write(self, data):
        assert not self.closed
        self.writes.append(bytes(data))

    def stop(self):
        pass

    def abort(self):
        pass

    def close(self):
        self.closed = True


@pytest.mark.parametrize('rate', [16000, 44100, 48000])
@pytest.mark.parametrize('chunk_samples', [367, 16049])
def test_tts_playback_preserves_tone_and_duration_across_chunk_boundaries(rate, chunk_samples):
    if rate != 16000:
        pytest.importorskip('livekit.rtc')
    count, frequency, amplitude = 16049, 1700, 12000
    source = np.rint(amplitude * np.sin(np.arange(count) * 2 * np.pi * frequency / 16000)).astype('<i2').tobytes()
    stream, playback = Stream(), WindowsPcmPlayback()
    playback._stream, playback.sample_rate = stream, rate

    async def run():
        for offset in range(0, len(source), chunk_samples * 2):
            await playback.play(source[offset:offset + chunk_samples * 2])
        await playback.drain()
    asyncio.run(run())

    result = np.frombuffer(b''.join(stream.writes), dtype='<i2').astype(float)
    assert len(result) == round(count * rate / 16000)
    assert all(len(part) <= rate // 10 * 2 for part in stream.writes)
    expected = amplitude * np.sin(np.arange(len(result)) * 2 * np.pi * frequency / rate)
    # Ignore only the filter's edge response. A phase reset at each write or
    # provider chunk distorts this tone throughout the recording.
    error = np.sqrt(np.mean((result[300:-300] - expected[300:-300]) ** 2))
    assert error / amplitude < .001
    assert stream.closed


def test_interrupt_discards_unwritten_audio_and_resampler_tail():
    pytest.importorskip('livekit.rtc')
    started, release = threading.Event(), threading.Event()

    class BlockingStream(Stream):
        def write(self, data):
            self.writes.append(bytes(data))
            started.set()
            assert release.wait(2)

        def abort(self):
            release.set()

    async def run():
        stream, playback = BlockingStream(), WindowsPcmPlayback()
        playback._stream, playback.sample_rate = stream, 48000
        task = asyncio.create_task(playback.play(b'\x00\x10' * 16000))
        assert await asyncio.to_thread(started.wait, 2)
        await playback.stop()
        await task
        await playback.drain()
        assert len(stream.writes) == 1
        # Reusing the boundary for the next Bot must not flush the old filter.
        fresh = Stream()
        playback._stream = fresh
        await playback.play(b'\x00\x00' * 800)
        await playback.drain()
        assert len(b''.join(fresh.writes)) == 800 * 3 * 2
        assert np.max(np.abs(np.frombuffer(b''.join(fresh.writes), dtype='<i2'))) <= 1
    asyncio.run(run())
