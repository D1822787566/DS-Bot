import asyncio
from types import SimpleNamespace

import numpy as np

from audio_adapter import AudioSegment, OwnerDecision
from speech_models import SpeechModels
from voice_input import VoiceInput


ROLES = {'activity_epoch': 'epoch', 'revision': 1, 'roles': [
    {'bot_id': 'a', 'session_id': 'chat-a', 'wake_names': ['华子'], 'profile_version': 1},
    {'bot_id': 'b', 'session_id': 'chat-b', 'wake_names': ['小贝'], 'profile_version': 1},
]}


class Bridge:
    def __init__(self):
        self.sent = []

    async def publish_wake(self, payload):
        return SimpleNamespace(type='device.wake.accepted', payload=payload)

    async def submit(self, text, **kwargs):
        self.sent.append({'text': text, **kwargs})
        return SimpleNamespace(type='input.accepted', payload={'status': 'queued'})

    async def context_snapshot(self, bot_id, **kwargs):
        return SimpleNamespace(payload={'bot_id': bot_id, 'user_id': 'owner', 'profile_version': 1,
                                       'agent_names': ['华子' if bot_id == 'a' else '小贝'],
                                       'wake_names': ['华子' if bot_id == 'a' else '小贝']})


class Clock:
    def __init__(self):
        self.now = 100.

    def __call__(self):
        return self.now


def audio(identifier=1, start=100.2, end=101.):
    return AudioSegment(np.ones(round((end - start) * 16000), dtype=np.float32) * .2,
                        16000, identifier, end, start)


def subject(texts=None, *, verified=True, enabled=True, scorer=None):
    clock, bridge, events = Clock(), Bridge(), []
    texts = texts or {1: '检查项目'}
    models = SpeechModels(lambda item: texts.get(item.segment_id, ''), lambda item:
        OwnerDecision('owner' if verified else 'unknown', .95 if verified else .1,
                      'verified' if verified else 'unknown', item.segment_id, 'cam++', 'profile'))
    pipeline = VoiceInput(bridge, models, config={'continuationEnabled': enabled},
                          evaluator=scorer or (lambda *_args: .95), clock=clock,
                          notify=lambda kind, **fields: events.append((kind, fields)))
    return pipeline, bridge, clock, events


async def wake(pipeline, bot='a', identifier='w1'):
    return await pipeline.wake({'bot_id': bot, 'wake_session_id': identifier,
                                'wake_mapping_version': 'epoch:1'}, ROLES)


async def reply(pipeline, bridge):
    item = bridge.sent[-1]
    correlation = {key: item[key] for key in ('input_id', 'bot_id', 'session_id', 'wake_session_id', 'generation')}
    correlation['response_id'] = 'reply-' + item['input_id']
    assert pipeline.owns_output(correlation)
    pipeline.reply_finished(correlation, '项目里有三个问题')


def test_first_owner_turn_enters_only_the_woken_bot_existing_session():
    async def run():
        pipeline, bridge, clock, _ = subject()
        await pipeline.process(audio())
        assert bridge.sent == []
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio())
        item = bridge.sent[0]
        assert (item['text'], item['bot_id'], item['session_id']) == ('检查项目', 'a', 'chat-a')
        assert item['speaker']['status'] == 'owner_verified' and item['speaker']['model_id'] == 'cam++'
        assert item['wake_session_id'] == 'w1' and item['segment_id'] == 1
    asyncio.run(run())


def test_name_only_does_not_submit_and_next_utterance_needs_no_second_wake():
    async def run():
        pipeline, bridge, clock, _ = subject({1: '华子', 2: '检查项目'})
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio(1, 99.9, 101.))
        assert bridge.sent == []
        clock.now = 102.
        await pipeline.process(audio(2, 101.2, 102.))
        assert [item['text'] for item in bridge.sent] == ['检查项目']
    asyncio.run(run())


def test_first_turn_preserves_the_wake_name_in_the_submitted_transcript():
    async def run():
        pipeline, bridge, clock, _ = subject({1: '华子，检查项目'})
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio())
        assert [item['text'] for item in bridge.sent] == ['华子，检查项目']
    asyncio.run(run())


def test_followup_preserves_the_complete_asr_transcript_including_the_wake_name():
    async def run():
        pipeline, bridge, clock, _ = subject({1: '华子，检查项目', 2: '华子，再具体一点'})
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio())
        await reply(pipeline, bridge)
        clock.now = 102.
        await pipeline.process(audio(2, 101.2, 102.))
        assert [item['text'] for item in bridge.sent] == ['华子，检查项目', '华子，再具体一点']
    asyncio.run(run())


