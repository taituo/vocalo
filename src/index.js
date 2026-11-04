#!/usr/bin/env node
// Vocalo — voice-first, TV-style shell for ACP agents (Kiro CLI V3 by default).
// Speech always runs on this Mac; the agent runs here or on a remote machine over SSH.
// UI: web stage (default, app window) and/or terminal TUI.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { AcpClient } from './acp/client.js';
import { Transport } from './acp/transport.js';
import { SpeechSidecar, SilentSpeech } from './speech/sidecar.js';
import { Orchestrator } from './core/orchestrator.js';
import { Controller } from './core/controller.js';
import { Talker } from './core/talker.js';
import { buildConfig, sidecarArgs } from './config.js';
import { TvUI, diffLines } from './ui/tui.js';
import { startEventServer } from './ui/events.js';
import { openStage } from './ui/launch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', default: resolve(ROOT, 'vocalo.config.json') },
    profile: { type: 'string', short: 'p' },
    agent: { type: 'string' },              // "kiro-cli acp --agent-engine=v3" | "node test/mock-agent.js"
    remote: { type: 'string' },             // "user@devbox:/home/me/project"
    cwd: { type: 'string' },
    resume: { type: 'string' },             // "last" | session id
    ui: { type: 'string' },                 // web | tui | both | none
    'no-open': { type: 'boolean', default: false },
    'no-speech': { type: 'boolean', default: false },
    'spawn-sidecar': { type: 'boolean' },
    aspect: { type: 'string' },
    mode: { type: 'string' },               // vad | ptt
    permissions: { type: 'string' },        // ask | allow | deny
    busy: { type: 'string' },               // steer | interrupt | queue
    model: { type: 'string' },
    effort: { type: 'string' },
    log: { type: 'string' },
    metrics: { type: 'string' },
    'list-models': { type: 'boolean', default: false },
    'list-profiles': { type: 'boolean', default: false },
    doctor: { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------- config
const fileCfg = existsSync(argv.config) ? JSON.parse(readFileSync(argv.config, 'utf8')) : {};
if (argv['list-profiles']) {
  const ps = fileCfg.profiles ?? {};
  if (!Object.keys(ps).length) console.log('no profiles in', argv.config, '(see vocalo.config.example.json)');
  for (const [n, p] of Object.entries(ps)) console.log(`${n === fileCfg.defaultProfile ? '*' : ' '} ${n.padEnd(16)} ${p.description ?? ''}`);
  process.exit(0);
}
const cfg = buildConfig(fileCfg, argv);
const personaText = (() => { // persona: inline text, or a path to a .md file
  const p = cfg.conversation.persona;
  if (!p) return null;
  const path = isAbsolute(p) ? p : resolve(dirname(argv.config), p);
  return /\.(md|txt)$/.test(p) && existsSync(path) ? readFileSync(path, 'utf8') : p;
})();
cfg.conversation.persona = personaText;

const logFile = argv.log;
const metricsFile = argv.metrics ?? cfg.metricsFile;
const log = (...a) => { if (logFile) appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); };
const transport = new Transport({ command: cfg.agent.command, args: cfg.agent.args, cwd: cfg.cwd, remote: cfg.remote });

