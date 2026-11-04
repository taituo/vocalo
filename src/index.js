#!/usr/bin/env node
// Vocalo — a voice-first, TV-style conversational shell for any ACP agent (Kiro CLI V3 by default).
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AcpClient } from './acp/client.js';
import { SpeechSidecar, SilentSpeech } from './speech/sidecar.js';
import { Orchestrator } from './core/orchestrator.js';
import { TvUI } from './ui/tui.js';
import { startEventServer } from './ui/events.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', default: resolve(ROOT, 'vocalo.config.json') },
    agent: { type: 'string' },              // e.g. "kiro-cli acp --agent-engine=v3" or "node test/mock-agent.js"
    cwd: { type: 'string' },
    'no-speech': { type: 'boolean', default: false },
    'spawn-sidecar': { type: 'boolean' },
    aspect: { type: 'string' },
    mode: { type: 'string' },               // vad | ptt
    permissions: { type: 'string' },        // ask | allow | deny
    model: { type: 'string' },
    log: { type: 'string' },
    metrics: { type: 'string' },            // append one JSON line per turn (for latency tuning)
    'list-models': { type: 'boolean', default: false },
  },
});

const defaults = {
  agent: { command: 'kiro-cli', args: ['acp', '--agent-engine=v3'], model: null, effortLevel: null },
  cwd: process.cwd(),
  speech: { url: 'ws://127.0.0.1:8765', spawn: true, python: resolve(ROOT, 'sidecar/.venv/bin/python') },
  ui: { aspect: '16:9', eventsPort: 8766 },
  conversation: { mode: 'vad', bargeIn: true, permissions: 'ask', preamble: true, defaultLang: 'en' },
};
const fileCfg = existsSync(argv.config) ? JSON.parse(readFileSync(argv.config, 'utf8')) : {};
const cfg = {
  ...defaults, ...fileCfg,
  agent: { ...defaults.agent, ...fileCfg.agent },
  speech: { ...defaults.speech, ...fileCfg.speech },
  ui: { ...defaults.ui, ...fileCfg.ui },
  conversation: { ...defaults.conversation, ...fileCfg.conversation },
};
if (argv.agent) { const [c, ...a] = argv.agent.split(' ').filter(Boolean); cfg.agent.command = c; cfg.agent.args = a; }
if (argv.cwd) cfg.cwd = argv.cwd;
if (argv.aspect) cfg.ui.aspect = argv.aspect;
if (argv.mode) cfg.conversation.mode = argv.mode;
if (argv.permissions) cfg.conversation.permissions = argv.permissions;
if (argv.model) cfg.agent.model = argv.model;
if (argv['spawn-sidecar'] !== undefined) cfg.speech.spawn = argv['spawn-sidecar'];

const logFile = argv.log;
const metricsFile = argv.metrics ?? fileCfg.metricsFile;
const log = (...a) => { if (logFile) appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); };

const ui = new TvUI({ aspect: cfg.ui.aspect });
const events = startEventServer({ port: cfg.ui.eventsPort, onCommand: (c) => handleCommand(c) });

const acp = new AcpClient({ command: cfg.agent.command, args: cfg.agent.args, cwd: cfg.cwd });
acp.on('stderr', (s) => log('agent:', s.trim()));

const speech = argv['no-speech']
  ? new SilentSpeech()
  : new SpeechSidecar({
      url: cfg.speech.url,
      cwd: resolve(ROOT, 'sidecar'),
      spawnCmd: cfg.speech.spawn ? [existsSync(cfg.speech.python) ? cfg.speech.python : 'python3', '-m', 'vocalo_speech.server'] : null,
    });
speech.on('log', (m) => log('speech:', m.message));
speech.on('error', (m) => { log('speech error:', m.message); ui.set({ notice: m.message }); });

const orch = new Orchestrator({ acp, speech, config: cfg.conversation });

// ---- wire orchestrator -> UI + event stream ----
let mode = cfg.conversation.mode, muted = false, pttActive = false;
orch.on('state', (st) => { ui.set({ state: st, ...(st === 'idle' ? { tool: '' } : {}) }); events.publish('state', { state: st }); });
orch.on('user_partial', (text) => { ui.set({ userPartial: text }); events.publish('user_partial', { text }); });
orch.on('user_final', (text) => { ui.set({ user: text, userPartial: '' }); events.publish('user', { text }); log('user:', text); });
orch.on('assistant_subtitle', ({ text, durationMs }) => { ui.subtitle(text, durationMs); events.publish('subtitle', { text, durationMs }); });
orch.on('assistant_stream', (text) => events.publish('assistant_stream', { text }));
orch.on('scene', (tag) => { ui.scene(tag); events.publish('scene', tag); });
orch.on('code', (code) => { ui.set({ code, image: null }); events.publish('code', { code }); });
const toolTitles = new Map();
orch.on('tool', (t) => {
  if (t.title) toolTitles.set(t.id, t.title);
  const title = t.title ?? toolTitles.get(t.id);
  if (title) ui.set({ tool: t.status === 'completed' ? '' : `${title}${t.status ? ' · ' + t.status.replace('_', ' ') : ''}` });
  events.publish('tool', { ...t, title });
});
orch.on('metrics', (m) => {
  ui.set({ metrics: m }); events.publish('metrics', m); log('metrics', JSON.stringify(m));
  if (metricsFile && m.voiceToVoiceMs != null) appendFileSync(metricsFile, JSON.stringify({ t: new Date().toISOString(), ...m }) + '\n');
});
orch.on('permission', ({ title, options }) => { ui.set({ permission: title }); events.publish('permission', { title, options }); });
orch.on('permission_resolved', () => ui.set({ permission: null }));
orch.on('turn_end', ({ stopReason, text }) => log('assistant:', JSON.stringify(text), stopReason));
orch.on('warn', (w) => { ui.set({ notice: w }); log('warn', w); });

