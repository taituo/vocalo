// Config = defaults  <-  vocalo.config.json  <-  profile  <-  CLI flags.
//
// A profile is a named, partial config: "kiro-remote" (agent on a server), "coach" (slower, deeper,
// teaching persona), "fast" (haiku + low effort + kokoro)… Pick one with --profile NAME, or set
// "defaultProfile". Profiles can `extends` another profile.
import { parseRemoteSpec } from './acp/transport.js';

export const DEFAULTS = {
  agent: { command: 'kiro-cli', args: ['acp', '--agent-engine=v3'], model: null, effortLevel: null, mode: null, additionalDirectories: [] },
  remote: null, // { host, port, identityFile, sshOptions: [], env: {}, cwd, command, shell }
  cwd: null,
  speech: { url: 'ws://127.0.0.1:8765', spawn: true, python: null, ttsEn: null, ttsFi: null, voiceDesc: null, args: [] },
  ui: { mode: 'web', avatar: 'human', theme: 'auto', aspect: '16:9', eventsPort: 8766, host: '127.0.0.1', open: true, openWith: 'auto', kiosk: false },
  conversation: { mode: 'vad', bargeIn: true, permissions: 'ask', preamble: true, defaultLang: 'en', busyPolicy: 'steer',
    verbosity: 'short', fillerAfterMs: 1400, narrateEveryMs: 7000, persona: null },
  control: { autoCompactAt: 85, speakConfirmations: false },
  // Fast "talker" model (OpenAI-compatible). Empty = canned fillers only.
  talker: { url: null, model: null, apiKey: null, apiKeyEnv: null, ackDeadlineMs: 900 },
  metricsFile: null,
  profiles: {},
  defaultProfile: null,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge for plain objects; arrays and scalars replace; `null` explicitly clears. */
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

export function resolveProfile(profiles, name, seen = new Set()) {
  if (!name) return {};
  const p = profiles?.[name];
  if (!p) throw new Error(`unknown profile "${name}" (have: ${Object.keys(profiles ?? {}).join(', ') || 'none'})`);
  if (seen.has(name)) throw new Error(`profile cycle at "${name}"`);
  seen.add(name);
  const { extends: parent, description, ...body } = p;
  return merge(parent ? resolveProfile(profiles, parent, seen) : {}, body);
}

/**
 * @param {object} fileCfg  parsed vocalo.config.json ({} if none)
 * @param {object} argv     parsed CLI flags
 */
export function buildConfig(fileCfg = {}, argv = {}) {
  let cfg = merge(DEFAULTS, fileCfg);
  const profileName = argv.profile ?? fileCfg.defaultProfile ?? null;
  if (profileName) cfg = merge(cfg, resolveProfile(cfg.profiles, profileName));
  cfg.profileName = profileName;

  if (argv.agent) { const [c, ...a] = argv.agent.split(' ').filter(Boolean); cfg.agent = { ...cfg.agent, command: c, args: a }; }
  if (argv.remote) { const r = parseRemoteSpec(argv.remote); cfg.remote = { ...(cfg.remote ?? {}), host: r.host }; if (r.cwd) cfg.remote.cwd = r.cwd; }
  if (cfg.remote?.command) cfg.agent = { ...cfg.agent, command: cfg.remote.command };
  if (cfg.remote?.cwd && !argv.cwd) cfg.cwd = cfg.remote.cwd;
  if (argv.cwd) cfg.cwd = argv.cwd;
  if (!cfg.cwd && !cfg.remote) cfg.cwd = process.cwd();     // remote w/o path: resolved to the login dir later

  const set = (path, v) => { if (v === undefined || v === null) return; const ks = path.split('.'); let o = cfg; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v; };
  set('ui.aspect', argv.aspect);
  set('ui.mode', argv.ui);
  if (argv['no-open']) cfg.ui.open = false;
  if (argv['no-speech'] && cfg.ui.mode === 'web' && argv.ui === undefined) { /* keep web */ }
  set('conversation.mode', argv.mode);
  set('conversation.permissions', argv.permissions);
  set('conversation.busyPolicy', argv.busy);
  set('agent.model', argv.model);
  set('agent.effortLevel', argv.effort);
  if (argv['spawn-sidecar'] !== undefined) cfg.speech.spawn = argv['spawn-sidecar'];
  if (cfg.talker.apiKeyEnv) cfg.talker.apiKey = process.env[cfg.talker.apiKeyEnv] ?? cfg.talker.apiKey;
  return cfg;
}

/** argv for the Python sidecar from the speech section (so profiles can change voice/engines). */
export function sidecarArgs(speech) {
  const a = [];
  if (speech.ttsEn) a.push('--tts-en', speech.ttsEn);
  if (speech.ttsFi) a.push('--tts-fi', speech.ttsFi);
  if (speech.voiceDesc) a.push('--voice-desc', speech.voiceDesc);
  if (speech.url) { const u = new URL(speech.url); a.push('--host', u.hostname, '--port', u.port || '8765'); }
  return [...a, ...(speech.args ?? [])];
}
