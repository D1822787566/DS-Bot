import numpy as np

from speech_capture import PcmSegmenter


class Vad:
    window_size_samples = 160

    def reset(self):
        pass

    def __call__(self, samples):
        return 1.0 if np.max(np.abs(samples)) > .01 else 0.0


def pcm(level, seconds):
    return np.full(round(seconds * 16000), round(level * 32767), dtype='<i2').tobytes()


def collector(**kwargs):
    return PcmSegmenter(Vad(), min_speech=.02, silence=.03, prefix=.02, **kwargs)


def test_irregular_pcm_chunks_preserve_two_complete_segments_and_read_only_samples():
    capture = collector()
    data = pcm(0, .04) + pcm(.2, .1) + pcm(0, .06) + pcm(.3, .1) + pcm(0, .05)
    segments = []
    position = 0
    for size in (222, 418, 2000, 800, 502, 1410, len(data)):
        part = data[position:position + size]
        position += len(part)
        segments += capture.feed(part, now=10 + position / 32000)
    assert len(segments) == 2
    assert [item.segment_id for item in segments] == [1, 2]
    assert all(item.sample_rate == 16000 and not item.samples.flags.writeable for item in segments)
    assert 10 <= segments[0].started_at < segments[0].ended_at < segments[1].started_at
    assert np.max(segments[0].samples) < .25
    assert np.max(segments[1].samples) > .25


def test_oversized_utterance_is_dropped_and_not_split_into_commands():
    events = []
    capture = collector(max_speech=.2, notify=lambda kind, **fields: events.append((kind, fields)))
    assert capture.feed(pcm(.2, .8) + pcm(0, .1), now=11) == []
    assert any(kind == 'audio.segment.dropped' and fields['reason'] == 'too_long' for kind, fields in events)
    assert len(capture.feed(pcm(.2, .1) + pcm(0, .1), now=11.2)) == 1


def test_device_gap_cancels_partial_audio_and_ids_do_not_repeat():
    capture = collector()
    first = capture.feed(pcm(.2, .1) + pcm(0, .1), now=10.2)
    capture.feed(pcm(.2, .1), now=10.3)
    capture.reset()
    assert capture.feed(pcm(0, .1), now=12.1) == []
    second = capture.feed(pcm(.3, .1) + pcm(0, .1), now=12.3)
    assert second[0].segment_id > first[0].segment_id