function permissionKey(choice) {
  const p = orch.pendingPermission; if (!p) return;
  const kinds = { allow: ['allow_once', 'allow_always'], always: ['allow_always', 'allow_once'], reject: ['reject_once', 'reject_always'] }[choice];
  const o = kinds.map((k) => p.options.find((x) => x.kind === k)).find(Boolean);
  orch.resolvePermission(o?.optionId ?? null);
}

function handleCommand(c) {
  if (c.type === 'text') orch.userSaid(c.text, {});
  else if (c.type === 'interrupt') orch.interrupt('user');
}

ui.on('text', (t) => orch.userSaid(t, {}))
  .on('interrupt', () => orch.interrupt('user'))
  .on('permission', permissionKey)
  .on('mute', () => { muted = !muted; speech.mic(!muted); ui.set({ muted }); })
  .on('mode', () => { mode = mode === 'vad' ? 'ptt' : 'vad'; speech.mode(mode); ui.set({ mode }); })
  .on('ptt', () => {
    // Terminals have no key-up events, so PTT is tap-to-start / tap-to-send.
    if (mode !== 'ptt') { mode = 'ptt'; speech.mode('ptt'); ui.set({ mode }); }
    pttActive = !pttActive;
    if (pttActive && orch.state === 'speaking') orch.interrupt('ptt');
    speech.ptt(pttActive);
    ui.set({ notice: pttActive ? 'recording… tap space to send' : '' });
  })
  .on('quit', shutdown);

// ---- agent crash recovery: restart, re-attach to the same session if possible ----
let shuttingDown = false, restarts = 0;
acp.on('exit', async (code) => {
  if (shuttingDown) return;
  if (++restarts > 5) return ui.set({ notice: `agent exited (${code}); giving up after 5 restarts` });
  ui.set({ notice: `agent exited (${code}) — restarting…` });
  await new Promise((r) => setTimeout(r, 500 * restarts));
  try {
    acp.start();
    await acp.initialize();
    if (acp.sessionId && acp.canLoadSession) await acp.loadSession({ cwd: cfg.cwd });
    else await acp.newSession({ cwd: cfg.cwd, mcpServers: [] });
    ui.set({ notice: 'agent reconnected' });
  } catch (err) { ui.set({ notice: `agent restart failed: ${err.message}` }); }
});

function shutdown() {
  shuttingDown = true;
  ui.stop(); speech.close(); acp.stop(); events.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => { log('fatal', e.stack); ui.stop(); console.error(e); process.exit(1); });

// ---- boot ----
if (argv['list-models']) {
  // Prints what this agent offers so you can pick the fastest model for voice.
  acp.start();
  await acp.initialize();
  const sess = await acp.newSession({ cwd: cfg.cwd, mcpServers: [] });
  const { sessionId, ...rest } = sess;
  console.log(JSON.stringify({ agent: acp.agentInfo, session: rest }, null, 2));
  acp.stop(); events.close(); process.exit(0);
}
ui.start();
ui.set({ title: 'Vocalo', caption: 'warming up voice + agent…', mode });
try {
  const sp = speech.start();
  acp.start();
  const init = await acp.initialize();
  log('agent init', JSON.stringify(init));
  await acp.newSession({ cwd: cfg.cwd, mcpServers: [] });
  if (cfg.agent.model) await acp.setConfigOption('model', cfg.agent.model);
  if (cfg.agent.effortLevel) await acp.setConfigOption('effortLevel', cfg.agent.effortLevel);
  ui.set({ caption: 'agent ready · loading speech models (first run downloads them)…' });
  await sp;
  speech.mode(mode);
  const name = acp.agentInfo?.title || acp.agentInfo?.name || cfg.agent.command;
  ui.set({ caption: `${name} · say hi${mode === 'ptt' ? ' (space to talk)' : ''}` });
} catch (err) {
  ui.set({ notice: `startup failed: ${err.message}` });
  log('startup failed', err.stack);
}
