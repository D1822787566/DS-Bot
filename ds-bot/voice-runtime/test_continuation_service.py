"""The owned classifier must preserve the frozen provider and fail closed."""
import asyncio
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from aiohttp import web
from continuation_input import ContinuationContext, ContinuationTurn
from voice_addressing import ContextSnapshot


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('continuation_service'), 'DS Bot needs its owned continuation provider')
        return importlib.import_module('continuation_service')

    async def evaluator(self, handler, timeout=1.):
        app = web.Application()
        app.router.add_post('/chat/completions', handler)
        runner = web.AppRunner(app, shutdown_timeout=.1)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        await web.TCPSite(runner, '127.0.0.1', 0).start()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name, 'continuation.env')
        path.write_text(f'BASE_URL=http://127.0.0.1:{runner.addresses[0][1]}\nMODEL=deepseek-flash\nAPI_KEY=provider-only-key\n', encoding='utf-8')
        evaluator = self.module().ManagedContinuationEvaluator(path, timeout=timeout)
        self.addAsyncCleanup(evaluator.aclose)
        return evaluator

    async def test_real_http_preserves_frozen_prompt_options_scores_and_connection(self):
        requests, transports = [], set()
        decisions = iter(('current_role', 'other', 'uncertain'))
        async def provider(request):
            transports.add(request.transport)
            requests.append((await request.json(), request.headers.get('Authorization')))
            return web.json_response({'model': 'deepseek-flash', 'choices': [{'finish_reason': 'stop', 'message': {
                'role': 'assistant', 'content': json.dumps({'decision': next(decisions), 'evidence': '当前对象线索'})}}]})
        evaluator = await self.evaluator(provider)
        snapshot = ContextSnapshot('bot-a', 'owner', 'profile-1', agent_names=('华子',), wake_names=('华子',))
        turn = ContinuationTurn('input-1', 'response-1', '请介绍公园。', '公园周末开放。')
        context = ContinuationContext(1, turn.user_text, turn.agent_reply, 2, turns=(turn,))
        for score in (1., 0., .5):
            self.assertEqual(await evaluator(snapshot, context, '你能再说具体一点吗？'), score)
        self.assertEqual(len(transports), 1)
        for payload, authorization in requests:
            self.assertEqual(authorization, 'Bearer provider-only-key')
            self.assertEqual(payload['model'], 'deepseek-flash')
            self.assertEqual(payload['messages'][0]['content'], self.module().frozen_prompt())
            self.assertIn('[待判断的当前转写]', payload['messages'][1]['content'])
            for key, value in self.module().REQUEST_OPTIONS.items():
                self.assertEqual(payload[key], value)
            self.assertNotIn('provider-only-key', json.dumps(payload))

    async def test_invalid_or_incomplete_provider_result_never_admits(self):
        module = self.module()
        for content in ('{}', '[]', '{"decision":"current_role","evidence":"x","decision":"other"}'):
            response = {'model': 'deepseek-flash', 'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': content}}]}
            with self.assertRaisesRegex(ValueError, 'invalid_or_incomplete_llm_decision'):
                module.parse_llm_decision(response, expected_model='deepseek-flash')
        with self.assertRaisesRegex(ValueError, 'invalid_or_incomplete_llm_decision'):
            module.parse_llm_decision({'model': 'different'}, expected_model='deepseek-flash')

    async def test_provider_timeout_and_closed_lifecycle_fail_closed(self):
        async def provider(_):
            await asyncio.sleep(.05)
            return web.json_response({})
        evaluator = await self.evaluator(provider, timeout=.01)
        snapshot = ContextSnapshot('bot-a', 'owner', 'profile-1', agent_names=('华子',), wake_names=('华子',))
        turn = ContinuationTurn('input-1', 'response-1', '前一问', '前一答')
        context = ContinuationContext(1, turn.user_text, turn.agent_reply, 1, turns=(turn,))
        with self.assertRaises(TimeoutError):
            await evaluator(snapshot, context, '你能解释吗？')
        await evaluator.aclose()
        with self.assertRaisesRegex(RuntimeError, 'continuation_provider_closed'):
            await evaluator(snapshot, context, '你能解释吗？')

    async def test_private_configuration_requires_original_model_and_hides_credential(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'continuation.env')
            path.write_text('BASE_URL=https://api.deepseek.com\nMODEL=deepseek-flash\nAPI_KEY=secret-provider-key\n', encoding='utf-8')
            self.assertNotIn('secret-provider-key', repr(module.load_provider_config(path)))
            path.write_text('BASE_URL=https://api.deepseek.com\nMODEL=another\nAPI_KEY=secret-provider-key\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'continuation_provider_not_configured'):
                module.ManagedContinuationEvaluator(path)


if __name__ == '__main__':
    unittest.main()