// ---------------------------------------------------------------- doctor
if (argv.doctor) {
  console.log(`Vocalo doctor — agent at ${transport.label}${cfg.profileName ? ` · profile ${cfg.profileName}` : ''}\n`);
  for (const r of await transport.doctor()) console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(30)} ${String(r.ms).padStart(5)} ms  ${r.info ?? ''}`);
  const probe = new AcpClient({ transport }).start();
  try {
    const t = Date.now();
    const init = await probe.initialize();
    console.log(`✔ ${'ACP initialize'.padEnd(30)} ${String(Date.now() - t).padStart(5)} ms  ${init.agentInfo?.name ?? ''} ${init.agentInfo?.version ?? ''}`);
    console.log(`  extensions: ${probe.extensionMethods.join(', ') || '(none advertised)'}`);
    const t2 = Date.now();
    await probe.newSession({ cwd: cfg.cwd ?? undefined, mcpServers: [] });
    console.log(`✔ ${'ACP session/new'.padEnd(30)} ${String(Date.now() - t2).padStart(5)} ms`);
    for (const o of probe.configOptions) console.log(`  ${(o.configId ?? o.id).padEnd(12)} = ${o.currentValue}   [${(o.options ?? []).map((v) => v.value).join(', ')}]`);
  } catch (e) { console.log(`✘ ACP handshake failed: ${e.message}`); }
  probe.stop();
  const tk = new Talker({ ...cfg.talker, ackDeadlineMs: 5000 });
  if (tk.enabled) {
    for (const phrase of ['voitko katsoa miksi testit failaa', 'explain how the auth middleware works']) {
      const t = Date.now();
      const a = await tk.ack(phrase);
      console.log(`${a ? '✔' : '✘'} ${'talker ack'.padEnd(30)} ${String(Date.now() - t).padStart(5)} ms  ${a ?? '(no usable ack)'}  ← "${phrase}"`);
    }
    console.log('  target: < 500 ms. Above ~900 ms the talker is skipped and canned fillers play instead.');
  } else console.log('· talker not configured (canned fillers only). See "talker" in vocalo.config.example.json');
  process.exit(0);
}

// ---------------------------------------------------------------- UI surfaces
const uiMode = cfg.ui.mode;
const wantTui = (uiMode === 'tui' || uiMode === 'both') && process.stdout.isTTY;
const wantWeb = uiMode === 'web' || uiMode === 'both';

/** Stand-in when the terminal UI is off: same surface, no output. */
function nullUI() {
  const ui = { s: { showPlan: true }, handlers: {}, on(e, f) { this.handlers[e] = f; return this; } };
  for (const m of ['start', 'stop', 'set', 'subtitle', 'scene', 'overlay', 'plan', 'showDiff', 'agentInfo']) ui[m] = () => {};
  return ui;
}
const ui = wantTui ? new TvUI({ aspect: cfg.ui.aspect, readFile: (p) => transport.readFile(p) }) : nullUI();
const events = startEventServer({ port: cfg.ui.eventsPort, host: cfg.ui.host, onCommand: (c) => handleCommand(c) });
const pub = (type, payload) => events.publish(type, payload);
const notify = (text) => { ui.set({ notice: text }); pub('notice', { text }); log('notice', text); if (!wantTui && !wantWeb) console.error(text); };

const openUrlOnMac = (url) => new Promise((res) => {
  if (!/^https:\/\//.test(url || '')) return res(false);
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], (err) => res(!err));
});
let urlWaiter = null;
const acp = new AcpClient({
  transport,
  // Kiro asks the client to open sign-in pages; in remote mode that browser is the Mac's.
  // Kiro requires a visible user action, so we wait for [o] / the button instead of auto-opening.
  onOpenUrl: (url) => new Promise((resolveOpen) => {
    urlWaiter = async () => resolveOpen(await openUrlOnMac(url));
    ui.set({ pendingUrl: true }); pub('open_url', { pending: true });
    setTimeout(() => { if (urlWaiter) { urlWaiter = null; ui.set({ pendingUrl: null }); pub('open_url', { pending: false }); resolveOpen(false); } }, 5 * 60000);
  }),
});
acp.on('stderr', (s) => log('agent:', s.trim()));

const python = cfg.speech.python ?? resolve(ROOT, 'sidecar/.venv/bin/python');
const speech = argv['no-speech']
  ? new SilentSpeech()
  : new SpeechSidecar({
      url: cfg.speech.url,
      cwd: resolve(ROOT, 'sidecar'),
      spawnCmd: cfg.speech.spawn ? [existsSync(python) ? python : 'python3', '-m', 'vocalo_speech.server', ...sidecarArgs(cfg.speech)] : null,
    });
speech.on('log', (m) => log('speech:', m.message));
speech.on('error', (m) => notify(m.message));
speech.on('level', (m) => pub('level', { mic: m.mic, out: m.out }));

const talker = new Talker(cfg.talker);
const orch = new Orchestrator({ acp, speech, talker, config: cfg.conversation });
const ctl = new Controller({ acp, orch, transport, ui, config: cfg.control });

// ---- orchestrator/controller -> UIs
let mode = cfg.conversation.mode, muted = false, pttActive = false;
orch.on('state', (st) => { ui.set({ state: st, ...(st === 'idle' ? { tool: '' } : {}) }); pub('state', { state: st }); });
orch.on('user_partial', (text) => { ui.set({ userPartial: text }); pub('user_partial', { text }); });
orch.on('user_final', (text) => { ui.set({ user: text, userPartial: '' }); pub('user', { text }); log('user:', text); });
orch.on('assistant_subtitle', ({ text, durationMs }) => { ui.subtitle(text, durationMs); pub('subtitle', { text, durationMs }); });
orch.on('assistant_stream', (text) => pub('assistant_stream', { text }));
orch.on('scene', (tag) => showScene(tag));
orch.on('code', (code) => { ui.set({ code, image: null, diff: null }); pub('code', { code }); });
orch.on('plan', (entries) => { ui.plan(entries); pub('plan', { entries }); });
orch.on('diff', (d) => { ui.showDiff(d); pub('diff', { path: d.path, toolCallId: d.toolCallId, rows: diffLines(d.oldText, d.newText) }); });
orch.on('steered', (text) => { notify(`↪ steered: ${text}`); pub('steered', { text }); });
orch.on('queued', (text) => notify(`⏳ queued: ${text}`));
orch.on('ack', (text) => pub('ack', { text }));
orch.on('narration', (text) => pub('narration', { text }));
const toolTitles = new Map();
orch.on('tool', (t) => {
  if (t.title) toolTitles.set(t.id, t.title);
  const title = t.title ?? toolTitles.get(t.id);
  if (title) ui.set({ tool: t.status === 'completed' ? '' : `${title}${t.status ? ' · ' + t.status.replace('_', ' ') : ''}` });
  pub('tool', { id: t.id, kind: t.kind, status: t.status, title });
});
orch.on('metrics', (m) => {
  ui.set({ metrics: m }); pub('metrics', m); log('metrics', JSON.stringify(m));
  if (metricsFile && m.voiceToVoiceMs != null) appendFileSync(metricsFile, JSON.stringify({ t: new Date().toISOString(), profile: cfg.profileName, where: transport.label, model: acp.current('model'), ...m }) + '\n');
});
orch.on('permission', ({ title, resource }) => { ui.set({ permission: resource ? `${title} (${resource})` : title }); pub('permission', { title, resource }); });
orch.on('permission_resolved', () => { ui.set({ permission: null }); pub('permission', null); pub('permission_resolved', {}); });
orch.on('turn_end', ({ stopReason, text }) => log('assistant:', JSON.stringify(text), stopReason));
orch.on('warn', (w) => notify(w));

ctl.on('overlay', ({ title, lines, picks }) => { ui.overlay(title, lines); pub('overlay', { title, lines, picks }); });
ctl.on('info', (m) => notify(m));
ctl.on('code', (code) => { ui.set({ code, image: null, diff: null }); pub('code', { code }); });
ctl.on('scene', (tag) => showScene(tag));
ctl.on('diff', (d) => { ui.showDiff(d); pub('diff', { path: d.path, rows: diffLines(d.oldText, d.newText) }); });
ctl.on('toggle_plan', () => ui.set({ showPlan: !ui.s.showPlan }));
ctl.on('session_changed', () => { ui.plan([]); pub('plan', { entries: [] }); refreshAgentHeader(); });

/** Scenes may reference files on the agent's machine (remote!): resolve them for the web stage. */
async function showScene(tag) {
  ui.scene(tag);
  if (tag.image && !/^(https?:|data:)/.test(tag.image) && !tag.imageData) {
    try {
      const buf = await transport.readFile(tag.image);
      const ext = (tag.image.split('.').pop() || 'png').toLowerCase();
      return pub('scene', { ...tag, imageData: buf.toString('base64'), mimeType: ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}` });
    } catch (e) { notify(`image ${tag.image}: ${e.message}`); }
  }
  pub('scene', tag);
}

