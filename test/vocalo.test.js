import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeechChunker, cleanForSpeech } from '../src/core/chunker.js';
import { SceneParser, parseTag } from '../src/core/scene.js';
import { guessLang } from '../src/core/lang.js';
import { AcpClient } from '../src/acp/client.js';
import { SilentSpeech } from '../src/speech/sidecar.js';
import { Orchestrator } from '../src/core/orchestrator.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('chunker releases first clause early, then sentences', () => {
  const out = [];
  const c = new SpeechChunker({ onSpeak: (s) => out.push(s) });
  for (const tok of 'Sure thing, here is how it works. Plants use light. They also need water and air'.split(/(?<= )/)) c.push(tok);
  assert.equal(out[0], 'Sure thing, here is how it works.');
  c.flush();
  assert.equal(out.at(-1), 'Plants use light. They also need water and air'); // short sentences are merged
  assert.equal(out.join(' ').replace(/\s+/g, ' '), 'Sure thing, here is how it works. Plants use light. They also need water and air');
});

test('chunker keeps code out of speech even when fences are split', () => {
  const said = [], code = [];
  const c = new SpeechChunker({ onSpeak: (s) => said.push(s), onCode: (s) => code.push(s) });
  for (const tok of ['Here you go. `', '``js\nconst a', ' = 1;\n`', '``', ' That is it.']) c.push(tok);
  c.flush();
  assert.deepEqual(code, ['const a = 1;\n']);
  assert.ok(said.every((s) => !s.includes('const')));
  assert.ok(said.join(' ').includes('That is it.'));
});

test('first chunk can be a clause, before the sentence ends', () => {
  const out = [];
  const c = new SpeechChunker({ onSpeak: (s) => out.push(s) });
  for (const tok of 'Okay so the short answer is yes, but there is a catch'.split(/(?<= )/)) c.push(tok);
  assert.equal(out[0], 'Okay so the short answer is yes,');
});

test('cleanForSpeech strips markdown', () => {
  assert.equal(cleanForSpeech('## Title\n- **bold** item with `code` and [link](http://x)'), 'Title bold item with code and link');
});

test('scene parser handles tags split across chunks', () => {
  const text = [], scenes = [];
  const p = new SceneParser({ onText: (t) => text.push(t), onScene: (s) => scenes.push(s) });
  for (const ch of ['Hi [', '[scene bg="#112233" ti', 'tle="Hello world"]] there [[clear]].']) p.push(ch);
  p.flush();
  assert.equal(text.join(''), 'Hi  there .');
  assert.deepEqual(scenes, [{ kind: 'scene', bg: '#112233', title: 'Hello world' }, { kind: 'clear' }]);
  assert.deepEqual(parseTag('show image=/tmp/a.png caption=\'x y\''), { kind: 'show', image: '/tmp/a.png', caption: 'x y' });
});

test('language guess', () => {
  assert.equal(guessLang('Mitä kuuluu, voitko auttaa tässä?'), 'fi');
  assert.equal(guessLang('Can you help me with this function?'), 'en');
});

function harness(extra = {}) {
  const acp = new AcpClient({ command: process.execPath, args: [resolve(HERE, 'mock-agent.js')] }).start();
  const speech = new SilentSpeech({ wpm: 6000 });
  const orch = new Orchestrator({ acp, speech, config: { permissions: 'ask', ...extra } });
  return { acp, speech, orch };
}

test('end-to-end with mock ACP agent: stream -> subtitles, scene, code, metrics', async () => {
  const { acp, orch } = harness();
  await acp.initialize();
  await acp.newSession({ cwd: process.cwd() });
  const subs = [], scenes = [], codes = [], states = [];
  let metrics;
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  orch.on('scene', (s) => scenes.push(s));
  orch.on('code', (c) => codes.push(c));
  orch.on('metrics', (m) => (metrics = m));
  orch.on('state', (s) => states.push(s));
  const idle = new Promise((r) => orch.on('state', (s) => s === 'idle' && r()));
  orch.userSaid('Explain photosynthesis', { endOfSpeechAt: Date.now() });
  await idle;
  acp.stop();
  assert.equal(scenes[0].title, 'Photosynthesis');
  assert.ok(codes[0].includes('print("leaf")'));
  assert.ok(subs.length >= 3, `subs: ${JSON.stringify(subs)}`);
  assert.ok(subs.every((s) => !s.includes('[[') && !s.includes('print')));
  assert.ok(metrics.voiceToVoiceMs >= 0);
  assert.deepEqual([...new Set(states)], ['thinking', 'speaking', 'idle']);
});

