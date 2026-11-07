import numpy as np

from audio_processing import WindowsAudioProcessing


class Frame:
    def __init__(self, *, data, **_kwargs):
        self.data = bytearray(data)


class APM:
    def __init__(self):
        self.captured, self.rendered = 0, 0

    def process_stream(self, frame):
        self.captured += len(frame.data)

    def process_reverse_stream(self, frame):
        self.rendered += len(frame.data)


def test_capture_and_render_use_the_same_apm_in_exact_ten_ms_frames():
    apm = APM()
    processor = WindowsAudioProcessing(apm=apm, frame_factory=Frame)
    pcm = np.arange(320, dtype='<i2').tobytes()
    assert processor.capture(pcm[:222]) == b''
    assert processor.capture(pcm[222:]) == pcm
    processor.render(pcm[:120])
    processor.render(pcm[120:])
    assert apm.captured == apm.rendered == 640