function refreshAgentHeader() {
  const k = acp.kiro;
  const modeName = acp.current('mode') ?? k.modes?.currentModeId ?? null;
  const model = acp.option('model');
  const modelName = model ? (model.options?.find((v) => v.value === model.currentValue)?.name ?? model.currentValue) : null;
  const info = { where: transport.isRemote ? transport.label : 'local', model: modelName, mode: modeName, effort: acp.current('effortLevel'), contextPct: k.contextPct };
  ui.agentInfo(info);
  pub('agent', { ...info, sessionId: acp.sessionId, profile: cfg.profileName });
}
acp.on('session_state', refreshAgentHeader);

function permissionKey(choice) {
  const p = orch.pendingPermission; if (!p) return;
  const kinds = { allow: ['allow_once', 'allow_always'], always: ['allow_always', 'allow_once'], reject: ['reject_once', 'reject_always'] }[choice];
  if (!kinds) return;
  const o = kinds.map((k) => p.options.find((x) => x.kind === k)).find(Boolean);
  orch.resolvePermission(o?.optionId ?? null);
}

function setPtt(active) {
  // Hold-to-talk works in any mode: while held, VAD is ignored and everything is captured.
  if (active === pttActive) return;
  pttActive = active;
  if (active && orch.state === 'speaking') orch.interrupt('ptt');
  speech.ptt(active);
  ui.set({ notice: active ? 'recording… release to send' : '' });
  pub('ptt', { active });
}

