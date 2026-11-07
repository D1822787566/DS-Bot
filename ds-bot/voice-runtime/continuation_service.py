"""DS Bot-owned adapter for the migrated frozen 053 continuation classifier.

The original Phone Agent provider, prompt and decoding options are retained.
Only the private connection settings are imported once; no external project,
local legacy service or additional inference model is needed at runtime.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

import aiohttp

from continuation_runtime_input import FROZEN_CANDIDATE_ID, build_continuation_runtime_state

FROZEN_MODEL = 'deepseek-flash'
FROZEN_PROMPT_SHA256 = '3e579bcee33f14e42367962cd965db568bc3926540cbb86e8ec91b19e54668c5'
REQUEST_OPTIONS = {'temperature': 0, 'max_tokens': 512, 'thinking': {'type': 'disabled'},
                   'response_format': {'type': 'json_object'}, 'stream': False}


def frozen_prompt() -> str:
    try:
        raw = Path(__file__).with_name('continuation-frozen-prompt.txt').read_bytes()
        if hashlib.sha256(raw).hexdigest() != FROZEN_PROMPT_SHA256:
            raise ValueError
        return raw.decode('utf-8')
    except (OSError, UnicodeError, ValueError):
        raise ValueError('frozen_candidate_integrity_mismatch') from None


@dataclass(frozen=True)
class ProviderConfig:
    endpoint: str
    model: str
    api_key: str = field(repr=False)


def load_provider_config(path) -> ProviderConfig:
    try:
        values = {}
        for line in Path(path).read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                if key.strip() in ('BASE_URL', 'MODEL', 'API_KEY'):
                    values[key.strip()] = value.strip().strip('"').strip("'")
        base = values.get('BASE_URL', '')
        parsed = urlsplit(base)
        if (parsed.scheme not in ('http', 'https') or not parsed.netloc
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or values.get('MODEL') != FROZEN_MODEL or not values.get('API_KEY')):
            raise ValueError
        return ProviderConfig(base.rstrip('/') + '/chat/completions', FROZEN_MODEL, values['API_KEY'])
    except (OSError, TypeError, ValueError):
        raise ValueError('continuation_provider_not_configured') from None


def _strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError('nonfinite_json_number')
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)


def parse_llm_decision(response: Mapping[str, object], *, expected_model: str) -> str:
    """Preserve the original strict final-response contract; no fallback admits."""
    try:
        if (not isinstance(response, Mapping) or response.get('model') != expected_model
                or 'error' in response):
            raise ValueError
        choices = response['choices']
        if not isinstance(choices, list) or len(choices) != 1 or choices[0]['finish_reason'] != 'stop':
            raise ValueError
        message = choices[0]['message']
        if (message.get('role') != 'assistant' or message.get('tool_calls')
                or message.get('function_call') or not isinstance(message.get('content'), str)):
            raise ValueError
        answer = _strict_json(message['content'])
        if (not isinstance(answer, dict) or set(answer) != {'decision', 'evidence'}
                or answer['decision'] not in ('current_role', 'other', 'uncertain')
                or not isinstance(answer['evidence'], str) or not answer['evidence'].strip()
                or len(answer['evidence']) > 120):
            raise ValueError
        return answer['decision']
    except (AttributeError, KeyError, TypeError, ValueError, IndexError):
        raise ValueError('invalid_or_incomplete_llm_decision') from None


class ManagedContinuationEvaluator:
    """Async score evaluator matching ContinuationAdmission's existing boundary."""
    candidate_id = FROZEN_CANDIDATE_ID

    def __init__(self, config_path, *, timeout=2.):
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('continuation_timeout_invalid')
        self.provider = load_provider_config(config_path)
        self.prompt = frozen_prompt()
        self.timeout = float(timeout)
        self._session = None
        self._closed = False

    async def __call__(self, snapshot, context, text) -> float:
        if self._closed:
            raise RuntimeError('continuation_provider_closed')
        state = build_continuation_runtime_state(snapshot, context, text)
        if not isinstance(state, str) or not state.strip() or len(state) > 32768:
            raise ValueError('invalid_continuation_state')
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout))
        body = {'model': FROZEN_MODEL, 'messages': [
            {'role': 'system', 'content': self.prompt}, {'role': 'user', 'content': state}],
            'temperature': 0, 'max_tokens': 512, 'thinking': {'type': 'disabled'},
            'response_format': {'type': 'json_object'}, 'stream': False}
        async with self._session.post(self.provider.endpoint, json=body,
                                      headers={'Authorization': 'Bearer ' + self.provider.api_key},
                                      allow_redirects=False) as response:
            if response.status != 200:
                raise RuntimeError(f'continuation_provider_http_{response.status}')
            decision = parse_llm_decision(await response.json(loads=_strict_json), expected_model=FROZEN_MODEL)
        return {'current_role': 1., 'other': 0., 'uncertain': .5}[decision]

    async def aclose(self):
        self._closed = True
        if self._session is not None:
            await self._session.close()
