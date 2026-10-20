"""Offline transport tests. Only synthetic credentials and responses are used."""
import base64
from http.client import IncompleteRead
import io
import json
from pathlib import Path
import ssl
import stat
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from botkeep_client import (APIError, APIResponse, BotkeepClient, GuardError,
                            MAX_UPLOAD_BASE64, OperationError, PREFIX,
                            REPOSITORY, RedirectRefused, UncertainWriteError,
                            WORKLOAD_ID, _NoRedirect, metadata)

SECRET = 'synthetic-unit-test-key'
IDEMPOTENCY = 'logical-write-key-0001'
BASE = PREFIX + '/workloads/' + WORKLOAD_ID


def power_operation(action='stop'):
    return {'id': 'op', 'workloadId': WORKLOAD_ID, 'action': action,
            'queueState': 'done',
            'operation': {'id': 'op', 'action': action, 'phase': 'complete'},
            'runtimeState': 'stopped' if action == 'stop' else 'running',
            'confirmed': True}


class Response:
    def __init__(self, status=200, value=None, *, body=None, headers=None):
        self.status = status
        self.headers = headers or {}
        self.body = body if body is not None else json.dumps(value or {}).encode()

    def read(self, limit):
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Transport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.responses:
            raise AssertionError('Unexpected transport request')
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class ClientTests(unittest.TestCase):
    def client(self, *responses, **options):
        transport, clock = Transport(*responses), Clock()
        client = BotkeepClient(environ={'BOTKEEP_API_KEY': SECRET}, opener=transport,
                               sleep=clock.sleep, clock=lambda: clock.now, **options)
        return client, transport, clock

    def test_service_endpoint_action_and_path_guards(self):
        with self.assertRaises(GuardError):
            BotkeepClient(workload_id='different-workload', environ={})
        client, transport, _ = self.client()
        for suffix, method in [('/environment', 'GET'), ('/resources', 'PUT'),
                               ('/github/sync', 'POST'), ('', 'DELETE'),
                               ('/file-action', 'POST')]:
            with self.subTest(suffix=suffix, method=method), self.assertRaises(GuardError):
                client._request(method, BASE + suffix, idempotency_key=IDEMPOTENCY)
        for action in ['delete', 'kill', 'redeploy', 'retry', 'restart\n']:
            with self.subTest(action=action), self.assertRaises(GuardError):
                client.action(action, idempotency_key=IDEMPOTENCY)
        for path in ['data/state.json', '/data/state.json', '.env', '.env.production',
                     'node_modules/x', '.dshoof-releases/x', 'public/../data/x',
                     '//server.mjs', 'public//app.js', '%2e%2e/x', 'a\\b']:
            with self.subTest(path=path), self.assertRaises(GuardError):
                client.upload_batch({path: b'x'}, idempotency_key=IDEMPOTENCY)
        self.assertEqual(len(transport.requests), 0)

    def test_https_destination_authorization_and_proxy_tls_defaults(self):
        client, transport, _ = self.client(Response(value={'workload': {'id': WORKLOAD_ID}}))
        client.inspect()
        request, timeout = transport.requests[0]
        self.assertEqual(request.full_url, 'https://api.botkeep.cloud' + BASE)
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + SECRET)
        self.assertNotIn(SECRET, request.full_url)
        self.assertIsNone(request.get_header('Idempotency-key'))
        self.assertLessEqual(timeout, 20)
        with patch('botkeep_client.build_opener', return_value=Transport()) as builder:
            BotkeepClient(environ={'BOTKEEP_API_KEY': SECRET})
        handlers = builder.call_args.args
        self.assertTrue(any(type(handler).__name__ == 'ProxyHandler' for handler in handlers))
        tls = next(handler for handler in handlers if type(handler).__name__ == 'HTTPSHandler')
        self.assertEqual(tls._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(tls._context.check_hostname)
        self.assertTrue(any(isinstance(handler, _NoRedirect) for handler in handlers))

    def test_low_level_guards_cannot_bypass_actions_paths_or_idempotency_identity(self):
        client, transport, _ = self.client(Response())
        for path, payload in [
            (BASE + '/actions', {'action': 'delete'}),
            (BASE + '/actions', {'action': 'restart', 'confirmRedeploy': True}),
            (BASE + '/file', {'path': 'data/state.json', 'type': 'file', 'content': 'x'}),
            (BASE + '/files/upload-batch', {'files': [{'path': '.env', 'data': 'eA==', 'overwrite': True}]}),
        ]:
            with self.subTest(path=path), self.assertRaises(GuardError):
                client._request('PUT' if path.endswith('/file') else 'POST', path,
                                payload=payload, idempotency_key=IDEMPOTENCY)
        with self.assertRaises(GuardError):
            client.action('restart', idempotency_key=IDEMPOTENCY, wait_timeout=0)
        self.assertEqual(len(transport.requests), 0)
        client.action('start', idempotency_key=IDEMPOTENCY)
        with self.assertRaises(GuardError):
            client.action('stop', idempotency_key=IDEMPOTENCY)
        self.assertEqual(len(transport.requests), 1)
        for key in ['invalid\0key', 'invalid\nkey', 'invalid\x7fkey']:
            with self.assertRaises(GuardError):
                BotkeepClient(environ={'BOTKEEP_API_KEY': key}, opener=Transport())

    def test_redirects_are_not_followed_or_given_credentials(self):
        redirect = HTTPError('https://api.botkeep.cloud' + BASE, 302, 'redirect',
                             {'Location': 'https://attacker.invalid/'}, io.BytesIO(b'private'))
        client, transport, _ = self.client(redirect)
        with self.assertRaises(RedirectRefused) as caught:
            client.inspect()
        self.assertEqual(len(transport.requests), 1)
        self.assertNotIn('attacker', str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 302, '', {}, 'https://attacker.invalid'))

    def test_read_timeouts_retry_but_write_timeouts_never_replay(self):
        client, transport, clock = self.client(URLError('private detail'), TimeoutError(), Response(value={'ok': True}))
        self.assertEqual(client.inspect().json(), {'ok': True})
        self.assertEqual(len(transport.requests), 3)
        self.assertEqual(clock.sleeps, [1, 2])
        for error in [TimeoutError(SECRET), URLError(SECRET), IncompleteRead(b'private', 10)]:
            client, transport, _ = self.client(error, Response())
            with self.subTest(error=type(error).__name__), self.assertRaises(UncertainWriteError) as caught:
                client.action('restart', idempotency_key=IDEMPOTENCY)
            self.assertEqual(caught.exception.idempotency_key, IDEMPOTENCY)
            self.assertEqual(len(transport.requests), 1)
            self.assertNotIn(SECRET, str(caught.exception))

    def test_retry_after_is_bounded_and_write_server_errors_are_uncertain(self):
        client, transport, clock = self.client(Response(429, headers={'Retry-After': '99999'}), Response())
        client.inspect()
        self.assertEqual(clock.sleeps, [30])
        client, transport, _ = self.client(Response(503, {'error': SECRET}), Response())
        with self.assertRaises(UncertainWriteError) as caught:
            client.upload_batch({'server.mjs': b'new'}, idempotency_key=IDEMPOTENCY)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(transport.requests), 1)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_upload_schema_batch_quota_binary_round_trip_and_overwrite(self):
        client, transport, _ = self.client(Response())
        files = {'a.bin': b'\x00\xff', 'public/b.webp': b'webp', 'server.mjs': b'code', 'empty': b''}
        client.upload_batch(files, overwrite=True, idempotency_key=IDEMPOTENCY)
        request, _ = transport.requests[0]
        self.assertEqual(request.get_header('Idempotency-key'), IDEMPOTENCY)
        payload = json.loads(request.data)
        self.assertEqual(len(payload['files']), 4)
        for item in payload['files']:
            self.assertEqual(set(item), {'path', 'data', 'overwrite'})
            self.assertEqual(base64.b64decode(item['data']), files[item['path']])
            self.assertTrue(item['overwrite'])
        for files in [{}, {str(n): b'x' for n in range(5)}, {'big': b'x' * (MAX_UPLOAD_BASE64 * 3 // 4 + 1)}]:
            with self.assertRaises(GuardError):
                client.upload_batch(files, idempotency_key=IDEMPOTENCY)
        self.assertEqual(len(transport.requests), 1)
        with self.assertRaises(GuardError):
            client.upload_batch({'x': b'x'}, idempotency_key='short')
        self.assertEqual(len(transport.requests), 1)

    def test_async_acceptance_polls_until_actual_success_and_honors_retry_after(self):
        operation = {'id': 'operation-1', 'workload_id': WORKLOAD_ID, 'status': 'queued'}
        client, transport, clock = self.client(Response(202, {'operation': operation}),
                                               Response(value={'operation': {**operation, 'status': 'running'}}, headers={'Retry-After': '999'}),
                                               Response(value={'operation': {**operation, 'status': 'succeeded'}}))
        response = client.action('stop', idempotency_key=IDEMPOTENCY)
        self.assertEqual(response.json()['operation']['status'], 'succeeded')
        self.assertEqual(clock.sleeps, [10])
        self.assertEqual([request.method for request, _ in transport.requests], ['POST', 'GET', 'GET'])
        self.assertTrue(all(request.full_url.startswith('https://api.botkeep.cloud/') for request, _ in transport.requests))
        with self.assertRaises(GuardError):
            client._request('GET', 'operation-1')
        with self.assertRaises(GuardError):
            client.wait_operation('unregistered-operation')

    def test_missing_operation_failure_unknown_state_and_foreign_workload_fail_closed(self):
        client, _, _ = self.client(Response(202, {'ok': True}))
        with self.assertRaises(UncertainWriteError):
            client.action('start', idempotency_key=IDEMPOTENCY)
        for state in ['failed', 'unexpected-state', 'completed']:
            operation = {'id': 'op', 'status': state}
            if state == 'completed':
                operation['result'] = {'success': False}
            client, _, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value=operation))
            with self.subTest(state=state), self.assertRaises(OperationError):
                client.action('start', idempotency_key=IDEMPOTENCY)
        client, transport, _ = self.client(Response(202, {'operation': {'id': 'op', 'workloadId': 'other'}}))
        with self.assertRaises(UncertainWriteError):
            client.action('start', idempotency_key=IDEMPOTENCY)
        self.assertEqual(len(transport.requests), 1)

    def test_operation_timeout_keeps_original_write_identity_and_no_new_post(self):
        queued = {'operation': {'id': 'op', 'status': 'queued'}}
        client, transport, _ = self.client(Response(202, queued), Response(value=queued), Response(value=queued), Response(value=queued))
        with self.assertRaises(UncertainWriteError) as caught:
            client.action('restart', idempotency_key=IDEMPOTENCY, wait_timeout=3)
        self.assertEqual(caught.exception.operation_id, 'op')
        self.assertEqual(caught.exception.idempotency_key, IDEMPOTENCY)
        self.assertEqual(sum(request.method == 'POST' for request, _ in transport.requests), 1)

    def test_actual_compound_power_contract_for_stop_start_and_restart(self):
        for action in ['stop', 'start', 'restart']:
            completed = power_operation(action)
            client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}),
                                               Response(value=completed))
            with self.subTest(action=action):
                self.assertEqual(client.action(action, idempotency_key=IDEMPOTENCY).json(), completed)
                self.assertEqual([request.method for request, _ in transport.requests], ['POST', 'GET'])

    def test_compound_dispatch_or_legacy_success_cannot_bypass_confirmation(self):
        for changes in [{'queueState': 'dispatched'}, {'phase': 'dispatch'},
                        {'queueState': 'running', 'phase': 'running', 'status': 'succeeded'}]:
            pending = power_operation()
            for key, value in changes.items():
                (pending['operation'] if key in ('phase', 'status') else pending)[key] = value
            client, transport, clock = self.client(Response(202, {'operation': {'id': 'op'}}),
                                                    Response(value=pending), Response(value=power_operation()))
            with self.subTest(changes=changes):
                self.assertTrue(client.action('stop', idempotency_key=IDEMPOTENCY).json()['confirmed'])
                self.assertEqual(len(transport.requests), 3)
                self.assertEqual(clock.sleeps, [1])
        for phase in ['dispatch', 'complete']:
            client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}),
                                               Response(value={'operation': {'id': 'op', 'phase': phase, 'status': 'succeeded'}}))
            with self.subTest(incomplete_phase=phase), self.assertRaises(OperationError):
                client.action('stop', idempotency_key=IDEMPOTENCY)
            self.assertEqual(len(transport.requests), 2)

    def test_compound_confirmation_requires_boolean_true_and_no_write_replay(self):
        for confirmed in [False, 0, 'true', None]:
            pending = {**power_operation(), 'confirmed': confirmed}
            client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}),
                                               Response(value=pending), Response(value=power_operation()))
            with self.subTest(confirmed=confirmed):
                client.action('stop', idempotency_key=IDEMPOTENCY)
                self.assertEqual(len(transport.requests), 3)
        pending = {**power_operation(), 'confirmed': False}
        client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}),
                                           *[Response(value=pending) for _ in range(3)])
        with self.assertRaises(UncertainWriteError) as caught:
            client.action('stop', idempotency_key=IDEMPOTENCY, wait_timeout=3)
        self.assertEqual(caught.exception.operation_id, 'op')
        self.assertEqual(caught.exception.idempotency_key, IDEMPOTENCY)
        self.assertEqual(sum(request.method == 'POST' for request, _ in transport.requests), 1)

    def test_compound_runtime_must_match_the_requested_action(self):
        for action, runtime in [('stop', 'running'), ('start', 'stopped'), ('restart', 'stopped')]:
            completed = {**power_operation(action), 'runtimeState': runtime}
            client, _, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value=completed))
            with self.subTest(action=action), self.assertRaises(OperationError):
                client.action(action, idempotency_key=IDEMPOTENCY)

    def test_compound_nested_confirmation_or_runtime_cannot_contradict_outer(self):
        for field, value in [('confirmed', False), ('runtimeState', 'running')]:
            completed = power_operation()
            completed['operation'][field] = value
            client, _, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value=completed))
            with self.subTest(field=field), self.assertRaises(OperationError):
                client.action('stop', idempotency_key=IDEMPOTENCY)

    def test_operation_identity_is_checked_in_both_response_layers(self):
        for layer in ['outer', 'nested']:
            for field, value in [('id', 'other'), ('workloadId', 'other'),
                                 ('workload_id', 'other'), ('serviceId', 'other'),
                                 ('workload', {'id': 'other'}), ('action', 'start')]:
                completed = power_operation()
                (completed if layer == 'outer' else completed['operation'])[field] = value
                client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value=completed))
                with self.subTest(layer=layer, field=field), self.assertRaises((OperationError, GuardError)):
                    client.action('stop', idempotency_key=IDEMPOTENCY)
                self.assertEqual(len(transport.requests), 2)
        for value in [None, [], 'invalid']:
            client, _, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value={'operation': value}))
            with self.subTest(operation=value), self.assertRaises(OperationError):
                client.action('stop', idempotency_key=IDEMPOTENCY)

    def test_accepted_operation_cannot_hide_foreign_outer_identity(self):
        for field, value in [('id', 'other'), ('workloadId', 'other'), ('action', 'start')]:
            accepted = {'operation': {'id': 'op'}, field: value}
            client, transport, _ = self.client(Response(202, accepted))
            with self.subTest(field=field), self.assertRaises(UncertainWriteError):
                client.action('stop', idempotency_key=IDEMPOTENCY)
            self.assertEqual(len(transport.requests), 1)

    def test_failure_in_either_operation_layer_overrides_compound_success(self):
        for layer in ['outer', 'nested']:
            for field, value in [('status', 'failed'), ('state', 'cancelled'),
                                 ('queueState', 'rejected'), ('phase', 'timed_out'),
                                 ('runtimeState', 'error'), ('success', False),
                                 ('result', {'success': False}), ('error', 'private failure')]:
                completed = power_operation()
                (completed if layer == 'outer' else completed['operation'])[field] = value
                client, _, _ = self.client(Response(202, {'operation': {'id': 'op'}}), Response(value=completed))
                with self.subTest(layer=layer, field=field), self.assertRaises(OperationError):
                    client.action('stop', idempotency_key=IDEMPOTENCY)

    def test_legacy_unwrapped_status_contract_still_polls_to_completion(self):
        client, transport, _ = self.client(Response(202, {'operation': {'id': 'op'}}),
                                           Response(value={'id': 'op', 'status': 'running'}),
                                           Response(value={'id': 'op', 'status': 'completed'}))
        self.assertEqual(client.action('stop', idempotency_key=IDEMPOTENCY).json()['status'], 'completed')
        self.assertEqual([request.method for request, _ in transport.requests], ['POST', 'GET', 'GET'])

    def test_read_methods_and_backup_schema(self):
        client, transport, _ = self.client(*[Response() for _ in range(7)])
        client.list_files('/public'); client.read_file('/server.mjs'); client.download_file('/server.mjs')
        client.logs(200); client.backups(); client.github(); client.startup_check()
        self.assertTrue(all(request.method == 'GET' for request, _ in transport.requests))
        with self.assertRaises(GuardError): client.logs(201)
        with self.assertRaises(GuardError): client.logs(True)
        client, transport, _ = self.client(Response())
        client.create_backup('before-update', request_id='f70cbe2f-e89d-4b38-844b-af732c17b159', idempotency_key=IDEMPOTENCY)
        body = json.loads(transport.requests[0][0].data)
        self.assertEqual(set(body), {'name', 'requestId'})
        with self.assertRaises(GuardError):
            client.create_backup('x', idempotency_key=IDEMPOTENCY)
        with self.assertRaises(GuardError):
            client.create_backup('valid', request_id='not-a-uuid', idempotency_key=IDEMPOTENCY)

    def test_private_response_files_are_exclusive_0600_outside_repo_and_never_store_key(self):
        client, _, _ = self.client()
        response = APIResponse(200, {}, b'private state')
        with tempfile.TemporaryDirectory(prefix='botkeep-private-test-') as directory:
            target = Path(directory) / 'backup.json'
            result = client.save_private_response(response, target)
            self.assertEqual(target.read_bytes(), response.body)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(result['bytes'], len(response.body))
            with self.assertRaises(FileExistsError):
                client.save_private_response(response, target)
            with self.assertRaises(GuardError):
                client.save_private_response(APIResponse(200, {}, SECRET.encode()), Path(directory) / 'key.json')
        with self.assertRaises(GuardError):
            client.save_private_response(response, REPOSITORY / 'private-response.json')
        self.assertEqual(metadata({'content': SECRET, 'environment': {'TOKEN': SECRET}, 'workload': {'id': WORKLOAD_ID, 'status': 'running', 'password': SECRET}}), {'workload': {'id': WORKLOAD_ID, 'status': 'running'}})


if __name__ == '__main__':
    unittest.main()
