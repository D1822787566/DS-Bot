"""Run the shared TTS worker next to the retained Qwen provider.

The worker owns synthesis only. It never joins LiveKit, publishes device audio,
or writes DS Bot Bridge events.
"""
from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path

from retained_tts import RetainedTTS
from shared_tts import serve_worker


async def synthesize_with_retry(provider, text, *, voice, sample_rate, cancellation):
    """Retry one connection/timeout failure before reporting synthesis failure."""
    for attempt in range(2):
        try:
            result = provider(text, voice=voice, sample_rate=sample_rate, cancellation=cancellation)
            if hasattr(result, '__await__'):
                result = await result
            return result
        except RuntimeError as error:
            if attempt or cancellation.is_set() or str(error) not in {
                'TTS timed out', 'TTS connection or protocol failed'
            }:
                raise
            await asyncio.sleep(.2)


async def synthesize_stream_with_retry(provider, text, *, voice, sample_rate, cancellation):
    """Retry a transient stream setup failure before any PCM is exposed.

    Once a provider has yielded audio, restarting would duplicate the prefix
    for the caller, so later failures remain terminal for that request.
    """
    transient = {'TTS timed out', 'TTS connection or protocol failed'}
    for attempt in range(2):
        emitted = False
        try:
            result = provider(text, voice=voice, sample_rate=sample_rate,
                              cancellation=cancellation)
            if hasattr(result, '__await__') and not hasattr(result, '__aiter__'):
                result = await result
            if not hasattr(result, '__aiter__'):
                if result:
                    yield result
                return
            async for chunk in result:
                emitted = True
                yield chunk
            return
        except RuntimeError as error:
            if (attempt or emitted or cancellation.is_set()
                    or str(error) not in transient):
                raise
            await asyncio.sleep(.2)


async def run(config_path: Path, *, host: str, port: int, credential: str) -> None:
    provider = RetainedTTS(config_path)

    async def synthesize(text, *, voice, sample_rate, cancellation):
        # Only the voice varies per request. The model, endpoint and audio
        # contract remain fixed by the worker's provider configuration.
        if sample_rate != 16000:
            raise ValueError('unsupported_audio_contract')
        if hasattr(provider, 'synthesize_stream'):
            async def stream_provider(text, *, voice, sample_rate, cancellation):
                return provider.synthesize_stream(text, cancellation, voice=voice)

            return synthesize_stream_with_retry(
                stream_provider, text, voice=voice,
                sample_rate=sample_rate, cancellation=cancellation)
        async def call_provider(text, *, voice, sample_rate, cancellation):
            return await provider.synthesize(text, cancellation, voice=voice)

        return await synthesize_with_retry(call_provider, text, voice=voice,
                                           sample_rate=sample_rate, cancellation=cancellation)

    server = await serve_worker(synthesize, host=host, port=port, credential=credential)
    await server.wait_closed()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=18891, type=int)
    parser.add_argument('--credential', default=os.environ.get('TTS_WORKER_CREDENTIAL', ''))
    args = parser.parse_args()
    if not args.credential:
        parser.error('--credential or TTS_WORKER_CREDENTIAL is required')
    asyncio.run(run(args.config, host=args.host, port=args.port, credential=args.credential))


if __name__ == '__main__':
    main()


