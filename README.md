# Vocalo

**Talk to your agent like it's live TV.** Vocalo is a voice-first, TV-style shell for any
[ACP](https://agentclientprotocol.com) agent. It targets **Kiro CLI V3** (`kiro-cli acp --agent-engine=v3`),
but any ACP agent works. Speech runs fully on your Mac (Apple Silicon). Only the agent's own LLM
inference goes over the network.

```
 ┌──────────────── Node (orchestrator) ─────────────────┐        ┌──── ACP agent (Kiro V3) ────┐
 │ TV UI (terminal) · SSE event stream for native UI    │ stdio  │ session/prompt  ──► LLM      │
 │ turn state machine · barge-in · permissions          │◄──────►│ session/update  ◄── stream   │
 │ scene-tag parser · speech chunker · FI/EN guesser    │JSON-RPC│ tools, MCP, steering         │
 └───────────────▲──────────────────────────────────────┘        └──────────────────────────────┘
                 │ WebSocket (text + events only, never raw audio)
 ┌───────────────┴──────── Python sidecar (owns mic + speaker) ─────────────────────────────────┐
 │ mic 16k → Silero VAD → Smart Turn v3.2 → Parakeet TDT 0.6B v3 (MLX) → final / partials       │
 │ say → VoxCPM2 (MLX, streamed pieces) [Kokoro for fast EN] → gapless 48k player → say_start   │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Quick start (macOS, Apple Silicon)

```bash
brew install uv node        # Node 22+
./scripts/setup-mac.sh      # venv, models, one-time voice design, benchmark
$EDITOR vocalo.config.json  # full path to kiro-cli, project folder
mkdir -p ~/code/proj/.kiro/steering && cp steering/vocalo.md ~/code/proj/.kiro/steering/
npm start
```

Try it without a mic or Kiro: `npm run demo` (mock ACP agent, typed input, timed subtitles).
Mic and TTS with the mock agent: `npm run demo:voice`.
Tests (no Mac or models needed): `npm test` and `npm run test:py`.

### Controls
| key | action |
|---|---|
| *(just talk)* | hands-free: VAD + Smart Turn decide when you're done |
| `space` | push-to-talk: tap to start, tap to send (terminals don't report key-up) |
| `t` | type a message instead |
| `i` / `Esc` | interrupt Vocalo |
| `m` | mute mic · `v` hands-free ⇄ PTT · `r` 16:9 ⇄ 4:3 · `q` quit |
| `y` / `a` / `n` | allow / always / deny a tool permission (or just say "yes" / "kyllä") |

You can interrupt (barge in) by just talking. Without echo cancellation, Vocalo uses a stricter VAD
threshold while it is speaking, so **use headphones** for the best experience (see Roadmap: AEC).

## Model choices (researched Nov 2026, for an M5 Pro with 48 GB)

| Stage | Pick | Why | Alternatives |
|---|---|---|---|
| STT | **Parakeet TDT 0.6B v3** (`parakeet-mlx`) | 25 EU languages incl. Finnish with automatic language detection, punctuation, ~6.3% avg WER on the Open ASR leaderboard, and very fast on MLX | **Nemotron 3.5 ASR Streaming 0.6B**: true cache-aware streaming with 80 ms chunks, 40 locales incl. fi-FI, and CoreML builds benchmarked on M5 Pro. This is the upgrade path for word-by-word partials on the ANE. |
| VAD | **Silero VAD v5** | 32 ms frames, ~1 MB, language-agnostic | FireRedVAD |
| End of turn | **Smart Turn v3.2** (Pipecat, BSD-2) | Audio-only "is the speaker finished?" model, ~40 ms on CPU. Lets the VAD stop at 200 ms without cutting people off mid-thought. | Fixed silence timeout (fallback: `--no-smart-turn`) |
| TTS | **VoxCPM2** (`mlx-community/VoxCPM2-8bit`) | 30 languages **incl. Finnish**, voice design from a text prompt, cloning, 48 kHz, Apache-2.0. Vocalo designs one female voice once, then clones it on every call, so EN, FI and mixed speech all keep the same voice. | **Kokoro-82M** for English only (`--tts-en kokoro`): much faster. **Chatterbox Multilingual / Finnish-NLP fine-tune**: strong Finnish (reported WER 2.8%), but PyTorch/CUDA-oriented. **VoxCPMANE2**: CoreML/ANE runtime for VoxCPM2. |

**Honest caveat on TTS speed.** The MLX VoxCPM2 model card reports roughly 0.5–0.9× realtime on
Apple Silicon. The chip isn't stated, and below 1× means slower than realtime. The M5 Pro should
do better, but **measure it**: run `sidecar/.venv/bin/python -m vocalo_speech.server --bench`.
If VoxCPM2 is under ~1.2× realtime on your Mac:
1. lower `--timesteps` (7 → 5), or try the 4-bit model;
2. use `--tts-en kokoro` for English (instant) and keep VoxCPM2 for Finnish;
3. move TTS to the ANE (VoxCPMANE2) so it doesn't share the GPU with STT.

## Latency budget (target: ChatGPT-voice feel, < ~1 s voice→voice)

| step | target | how |
|---|---|---|
| end-of-speech detect | 200–250 ms | VAD `stop_ms=200` + Smart Turn instead of a 700 ms+ silence timeout |
| STT final | ≈0 ms extra | **speculative STT**: Parakeet starts at the first pause *in parallel* with Smart Turn; if the turn is complete, that transcript is the final |
| agent first token | 400–900 ms | the big one, see the playbook below |
| TTS first audio | 150–400 ms | first chunk released at the first clause; streamed synthesis; next sentence synthesized while the current one plays |
| perceived gap | < 1.5 s always | **instant filler**: if the agent has said nothing after 1.4 s (or starts a tool), a pre-rendered "Hmm, hetkinen." / "One moment, let me check." plays with zero TTS cost |

The footer shows live `voice→voice · stt · agent · tts` numbers for every turn. Run with
`--metrics turns.jsonl` to log every turn and tune on real data.

### Latency playbook (in order of impact)
1. **Pick a fast agent model for voice.** `node src/index.js --list-models` prints what Kiro offers. Put a fast one in
   `agent.model` and use `effortLevel: "low"`. Agent time-to-first-token is usually 60–80 % of the total.
2. **Keep the voice project lean.** Every MCP server and big steering file adds prompt tokens on every turn.
   Give voice its own Kiro agent/project with only the tools it needs.
3. **Benchmark TTS on your Mac** (`--bench`). You want ≥ 1.3× realtime. If VoxCPM2 is slower, use `--timesteps 5`,
   the 4-bit model, or Kokoro for English.
4. **One GPU lane.** STT and TTS share one prioritized MLX thread: a final transcript always jumps ahead of TTS
   and partials. This avoids GPU contention, which is the classic cause of a "sometimes laggy" feel.
5. Tune endpointing per person: `--stop-ms 160` (snappier) or `--turn-threshold 0.6` (fewer cut-offs).

### What makes it feel good (not just fast)
- A continued thought is merged. If you pause, Vocalo starts thinking, and you keep talking before it has
  said anything, both parts go to the agent as **one** prompt and the half-thought is cancelled.
- Barge-in stops the audio within one 32 ms frame. The agent turn is cancelled per Kiro's rules: cancel, wait
  for the prompt response, then send the new prompt.
- Subtitles appear when their audio starts, not when the text arrives.
- The agent process is restarted and re-attached to the same session (`session/load`) if it crashes.

## TV harness: stage directions

The agent controls the screen with tags that are stripped from speech and subtitles:

```
[[scene bg="#0b3d2e" title="Fotosynteesi"]]
[[show image="https://…/leaf.png" caption="Chloroplast"]]   (or an absolute path / screenshot)
[[clear]]
```
Fenced code is never spoken; it appears on screen. Images render inline in iTerm2, Ghostty, kitty and WezTerm.
Subtitles are synced to playback: each line appears when its audio starts, and the words are revealed at speaking pace.

A future native UI can subscribe to the same show: `GET http://127.0.0.1:8766/events` (SSE), and send
`POST /command {"type":"text","text":"…"}`.

## Layout
```
src/acp/client.js        ACP JSON-RPC client (Kiro V3 aware: set_config_option, permission options[])
src/core/orchestrator.js turn-taking, barge-in, permissions by voice, metrics
src/core/chunker.js      token stream → speakable chunks (early first clause, code stripped)
src/core/scene.js        [[stage tag]] parser (split-safe)
src/ui/tui.js            16:9 / 4:3 terminal "TV"
src/ui/events.js         SSE event stream for other UIs
sidecar/vocalo_speech/   mic, VAD, Smart Turn, STT, TTS, player, --bench
steering/vocalo.md       Kiro steering → copy into <project>/.kiro/steering/
test/                    node:test suite + mock ACP agent
```

## Roadmap
1. **Echo cancellation**: a small Swift helper using `AVAudioEngine` with voice processing (AEC + noise suppression), so barge-in works on laptop speakers.
2. **Streaming STT on the ANE**: Nemotron 3.5 streaming via CoreML/FluidAudio, so STT runs on the ANE while TTS uses the GPU.
3. **Speculative turns**: start the agent on a stable partial and commit when Smart Turn confirms.
4. **Native macOS UI**: SwiftUI fullscreen "TV" with real hold-to-talk (global hotkey) and Ken Burns images.
5. Voice picker: drop any 10 s clip in `sidecar/voices/vocalo_ref.wav` (+ `.txt` transcript) to change the voice.

Sources: Kiro ACP and CLI V3 migration docs (kiro.dev), NVIDIA Parakeet and Nemotron model cards,
OpenBMB VoxCPM docs, mlx-community VoxCPM2 card, Pipecat Smart Turn, soniqo speech-swift.