function handleCommand(c) {
  switch (c?.type) {
    case 'text': return orch.userSaid(c.text, {});
    case 'interrupt': return orch.interrupt('user');
    case 'command': return ctl.run(c.line);
    case 'permission': return permissionKey(c.choice);
    case 'ptt': return setPtt(!!c.active);
    case 'mute': muted = c.muted ?? !muted; speech.mic(!muted); ui.set({ muted }); return notify(muted ? 'mic off' : 'mic on');
    case 'mode': mode = c.mode ?? (mode === 'vad' ? 'ptt' : 'vad'); speech.mode(mode); ui.set({ mode }); return notify(mode === 'ptt' ? 'push-to-talk' : 'hands-free');
    case 'open_url': { const w = urlWaiter; urlWaiter = null; ui.set({ pendingUrl: null }); pub('open_url', { pending: false }); return w?.(); }
  }
}

ui.on('text', (t) => (t.startsWith('/') || t.startsWith(':') ? ctl.run(t) : orch.userSaid(t, {})))
  .on('command', (line) => ctl.run(line))
  .on('interrupt', () => orch.interrupt('user'))
  .on('permission', permissionKey)
  .on('open_url', () => handleCommand({ type: 'open_url' }))
  .on('mute', () => handleCommand({ type: 'mute' }))
  .on('mode', () => handleCommand({ type: 'mode' }))
  .on('ptt', () => setPtt(!pttActive)) // terminal: no key-up events -> tap to start / tap to send
  .on('quit', shutdown);

// ---- agent connection lifecycle (local crash or SSH drop): restart + re-attach
let shuttingDown = false, restarts = 0, lastRestart = 0;
async function connectAgent({ resume } = {}) {
  if (transport.isRemote && !cfg.cwd) { // no path given: use the remote login directory
    cfg.cwd = (await transport.exec('pwd')).trim();
    transport.cwd = acp.cwd = cfg.cwd;
  }
  acp.start();
  await acp.initialize();
  log('agent init', JSON.stringify({ agentInfo: acp.agentInfo, ext: acp.extensionMethods }));
  const kiroInit = Object.fromEntries(Object.entries({ modelId: cfg.agent.model, effortLevel: cfg.agent.effortLevel, modeId: cfg.agent.mode }).filter(([, v]) => v));
  const sessionOpts = { cwd: cfg.cwd ?? undefined, mcpServers: [], additionalDirectories: cfg.agent.additionalDirectories };
  let resumed = false;
  if (resume && acp.canLoadSession) {
    try {
      let id = resume;
      if (resume === 'last') id = (await acp.listSessions({ cwd: cfg.cwd ?? undefined }))[0]?.id;
      if (id) { await acp.loadSession({ ...sessionOpts, sessionId: id }); resumed = true; }
    } catch (e) { log('resume failed', e.message); notify(`resume failed: ${e.message}`); }
  }
  if (!resumed) await acp.newSession({ ...sessionOpts, kiro: kiroInit });
  // Also apply via set_config_option: agents that ignore _meta.kiro still honour this.
  if (cfg.agent.model && acp.option('model') && acp.current('model') !== cfg.agent.model) await acp.setConfigOption('model', cfg.agent.model).catch((e) => log('model', e.message));
  if (cfg.agent.effortLevel && acp.option('effortLevel') && acp.current('effortLevel') !== cfg.agent.effortLevel)
    await acp.setConfigOption('effortLevel', cfg.agent.effortLevel).catch((e) => log('effort', e.message));
  if (cfg.agent.mode && !resumed) await acp.setMode(cfg.agent.mode).catch((e) => log('mode', e.message));
  refreshAgentHeader();
  return resumed;
}

