import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, merge, resolveProfile, sidecarArgs, DEFAULTS } from '../src/config.js';
import { startEventServer } from '../src/ui/events.js';
import { voicePreamble } from '../src/core/voice-preamble.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

test('profiles: deep merge, extends, CLI wins', () => {
  const file = {
    agent: { model: 'claude-sonnet' },
    talker: { url: 'http://127.0.0.1:8080/v1', model: 'q' },
    profiles: {
      fast: { description: 'quick', agent: { model: 'claude-haiku', effortLevel: 'low' }, speech: { ttsEn: 'kokoro' } },
      server: { extends: 'fast', remote: { host: 'me@box', cwd: '/srv/app' }, conversation: { busyPolicy: 'queue' } },
      coach: { conversation: { verbosity: 'deep', persona: 'You are a patient coding teacher.' }, speech: { voiceDesc: 'calm warm alto' } },
    },
    defaultProfile: 'fast',
  };
  const a = buildConfig(file, {});
  assert.equal(a.profileName, 'fast');
  assert.equal(a.agent.model, 'claude-haiku');
  assert.equal(a.agent.command, 'kiro-cli');                    // untouched defaults survive
  assert.equal(a.talker.url, 'http://127.0.0.1:8080/v1');      // file values survive

  const b = buildConfig(file, { profile: 'server', model: 'claude-opus' });
  assert.equal(b.remote.host, 'me@box');
  assert.equal(b.cwd, '/srv/app');
  assert.equal(b.agent.effortLevel, 'low');                     // inherited via extends
  assert.equal(b.agent.model, 'claude-opus');                   // CLI wins
  assert.equal(b.conversation.busyPolicy, 'queue');
  assert.equal(b.conversation.bargeIn, true);                   // deep merge kept sibling

  const c = buildConfig(file, { profile: 'coach' });
  assert.deepEqual(sidecarArgs(c.speech).slice(0, 2), ['--voice-desc', 'calm warm alto']);
  assert.match(voicePreamble({ persona: c.conversation.persona }), /Profile persona[\s\S]*patient coding teacher/);
  assert.throws(() => resolveProfile(file.profiles, 'nope'), /unknown profile/);
  assert.throws(() => resolveProfile({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a'), /cycle/);
  assert.equal(merge(DEFAULTS, { remote: null }).remote, null);
});

test('web server: stage, shaders, SSE + /state snapshot, commands', async () => {
  const got = [];
  const srv = startEventServer({ port: 0, onCommand: (c) => got.push(c) });
  servers.push(srv);
  const { ok, url } = await srv.ready;
  assert.ok(ok);
  const html = await (await fetch(url + '/')).text();
  assert.match(html, /<main id="stage"/);
  const sh = await fetch(url + '/vendor/shaders/index.js');
  assert.equal(sh.status, 200);
  assert.match(await sh.text(), /meshGradientFragmentShader/);
  assert.equal((await fetch(url + '/../package.json')).status, 404);

  // live events
  const ctrl = new AbortController();
  const res = await fetch(url + '/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await new Promise((r) => setTimeout(r, 30));
  srv.publish('subtitle', { text: 'Hei!', durationMs: 500 });
  srv.publish('level', { mic: 0.2, out: 0 });
  let buf = '';
  while (!buf.includes('"level"')) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(buf, /"type":"subtitle","t":\d+,"text":"Hei!"/);

  // sticky state for late joiners; high-rate levels are not kept
  const snap = await (await fetch(url + '/state')).json();
  assert.equal(snap.subtitle.text, 'Hei!');
  assert.equal(snap.level, undefined);

  const r = await fetch(url + '/command', { method: 'POST', body: JSON.stringify({ type: 'ptt', active: true }) });
  assert.equal(r.status, 204);
  assert.deepEqual(got, [{ type: 'ptt', active: true }]);
});

test('face springs stay stable at any frame rate (no exploding mouth)', async () => {
  const { Spring } = await import('../web/face.js');
  for (const dt of [1 / 120, 1 / 60, 1 / 15, 0.05, 0.2]) {
    const s = new Spring(0, 28);
    for (let i = 0; i < 400; i++) { s.target = i % 7 < 3 ? 1 : 0; s.step(dt); if (i % 50 === 0) s.kick(-5); }
    assert.ok(Number.isFinite(s.v) && Math.abs(s.v) < 3, `dt=${dt} -> ${s.v}`);
  }
});
