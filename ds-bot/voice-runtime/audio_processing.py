"""Share Phone Agent's RTC echo canceller between Windows capture and render."""
from __future__ import annotations


class WindowsAudioProcessing:
    def __init__(self, *, apm=None, frame_factory=None):
        if apm is None or frame_factory is None:
            from livekit import rtc
            apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=True,
                                            high_pass_filter=True, auto_gain_control=True)
            apm.set_stream_delay_ms(50)
            frame_factory = rtc.AudioFrame
        self.apm, self.frame_factory = apm, frame_factory
        self.capture_pending = b''
        self.render_pending = b''

    def _process(self, pcm, callback):
        output = []
        for offset in range(0, len(pcm) - 319, 320):
            frame = self.frame_factory(data=pcm[offset:offset + 320], sample_rate=16000,
                                       num_channels=1, samples_per_channel=160)
            callback(frame)
            output.append(bytes(frame.data))
        return b''.join(output), pcm[(len(pcm) // 320) * 320:]

    def capture(self, pcm):
        result, self.capture_pending = self._process(self.capture_pending + pcm, self.apm.process_stream)
        return result

    def render(self, pcm):
        _, self.render_pending = self._process(self.render_pending + pcm, self.apm.process_reverse_stream)
