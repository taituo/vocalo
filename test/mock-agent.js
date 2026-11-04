#!/usr/bin/env node
// A tiny ACP agent for testing Vocalo without Kiro: streams a reply token by token,
// emits a scene tag split across chunks, a tool call, honours session/cancel,
// and asks for permission when the prompt mentions "delete".
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cancelled = false, nextId = 1000;
const waiting = new Map();
const DELAY = Number(process.env.MOCK_DELAY ?? 15);

const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });

async function onPrompt(id, { sessionId, prompt }) {
  cancelled = false;
  const text = prompt.map((p) => p.text).join(' ');
  const user = text.replace(/\[Vocalo voice mode\][\s\S]*\[\/Vocalo voice mode\]\s*/, '');
  if (/delete/i.test(user)) {
    const pid = nextId++;
    send({ id: pid, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'delete build folder' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    const res = await new Promise((r) => waiting.set(pid, r));
    const ok = res?.outcome?.optionId === 'ok';
    for (const t of (ok ? 'Done, I deleted it.' : 'Okay, I left it alone.').split(/(?<= )/)) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }); await sleep(DELAY); }
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  const fi = /[äö]|moi|hei|mitä/i.test(user);
  const reply = fi
    ? '[[scene bg="#0b3d2e" title="Fotosynteesi"]]Hyvä kysymys, kerron lyhyesti. Kasvit muuttavat valon energiaksi. Ne tarvitsevat vettä, hiilidioksidia ja auringonvaloa.'
    : '[[scene bg="#1b2a4a" title="Photosynthesis"]]Great question, here is the short version. Plants turn light into chemical energy. ```python\nprint("leaf")\n``` That snippet is on screen now.';
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Searching notes', status: 'in_progress' });
  await sleep(DELAY * 2);
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
  // stream in uneven slices so tags/fences get split across chunks
  for (let i = 0; i < reply.length;) {
    if (cancelled) return send({ id, result: { stopReason: 'cancelled' } });
    const n = 3 + ((i * 7) % 5);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(i, i + n) } });
    i += n;
    await sleep(DELAY);
  }
  send({ id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { kiro: { extensionMethods: [] } } }, agentInfo: { name: 'mock', title: 'Mock Agent' } } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'sess_mock' } });
  else if (m.method === 'session/prompt') onPrompt(m.id, m.params);
  else if (m.method === 'session/cancel') cancelled = true;
  else if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'not supported' } });
});