acp.on('exit', async (code) => {
  if (shuttingDown) return;
  orch.interrupt('agent-exit').catch(() => {});
  if (Date.now() - lastRestart > 120000) restarts = 0;
  if (++restarts > 6) return notify(`agent connection lost (${code}); check \`vocalo --doctor\``);
  lastRestart = Date.now();
  notify(`${transport.isRemote ? 'SSH/agent' : 'agent'} disconnected (${code}) — reconnecting…`);
  await new Promise((r) => setTimeout(r, Math.min(8000, 700 * restarts)));
  const prev = acp.sessionId;
  try {
    await connectAgent({ resume: prev });
    notify(`reconnected${acp.sessionId === prev ? ' · same session' : ''}`);
  } catch (err) { notify(`reconnect failed: ${err.message}`); log('reconnect failed', err.stack); }
});

function shutdown() {
  shuttingDown = true;
  ui.stop(); speech.close(); acp.stop(); events.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { log('fatal', e.stack); ui.stop(); console.error(e); process.exit(1); });

// ---------------------------------------------------------------- boot
if (argv['list-models']) {
  await connectAgent();
  console.log(`Agent: ${acp.agentInfo?.name ?? '?'} ${acp.agentInfo?.version ?? ''} at ${transport.label}`);
  for (const o of acp.configOptions) {
    console.log(`\n${o.name ?? o.configId ?? o.id} (${o.configId ?? o.id}) = ${o.currentValue}`);
    for (const v of o.options ?? []) console.log(`  ${v.value === o.currentValue ? '▶' : ' '} ${v.value}${v.name ? `  ${v.name}` : ''}${v.description ? `  — ${v.description}` : ''}`);
  }
  if (acp.kiro.modes) console.log('\nmodes:', acp.kiro.modes.availableModes?.map((m) => m.id).join(', '));
  acp.stop(); events.close(); process.exit(0);
}

const caption = (text) => { ui.set({ caption: text }); pub('scene', { kind: 'scene', caption: text }); };
ui.start();
ui.set({ title: 'Vocalo', mode });
caption(transport.isRemote ? `connecting to ${transport.remote.host}…` : 'warming up voice + agent…');
pub('profile', { name: cfg.profileName });

const web = await events.ready;
if (wantWeb) {
  if (!web.ok) notify(`web UI unavailable: ${web.error}`);
  else {
    if (!wantTui) console.log(`Vocalo stage: ${web.url}${cfg.profileName ? `  (profile ${cfg.profileName})` : ''}  · Ctrl+C to quit`);
    if (cfg.ui.open) { const o = openStage(web.url, { prefer: cfg.ui.openWith, kiosk: cfg.ui.kiosk }); log('stage opened via', o.how); }
  }
}

try {
  const sp = speech.start();
  if (transport.isRemote) {
    const ms = await transport.warm();
    caption(`ssh ${transport.remote.host} ${ms} ms · starting agent…`);
  }
  const resumed = await connectAgent({ resume: argv.resume });
  caption('agent ready · loading speech models (first run downloads them)…');
  await sp;
  speech.mode(mode);
  const name = acp.agentInfo?.title || acp.agentInfo?.name || cfg.agent.command;
  caption(`${name}${transport.isRemote ? ' @ ' + transport.label : ''}${resumed ? ' · resumed' : ''} · just talk${wantWeb ? ' · hold Space for push-to-talk' : ''}`);
} catch (err) {
  notify(`startup failed: ${err.message}`);
  log('startup failed', err.stack);
}
