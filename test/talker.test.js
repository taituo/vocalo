import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/acp/client.js';
import { SilentSpeech } from '../src/speech/sidecar.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Controller } from '../src/core/controller.js';
import { Talker, templateNarration } from '../src/core/talker.js';
import { voicePreamble, turnNotes } from '../src/core/voice-preamble.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, 'mock-agent.js');
const until = (em, ev, pred = () => true) => new Promise((r) => { const f = (...a) => { if (pred(...a)) { em.off(ev, f); r(a[0]); } }; em.on(ev, f); });
const cleanup = [];
after(() => cleanup.forEach((f) => f()));

/** Fake OpenAI-compatible server. reply(body) -> text; delayMs simulates a slow model. */
function fakeLLM({ reply, delayMs = 20 }) {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b); seen.push(body);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply(body) } }] }));
      }, delayMs);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { cleanup.push(() => srv.close()); r({ url: `http://127.0.0.1:${srv.address().port}/v1`, seen }); }));
}

async function rig({ talker, conv = {} } = {}) {
  const acp = new AcpClient({ command: process.execPath, args: [MOCK] }).start();
  cleanup.push(() => acp.stop());
  const speech = new SilentSpeech({ wpm: 6000 });
  const orch = new Orchestrator({ acp, speech, talker, config: { preamble: false, ...conv } });
  const ctl = new Controller({ acp, orch, transport: acp.transport });
  await acp.initialize(); await acp.newSession({});
  return { acp, speech, orch, ctl };
}

test('persona: talker-aware opening rule, verbosity, honesty', () => {
  const a = voicePreamble({ talker: true, verbosity: 'short' });
  assert.match(a, /ALREADY acknowledged/);
  assert.match(a, /one to three/);
  assert.match(a, /not sycophantic/);
  assert.match(voicePreamble({ talker: false }), /React to what they just said/);
  assert.match(voicePreamble({ verbosity: 'deep' }), /wants depth/);
  assert.equal(turnNotes({}), '');
  assert.match(turnNotes({ interrupted: { heard: 'Plants turn light' } }), /heard only: "Plants turn light"/);
});

test('talker ack plays before the thinker answers, and replaces the canned filler', async () => {
  process.env.MOCK_FIRST_DELAY = '400';
  const llm = await fakeLLM({ reply: () => 'Ah, photosynthesis, sure.' });
  const talker = new Talker({ url: llm.url, model: 'tiny' });
  const { orch, speech } = await rig({ talker, conv: { fillerAfterMs: 1000 } });
  speech.emit('ready', { cached: ['en.hmm'] });
  const subs = [], fillers = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  orch.on('filler', (f) => fillers.push(f));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('explain how photosynthesis works');
  await idle;
  delete process.env.MOCK_FIRST_DELAY;
  assert.equal(subs[0], 'Ah, photosynthesis, sure.');
  assert.ok(subs.length > 2);
  assert.deepEqual(fillers, []);
  assert.match(llm.seen[0].messages[1].content, /photosynthesis/);
});

test('slow talker is skipped (thinker never waits for it)', async () => {
  const llm = await fakeLLM({ reply: () => 'Too late.', delayMs: 2000 });
  const talker = new Talker({ url: llm.url, model: 'tiny', ackDeadlineMs: 150 });
  const { orch } = await rig({ talker });
  const subs = [];
  orch.on('assistant_subtitle', (s) => subs.push(s.text));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('explain photosynthesis');
  await idle;
  assert.ok(!subs.includes('Too late.'));
  assert.equal(talker.stats.late, 1);
});

test('talker output that answers or asks is rejected', async () => {
  const llm = await fakeLLM({ reply: () => 'Do you mean the light reaction or the Calvin cycle?' });
  const t = new Talker({ url: llm.url, model: 'tiny' });
  assert.equal(await t.ack('explain photosynthesis'), null);
});

test('long silent tool work gets spoken progress narration', async () => {
  process.env.MOCK_WORK_STEPS = '12'; // ~480 ms of silent "reading"
  const { orch } = await rig({ conv: { narrateEveryMs: 200, fillerAfterMs: 100000 } });
  const lines = [];
  orch.on('narration', (l) => lines.push(l));
  const idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('refactor the loop');
  await idle;
  delete process.env.MOCK_WORK_STEPS;
  assert.ok(lines.length >= 1, 'no narration');
  assert.match(lines[0], /Working on: (Read the module|Reading src\/loop\.js)/);
  assert.equal(templateNarration({ lang: 'fi', tools: ['Running npm test'] }), 'Työn alla: Running npm test.');
});

test('after a barge-in the agent is told exactly what was heard', async () => {
  process.env.MOCK_ECHO = '1';
  const { acp, orch, speech } = await rig();
  const prompts = [];
  const origPrompt = acp.prompt.bind(acp);
  acp.prompt = (t, x) => { prompts.push(t); return origPrompt(t, x); };
  orch.userSaid('first question');
  await until(orch, 'assistant_subtitle');
  speech.emit('barge_in', {});
  await new Promise((r) => setTimeout(r, 30));
  const idle = until(orch, 'state', (s) => s === 'idle');
  await orch.userSaid('second question');
  await idle;
  delete process.env.MOCK_ECHO;
  assert.match(prompts[1], /\[Vocalo note: The user interrupted your previous answer\. They heard only: "You said: first question\."/);
  assert.match(prompts[1], /second question$/);
});

test('verbosity by voice: confirms and tells the agent once', async () => {
  process.env.MOCK_ECHO = '1';
  const { acp, orch } = await rig();
  const prompts = [];
  const orig = acp.prompt.bind(acp);
  acp.prompt = (t, x) => { prompts.push(t); return orig(t, x); };
  const ann = until(orch, 'announce');
  await orch.userSaid('Vocalo, kerro tarkemmin');
  assert.equal(await ann, 'Okei, tarkemmin.');
  assert.equal(orch.config.verbosity, 'deep');
  let idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('miten fotosynteesi toimii');
  await idle;
  idle = until(orch, 'state', (s) => s === 'idle');
  orch.userSaid('entä yöllä');
  await idle;
  delete process.env.MOCK_ECHO;
  assert.match(prompts[0], /user wants more detail/);
  assert.doesNotMatch(prompts[1], /Vocalo note/);
});
