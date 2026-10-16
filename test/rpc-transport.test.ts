import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonlDecoder, RpcTransport, type RpcRecord } from '../src/rpc-transport.js';

const peerSource = String.raw`
let input = '', held;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 input += chunk; let index;
 while ((index = input.indexOf('\n')) >= 0) {
  const command = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
  if (command.type === 'first') held = command;
  else if (command.type === 'second') {
   out({ type: 'message_update', text: '跨块 Unicode\u2028separator\u2029inside JSON' });
   out({ type: 'response', id: command.id, command: command.type, success: true, data: { order: 2 } });
   out({ type: 'response', id: held.id, command: held.type, success: true, data: { order: 1 } });
  } else if (command.type === 'mismatch') out({ type: 'response', id: command.id, command: 'different', success: true });
  else if (command.type === 'reject') out({ type: 'response', id: command.id, command: command.type, success: false, error: 'PRIVATE API KEY / prompt / stderr' });
  else if (command.type === 'exit') { process.stderr.write('PRIVATE STDERR'); process.exit(7); }
  else if (command.type === 'truncated') { process.stdout.write('{"type":"unfinished"'); process.exit(0); }
  else if (command.type === 'hang') {}
  else out({ type: 'response', id: command.id, command: command.type, success: true, data: command });
 }
});
process.stdin.on('end', () => process.exit(0));
`;

function transport(onEvent: (event: RpcRecord) => void = () => {}, onFailure: (error: Error) => void = () => {}) {
  return new RpcTransport({ execPath: process.execPath, args: ['--input-type=module', '-e', peerSource], cwd: process.cwd(), onEvent, onFailure });
}

test('LF decoder handles split UTF-8, CRLF and Unicode separators without treating them as records', () => {
  const records: RpcRecord[] = [];
  const decoder = new JsonlDecoder(value => records.push(value));
  const bytes = Buffer.from('{"type":"event","text":"跨块\u2028a\u2029b"}\r\n{"type":"second"}\n');
  for (let index = 0; index < bytes.length; index++) decoder.push(bytes.subarray(index, index + 1));
  decoder.end();
  assert.deepEqual(records, [{ type: 'event', text: '跨块\u2028a\u2029b' }, { type: 'second' }]);
});

test('framing fails on malformed, nonobject, incomplete, and oversized records without exposing bytes', () => {
  for (const bytes of ['not-json\n', '["private"]\n', 'null\n']) {
    const decoder = new JsonlDecoder(() => {});
    assert.throws(() => decoder.push(Buffer.from(bytes)), error => error instanceof Error && !error.message.includes('private'));
  }
  const truncated = new JsonlDecoder(() => {});
  truncated.push(Buffer.from('{"private":"secret"}'));
  assert.throws(() => truncated.end(), /incomplete/);
  const limited = new JsonlDecoder(() => {}, 4);
  assert.throws(() => limited.push(Buffer.from('{"long":true}\n')), /size/);
});

test('requests correlate by id and command rather than response order and drain continuous events', async () => {
  const events: RpcRecord[] = [];
  const rpc = transport(event => events.push(event));
  try {
    const first = rpc.request('first');
    const second = rpc.request('second');
    assert.deepEqual((await first).data, { order: 1 });
    assert.deepEqual((await second).data, { order: 2 });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.text, '跨块 Unicode\u2028separator\u2029inside JSON');
    const payload = 'x'.repeat(256 * 1024);
    const echoed = await rpc.request('echo', { payload });
    assert.equal((echoed.data as RpcRecord).payload, payload);
  } finally { await rpc.close(); }
});

test('mismatched command fails the transport and rejects every outstanding request', async () => {
  const failure = Promise.withResolvers<Error>();
  const rpc = transport(() => {}, failure.resolve);
  try {
    const waiting = rpc.request('hang');
    const waitingRejected = assert.rejects(waiting, /mismatched/);
    await assert.rejects(rpc.request('mismatch'), /mismatched/);
    await waitingRejected;
    assert.match((await failure.promise).message, /mismatched/);
    await assert.rejects(rpc.request('echo'), /mismatched/);
  } finally { await rpc.close(); }
});

test('command rejection and child exit expose only sanitized bridge-owned errors', async () => {
  const rpc = transport();
  try {
    await assert.rejects(rpc.request('reject'), error => error instanceof Error && /Pi rejected reject/.test(error.message) && !error.message.includes('PRIVATE'));
    await assert.rejects(rpc.request('exit'), error => error instanceof Error && /exited unexpectedly/.test(error.message) && !error.message.includes('PRIVATE'));
  } finally { await rpc.close(); }
});

test('startup failure and truncated exit reject pending requests instead of hanging', async () => {
  const missing = new RpcTransport({ execPath: '/nonexistent/synthetic-pi', args: [], cwd: process.cwd(), onEvent() {}, onFailure() {} });
  try { await assert.rejects(missing.request('get_state'), /Cannot start Pi/); }
  finally { await missing.close(); }
  const rpc = transport();
  try { await assert.rejects(rpc.request('truncated'), /incomplete|unexpectedly/); }
  finally { await rpc.close(); }
});

test('closing rejects pending work and permanently fences new writes', async () => {
  const rpc = transport();
  const pending = assert.rejects(rpc.request('hang'), /closed/);
  await rpc.close(); await pending;
  await assert.rejects(rpc.request('get_state'), /closed/);
  await assert.rejects(rpc.write({ type: 'extension_ui_response', id: 'stale', confirmed: true }), /closed/);
});
