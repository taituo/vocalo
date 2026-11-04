#!/usr/bin/env node
// A small ACP agent that behaves like Kiro CLI V3 for tests and demos:
// streaming text with scene tags + code, tool calls with diffs, plans, permissions,
// config options (model/effortLevel/mode), session list/load, _session/steer,
// _kiro/session/compact and context_usage.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env.MOCK_DELAY ?? 15);
let cancelled = false, nextId = 1000, steers = [], ctxPct = 40;
const waiting = new Map();
const sessions = [{ sessionId: 'sess_old', title: 'Earlier refactor', updatedAt: '2026-11-01T10:00:00Z' }];
const options = () => [
  { configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model,
    options: [{ value: 'claude-sonnet', name: 'Claude Sonnet' }, { value: 'claude-haiku', name: 'Claude Haiku', description: 'fastest' }] },
  { configId: 'effortLevel', name: 'Effort', category: 'thought_level', type: 'select', currentValue: state.effort,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { configId: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: state.mode,
    options: [{ value: 'vibe', name: 'Vibe' }, { value: 'spec', name: 'Spec' }] },
];
const state = { model: 'claude-sonnet', effort: 'high', mode: 'vibe' };
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const say = async (sid, text) => { for (const t of text.split(/(?<= )/)) { if (cancelled) return false; update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }); await sleep(DELAY); } return true; };

async function onPrompt(id, { sessionId, prompt, content }) {
  cancelled = false; steers = [];
  const text = (prompt ?? content).map((p) => p.text).join(' ');
  const user = text.replace(/\[Vocalo voice mode\][\s\S]*\[\/Vocalo voice mode\]\s*/, '');
  const done = (stopReason = cancelled ? 'cancelled' : 'end_turn') => send({ id, result: { stopReason } });
  ctxPct = Math.min(99, ctxPct + Number(process.env.MOCK_CTX_STEP ?? 0));
  update(sessionId, { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'context_usage', usagePercentage: ctxPct } } });

  if (/delete/i.test(user)) {
    const pid = nextId++;
    send({ id: pid, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'delete build folder' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      _meta: { kiro: { consent: { capability: 'fs.delete', resource: './build', persistableConsent: { scope: 'workspace', resource: './build' } } } } } });
    const res = await new Promise((r) => waiting.set(pid, r));
    globalThis.lastPermission = res;
    const ok = ['ok', 'always'].includes(res?.outcome?.optionId);
    await say(sessionId, ok ? `Done, I deleted it${res?._meta?.kiro?.consent ? ' and will remember that' : ''}.` : 'Okay, I left it alone.');
    return done();
  }
  if (/refactor/i.test(user)) { // long agentic task: plan + tools + diff, steerable
    const plan = (s) => update(sessionId, { sessionUpdate: 'plan', entries: [
      { content: 'Read the module', priority: 'high', status: s[0] }, { content: 'Rewrite the loop', priority: 'high', status: s[1] }, { content: 'Run tests', priority: 'medium', status: s[2] }] });
    plan(['in_progress', 'pending', 'pending']);
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Reading src/loop.js', kind: 'read', status: 'in_progress' });
    for (let i = 0; i < Number(process.env.MOCK_WORK_STEPS ?? 10); i++) { if (cancelled) return done(); await sleep(40); }
    plan(['completed', 'in_progress', 'pending']);
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed',
      content: [{ type: 'diff', path: '/repo/src/loop.js', oldText: 'for (var i=0;i<n;i++) {\n  sum += a[i];\n}', newText: 'for (const x of a) {\n  sum += x;\n}' }] });
    plan(['completed', 'completed', 'completed']);
    await say(sessionId, `Refactor done.${steers.length ? ` I also handled: ${steers.join('; ')}.` : ''}`);
    return done();
  }
  const fi = /[äö]|moi|hei|mitä/i.test(user);
  await sleep(Number(process.env.MOCK_FIRST_DELAY ?? 0));
  if (cancelled) return done();
  if (process.env.MOCK_ECHO) { await say(sessionId, `You said: ${user}.`); return done(); }
  const reply = fi
    ? '[[scene bg="#0b3d2e" title="Fotosynteesi"]]Hyvä kysymys, kerron lyhyesti. Kasvit muuttavat valon energiaksi. Ne tarvitsevat vettä, hiilidioksidia ja auringonvaloa.'
    : '[[scene bg="#1b2a4a" title="Photosynthesis"]]Great question, here is the short version. Plants turn light into chemical energy. ```python\nprint("leaf")\n``` That snippet is on screen now.';
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Searching notes', status: 'in_progress' });
  await sleep(DELAY * 2);
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
  for (let i = 0; i < reply.length;) {
    if (cancelled) return done();
    const n = 3 + ((i * 7) % 5);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(i, i + n) } });
    i += n;
    await sleep(DELAY);
  }
  done();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  const ok = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: 1, agentInfo: { name: 'mock-kiro', title: 'Mock Kiro', version: '3.0-test' },
      agentCapabilities: { loadSession: true, _meta: { kiro: { extensionMethods: ['_session/steer', '_kiro/session/compact', '_kiro/session/context'] } } } });
    case 'session/new': {
      const k = p._meta?.kiro ?? {};
      if (k.modelId) state.model = k.modelId;
      const s = { sessionId: `sess_${sessions.length}`, title: 'New session', updatedAt: new Date().toISOString() };
      sessions.unshift(s);
      return ok({ sessionId: s.sessionId, configOptions: options() });
    }
    case 'session/load': return sessions.some((s) => s.sessionId === p.sessionId) ? ok({ configOptions: options() }) : send({ id: m.id, error: { code: -32002, message: 'no such session' } });
    case 'session/list': return ok({ sessions });
    case 'session/set_config_option': {
      const key = { model: 'model', effortLevel: 'effort', mode: 'mode' }[p.configId];
      if (!key) return send({ id: m.id, error: { code: -32602, message: 'unknown option' } });
      state[key] = p.value;
      return ok({ configOptions: options() });
    }
    case 'session/set_mode': state.mode = p.modeId; return ok({});
    case 'session/prompt': return onPrompt(m.id, p);
    case 'session/cancel': cancelled = true; return;
    case '_session/steer': steers.push(p.prompt?.[0]?.text ?? ''); update(p.sessionId, { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'steering_queued' } } }); return ok({});
    case '_kiro/session/compact': ctxPct = 10; update(p.sessionId, { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'context_usage', usagePercentage: ctxPct } } }); return ok({ compacted: true });
    case '_kiro/session/context': return ok({ usagePercentage: ctxPct, files: ['src/loop.js'] });
  }
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'not supported' } });
});
