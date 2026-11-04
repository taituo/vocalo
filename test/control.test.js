import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AcpClient } from '../src/acp/client.js';
import { Transport, parseRemoteSpec, shq } from '../src/acp/transport.js';
import { SilentSpeech } from '../src/speech/sidecar.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Controller, voiceToCommand } from '../src/core/controller.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, 'mock-agent.js');
const until = (em, ev, pred = () => true) => new Promise((r) => { const f = (...a) => { if (pred(...a)) { em.off(ev, f); r(a[0]); } }; em.on(ev, f); });

const agents = [];
after(() => agents.forEach((a) => a.stop()));
async function rig({ transport, conv = {}, control = {} } = {}) {
  const acp = new AcpClient(transport ? { transport } : { command: process.execPath, args: [MOCK] }).start();
  agents.push(acp);
  const speech = new SilentSpeech({ wpm: 6000 });
  const orch = new Orchestrator({ acp, speech, config: { preamble: false, ...conv } });
  const ctl = new Controller({ acp, orch, transport: acp.transport, config: control });
  await acp.initialize();
  await acp.newSession({ cwd: process.cwd() });
  return { acp, speech, orch, ctl };
}

test('voice phrases map to commands (EN + FI)', () => {
  const cases = {
    'switch to model haiku': 'model haiku', 'vaihda malliin haiku': 'model haiku', 'käytä mallia sonnet': 'model sonnet',
    'new session': 'new', 'uusi sessio': 'new', 'jatka edellistä sessiota': 'resume last', 'resume the last session': 'resume last',
    'tiivistä': 'compact', 'compact the context': 'compact', 'switch to spec mode': 'mode spec', 'vaihda tilaan spec': 'mode spec',
    'effort low': 'effort low', 'ajattele vähemmän': 'effort low', 'näytä suunnitelma': 'plan', 'show the diff': 'diff',
    'peru': 'cancel', 'show sessions': 'sessions', 'open session 2': 'resume 2', 'show file src/app.js': 'show src/app.js',
  };
  for (const [say, cmd] of Object.entries(cases)) assert.equal(voiceToCommand(say), cmd, say);
  assert.equal(voiceToCommand('explain how photosynthesis works'), null);
});

test('config options: model + effort + mode via commands and voice', async () => {
  const { acp, orch, ctl } = await rig();
  assert.equal(acp.current('model'), 'claude-sonnet');
  await ctl.run(':model haiku');
  assert.equal(acp.current('model'), 'claude-haiku');
  await ctl.run('effort low');
  assert.equal(acp.current('effortLevel'), 'low');
  const ann = until(orch, 'announce');
  await orch.userSaid('Vocalo, vaihda tilaan spec');
  assert.equal(acp.current('mode'), 'spec');
  assert.match(await ann, /Tila: Spec/);
  acp.stop();
});

test('sessions: list, resume by number, new keeps model', async () => {
  const { acp, ctl } = await rig();
  const overlay = until(ctl, 'overlay');
  await ctl.run('sessions');
  const { lines } = await overlay;
  assert.ok(lines.some((l) => l.includes('Earlier refactor')));
  const n = lines.findIndex((l) => l.includes('Earlier refactor')) + 1;
  await ctl.run(`resume ${n}`);
  assert.equal(acp.sessionId, 'sess_old');
  await ctl.run('model haiku');
  await ctl.run('new');
  assert.notEqual(acp.sessionId, 'sess_old');
  assert.equal(acp.current('model'), 'claude-haiku');
  acp.stop();
});

test('talking during tool work steers the running turn instead of killing it', async () => {
  const { acp, orch } = await rig();
  const plans = [], diffs = [], subs = [];
  orch.on('plan', (p) => plans.push(p));
  orch.on('diff', (d) => diffs.push(d));
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  let interrupted = false;
  orch.on('interrupted', () => (interrupted = true));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('refactor the loop');
  await until(orch, 'tool');
  const steered = until(orch, 'steered');
  await orch.userSaid('also add a docstring');
  assert.equal(await steered, 'also add a docstring');
  await idle;
  acp.stop();
  assert.equal(interrupted, false);
  assert.ok(subs.some((s) => s.includes('also add a docstring')), JSON.stringify(subs));
  assert.equal(plans.at(-1).every((e) => e.status === 'completed'), true);
  assert.equal(diffs[0].path, '/repo/src/loop.js');
});

test('barge-in noise during work does not cancel; "stop" does', async () => {
  const { acp, orch, speech } = await rig();
  orch.userSaid('refactor the loop');
  await until(orch, 'tool');
  speech.emit('barge_in', {});
  await orch.userSaid('', {});            // cough -> empty transcript
  assert.ok(orch.turn && !orch.turn.cancelled);
  const ann = until(orch, 'announce');
  await orch.userSaid('stop');
  assert.equal(await ann, 'Stopped.');
  assert.equal(orch.turn, null);
  acp.stop();
});

test('"always" permission echoes Kiro consent scope', async () => {
  const { acp, orch } = await rig();
  orch.on('permission', () => setTimeout(() => orch.userSaid('yes, always'), 5));
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('delete the build folder');
  await idle;
  acp.stop();
  assert.ok(subs.some((s) => /deleted it and will remember/.test(s)), JSON.stringify(subs));
});

test('auto-compact when context passes the threshold', async () => {
  process.env.MOCK_CTX_STEP = '50';
  const { acp, orch } = await rig({ control: { autoCompactAt: 85 } });
  const ann = until(orch, 'announce');
  orch.userSaid('Explain photosynthesis');
  assert.equal(await ann, 'Compacting the context.');
  await until(acp, 'session_state', (k) => k.contextPct === 10);
  acp.stop();
  delete process.env.MOCK_CTX_STEP;
});

test('transport: ssh argv quoting and remote spec parsing', () => {
  assert.deepEqual(parseRemoteSpec('me@box:/srv/my proj'), { host: 'me@box', cwd: '/srv/my proj' });
  assert.equal(shq("it's"), `'it'\\''s'`);
  const t = new Transport({ command: '~/.local/bin/kiro-cli', args: ['acp', '--agent-engine=v3'], cwd: '/srv/my proj', remote: { host: 'box', port: 2222 } });
  const [cmd, argv] = t.agentArgv();
  assert.equal(cmd, 'ssh');
  assert.ok(argv.includes('-T') && argv.includes('2222') && argv.includes('BatchMode=yes'));
  const remote = argv.at(-1);
  assert.match(remote, /^bash -lc '/);
  assert.ok(remote.includes('my proj') && remote.includes('exec'));
});

test('remote mode end-to-end over (fake) ssh: ACP, file show, exec', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vocalo-remote-'));
  writeFileSync(resolve(dir, 'notes.txt'), 'remote file content\n');
  process.env.PATH = `${resolve(HERE, 'fakebin')}:${process.env.PATH}`;
  const transport = new Transport({ command: process.execPath, args: [MOCK], cwd: dir, remote: { host: 'devbox' } });
  const { acp, orch, ctl } = await rig({ transport });
  assert.equal(acp.agentInfo.name, 'mock-kiro');
  const code = until(ctl, 'code');
  await ctl.run('show notes.txt');
  assert.match(await code, /remote file content/);
  const out = until(ctl, 'code');
  await ctl.run('sh pwd');
  assert.ok((await out).includes(dir));
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('Explain photosynthesis');
  await idle;
  acp.stop();
  assert.ok(subs.length >= 3);
});
