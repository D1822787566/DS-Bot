"""Exercise the native LiveKit Windows output boundary without opening a device."""
import asyncio
import sys
from types import ModuleType, SimpleNamespace

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


def test_playback_uses_livekit_native_track_resampling_at_the_16khz_tts_boundary(monkeypatch):
    class Frame:
        def __init__(self, data, sample_rate, num_channels, samples_per_channel):
            self.data = bytes(data)
            self.sample_rate = sample_rate
            self.num_channels = num_channels
            self.samples_per_channel = samples_per_channel

    class Source:
        def __init__(self, sample_rate, channels):
            self.sample_rate, self.channels, self.frames = sample_rate, channels, []

        async def capture_frame(self, frame):
            self.frames.append(frame)

        async def wait_for_playout(self):
            return None

        async def aclose(self):
            return None

    class Track:
        @staticmethod
        def create_audio_track(name, source):
            return (name, source)

    class Player:
        def __init__(self):
            self.tracks, self.started, self.closed = [], False, False

        async def add_track(self, track):
            self.tracks.append(track)

        async def start(self):
            self.started = True

        async def aclose(self):
            self.closed = True

    class MediaDevices:
        instances = []

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.player = Player()
            self.__class__.instances.append(self)

        def open_output(self, *, output_device):
            self.output_device = output_device
            return self.player

    rtc = SimpleNamespace(AudioFrame=Frame, AudioSource=Source,
                          LocalAudioTrack=Track, MediaDevices=MediaDevices)
    livekit = ModuleType('livekit')
    livekit.rtc = rtc
    monkeypatch.setitem(sys.modules, 'livekit', livekit)
    monkeypatch.setattr('main.os.name', 'nt')
    sounddevice = SimpleNamespace(
        default=SimpleNamespace(device=(1, 18)),
        query_devices=lambda: [{'index': 18, 'name': 'speaker', 'max_output_channels': 2,
                                'hostapi': 2, 'default_samplerate': 48000}],
        query_hostapis=lambda: [{'name': 'Windows WASAPI'}],
    )
    monkeypatch.setitem(sys.modules, 'sounddevice', sounddevice)

    playback = WindowsPcmPlayback('speaker')

    async def run():
        await playback.start()
        await playback.play(b'\x00\x01' * 1000)
        await playback.drain()

    asyncio.run(run())
    media = MediaDevices.instances[0]
    source = media.player.tracks[0][1]
    assert media.kwargs == {'input_sample_rate': 48000, 'output_sample_rate': 48000, 'num_channels': 1}
    assert media.output_device == 18
    assert media.player.started is True
    assert len(source.frames) == 4
    assert all(frame.sample_rate == 16000 and frame.num_channels == 1 for frame in source.frames)
    assert b''.join(frame.data for frame in source.frames) == b'\x00\x01' * 1000


def test_interrupt_closes_native_player_without_draining_queued_audio(monkeypatch):
    class Frame:
        def __init__(self, data, sample_rate, num_channels, samples_per_channel):
            self.data = bytes(data)
            self.sample_rate = sample_rate
            self.num_channels = num_channels
            self.samples_per_channel = samples_per_channel

    class Source:
        def __init__(self, *_args):
            self.frames, self.waits, self.closed = [], 0, False

        async def capture_frame(self, frame):
            self.frames.append(frame)

        async def wait_for_playout(self):
            self.waits += 1

        async def aclose(self):
            self.closed = True

    class Player:
        def __init__(self):
            self.closed = False

        async def add_track(self, _track):
            return None

        async def start(self):
            return None

        async def aclose(self):
            self.closed = True

    class MediaDevices:
        latest = None

        def __init__(self, **_kwargs):
            self.player = Player()
            self.__class__.latest = self

        def open_output(self, *, output_device):
            self.output_device = output_device
            return self.player

    class Track:
        @staticmethod
        def create_audio_track(_name, _source):
            return object()

    livekit = ModuleType('livekit')
    livekit.rtc = SimpleNamespace(AudioFrame=Frame, AudioSource=Source,
                                  LocalAudioTrack=Track, MediaDevices=MediaDevices)
    monkeypatch.setitem(sys.modules, 'livekit', livekit)
    monkeypatch.setattr('main.os.name', 'nt')
    monkeypatch.setitem(sys.modules, 'sounddevice', SimpleNamespace(
        default=SimpleNamespace(device=(1, 18)),
        query_devices=lambda: [{'index': 18, 'name': 'speaker', 'max_output_channels': 2,
                                'hostapi': 2, 'default_samplerate': 48000}],
        query_hostapis=lambda: [{'name': 'Windows WASAPI'}],
    ))

    async def run():
        playback = WindowsPcmPlayback('speaker')
        await playback.start()
        await playback.play(b'\x00\x10' * 400)
        media, source = MediaDevices.latest, playback._source
        await playback.stop()
        await playback.play(b'\x00\x10' * 400)
        assert source.closed and source.waits == 0
        assert media.player.closed
        assert playback._source is None
    asyncio.run(run())