test('barge-in cancels the turn and the next utterance starts a fresh one', async () => {
  process.env.MOCK_DELAY = '40';
  const { acp, orch } = harness();
  await acp.initialize();
  await acp.newSession({});
  const ends = [];
  orch.on('interrupted', (r) => ends.push(r));
  orch.userSaid('Explain photosynthesis');
  await new Promise((r) => setTimeout(r, 120));
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  const idle = new Promise((r) => orch.on('state', (s) => s === 'idle' && r()));
  await orch.userSaid('Moi, mitä fotosynteesi on?');
  await idle;
  acp.stop();
  assert.deepEqual(ends, ['new-utterance']);
  assert.ok(subs.some((s) => /Kasvit/.test(s)), JSON.stringify(subs));
  assert.ok(!subs.some((s) => /Plants/.test(s)), 'old turn leaked');
  delete process.env.MOCK_DELAY;
});

test('voice answer resolves a permission request', async () => {
  const { acp, orch } = harness();
  await acp.initialize();
  await acp.newSession({});
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  orch.on('permission', () => setTimeout(() => orch.userSaid('yes go ahead'), 10));
  const idle = new Promise((r) => orch.on('state', (s) => s === 'idle' && r()));
  orch.userSaid('please delete the build folder');
  await idle;
  acp.stop();
  assert.ok(subs.some((s) => /May I delete build folder/.test(s)), JSON.stringify(subs));
  assert.ok(subs.some((s) => /deleted it/.test(s)), JSON.stringify(subs));
});

test('chunker does not cut after abbreviations or list numbers', () => {
  const out = [];
  const c = new SpeechChunker({ onSpeak: (s) => out.push(s), firstMin: 5 });
  for (const tok of 'Esim. tämä toimii hyvin ja nopeasti. Then e.g. this part works too. Done'.split(/(?<= )/)) c.push(tok);
  c.flush();
  assert.deepEqual(out, ['Esim. tämä toimii hyvin ja nopeasti.', 'Then e.g. this part works too.', 'Done']);
});

test('slow agent -> one cached filler, not counted as answer audio', async () => {
  process.env.MOCK_FIRST_DELAY = '300';
  const { acp, speech, orch } = harness({ fillerAfterMs: 100 });
  speech.emit('ready', { cached: ['en.hmm', 'en.check', 'fi.hmm', 'fi.check'] });
  await acp.initialize(); await acp.newSession({});
  const fillers = [], subs = [];
  let metrics;
  orch.on('filler', (k) => fillers.push(k));
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  orch.on('metrics', (m) => (metrics = m));
  const idle = new Promise((r) => orch.on('state', (s) => s === 'idle' && r()));
  orch.userSaid('Explain photosynthesis', { endOfSpeechAt: Date.now() });
  await idle;
  acp.stop();
  delete process.env.MOCK_FIRST_DELAY;
  assert.deepEqual(fillers, ['en.hmm']);
  assert.equal(subs[0], 'Hmm, let me think.');
  assert.ok(metrics.fillerMs < metrics.voiceToVoiceMs, JSON.stringify(metrics));
});

test('a continued thought before any audio is merged into one prompt', async () => {
  process.env.MOCK_FIRST_DELAY = '200';
  process.env.MOCK_ECHO = '1';
  const { acp, orch } = harness({ preamble: false });
  await acp.initialize(); await acp.newSession({});
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  orch.userSaid('Tell me about');
  await new Promise((r) => setTimeout(r, 50));
  const idle = new Promise((r) => orch.on('state', (s) => s === 'idle' && r()));
  await orch.userSaid('black holes');
  await idle;
  acp.stop();
  delete process.env.MOCK_FIRST_DELAY; delete process.env.MOCK_ECHO;
  assert.deepEqual(subs, ['You said: Tell me about black holes.']);
});