def test_every_submitted_turn_preserves_the_asr_text_boundaries():
    async def run():
        pipeline, bridge, clock, _ = subject({1: '  华子，检查项目  ', 2: '  华子，再具体一点  '})
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio())
        await reply(pipeline, bridge)
        clock.now = 102.
        await pipeline.process(audio(2, 101.2, 102.))
        assert [item['text'] for item in bridge.sent] == [
            '  华子，检查项目  ', '  华子，再具体一点  '
        ]
    asyncio.run(run())


def test_non_owner_and_empty_transcripts_never_submit():
    async def run():
        for verified, texts in [(False, {1: '检查项目'}), (True, {1: ''})]:
            pipeline, bridge, clock, _ = subject(texts, verified=verified)
            await wake(pipeline)
            clock.now = 101.
            await pipeline.process(audio())
            assert bridge.sent == []
    asyncio.run(run())


def test_second_turn_uses_semantic_gate_and_disabling_it_requires_a_new_wake():
    async def run():
        for enabled, score, count in [(True, .95, 2), (True, .05, 1), (False, .95, 1)]:
            pipeline, bridge, clock, _ = subject({1: '检查项目', 2: '再具体一点'}, enabled=enabled, scorer=lambda *_: score)
            await wake(pipeline)
            clock.now = 101.
            await pipeline.process(audio())
            await reply(pipeline, bridge)
            clock.now = 102.
            await pipeline.process(audio(2, 101.2, 102.))
            assert len(bridge.sent) == count
    asyncio.run(run())


def test_switch_during_asr_invalidates_the_original_audio_instead_of_rerouting_it():
    async def run():
        pipeline, bridge, clock, _ = subject()
        started, finish = asyncio.Event(), asyncio.Event()

        async def recognize(item):
            started.set()
            await finish.wait()
            return '检查项目', OwnerDecision('owner', .95, 'verified', item.segment_id, 'cam++', 'profile')

        pipeline.models.recognize = recognize
        await wake(pipeline)
        clock.now = 101.
        task = asyncio.create_task(pipeline.process(audio()))
        await started.wait()
        await wake(pipeline, 'b', 'w2')
        finish.set()
        await task
        assert bridge.sent == []
        assert pipeline.lease.bot_id == 'b'
    asyncio.run(run())


def test_long_first_utterance_begun_before_timeout_can_finish_but_late_start_cannot():
    async def run():
        pipeline, bridge, clock, _ = subject()
        await wake(pipeline)
        clock.now = 112.
        await pipeline.process(audio(1, 107., 112.))
        assert len(bridge.sent) == 1
        pipeline, bridge, clock, _ = subject()
        await wake(pipeline)
        clock.now = 110.
        await pipeline.process(audio(1, 109., 110.))
        assert bridge.sent == []
    asyncio.run(run())


def test_uncertain_followup_asks_once_and_confirmation_submits_original_owner_segment():
    async def run():
        pipeline, bridge, clock, _ = subject({1: '检查项目', 2: '然后再检查配置', 3: '是的'}, scorer=lambda *_: .5)
        prompts = []
        async def clarify(text, bot_id):
            prompts.append((text, bot_id))
        pipeline.clarify = clarify
        await wake(pipeline)
        clock.now = 101.
        await pipeline.process(audio())
        await reply(pipeline, bridge)
        clock.now = 102.
        await pipeline.process(audio(2, 101.2, 102.))
        assert len(prompts) == 1 and len(bridge.sent) == 1
        clock.now = 103.
        await pipeline.process(audio(3, 102.2, 103.))
        assert bridge.sent[-1]['text'] == '然后再检查配置'
        assert bridge.sent[-1]['segment_id'] == bridge.sent[-1]['speaker']['segment_id'] == 2
    asyncio.run(run())


def test_roster_disconnect_while_confirming_wake_never_reopens_old_target():
    async def run():
        pipeline, bridge, _, _ = subject()
        entered, finish = asyncio.Event(), asyncio.Event()
        async def delayed(payload):
            entered.set()
            await finish.wait()
            return SimpleNamespace(type='device.wake.accepted', payload=payload)
        bridge.publish_wake = delayed
        pending = asyncio.create_task(wake(pipeline))
        await entered.wait()
        pipeline.invalidate()
        finish.set()
        assert await pending is False
        assert pipeline.lease is None and pipeline.sessions.current is None
    asyncio.run(run())
