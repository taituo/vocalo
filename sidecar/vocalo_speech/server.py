"""Vocalo speech sidecar: owns the microphone and the speaker.

    mic 16k ─► Silero VAD ─► (pause) ─► Smart Turn ─► Parakeet v3 ─► "final" ─► Node
                    └──────── live partials every ~350 ms ─────────► "partial"
    Node "say" ─► TTS (streamed pieces) ─► player 48k ─► "say_start"/"say_end"/"idle"

Run:  python -m vocalo_speech.server [--tts-en kokoro] [--bench]
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import json
import threading
import time

import numpy as np

from .engines import SR, ParakeetSTT, SileroVAD, SmartTurn, TTSRouter, resample

OUT_SR = 48000
FRAME = 512  # 32 ms @ 16 kHz (Silero's native frame)


def now_ms() -> int:
    return int(time.time() * 1000)


# ======================================================================= player
class Player:
    """Gapless streaming player. Items are appended piece by piece while they are
    being synthesized; stop() is immediate (with a 10 ms fade to avoid clicks)."""

    def __init__(self, emit):
        import sounddevice as sd
        self.emit = emit
        self.lock = threading.Lock()
        self.items: collections.deque = collections.deque()
        self.cur = None
        self.cur_buf = np.zeros(0, np.float32)
        self.was_active = False
        self.fade = None
        self.stream = sd.OutputStream(samplerate=OUT_SR, channels=1, dtype="float32",
                                      blocksize=480, latency="low", callback=self._cb)
        self.stream.start()

    @property
    def active(self) -> bool:
        with self.lock:
            return self.cur is not None or bool(self.items)

    def enqueue(self, item_id: str, text: str):
        with self.lock:
            self.items.append({"id": item_id, "text": text, "pieces": collections.deque(), "done": False})

    def _find(self, item_id):
        if self.cur and self.cur["id"] == item_id:
            return self.cur
        return next((i for i in self.items if i["id"] == item_id), None)

    def append(self, item_id: str, audio: np.ndarray, sr: int):
        a = resample(audio, sr, OUT_SR)
        with self.lock:
            it = self._find(item_id)
            if it is not None:
                it["pieces"].append(a)

    def finish(self, item_id: str):
        with self.lock:
            it = self._find(item_id)
            if it is not None:
                it["done"] = True

    def stop(self):
        with self.lock:
            if len(self.cur_buf):
                n = min(len(self.cur_buf), OUT_SR // 100)
                self.fade = self.cur_buf[:n] * np.linspace(1, 0, n, dtype=np.float32)
            self.items.clear()
            self.cur = None
            self.cur_buf = np.zeros(0, np.float32)

    def _cb(self, out, frames, _time, _status):
        out.fill(0)
        filled = 0
        events = []
        with self.lock:
            if self.fade is not None:
                n = min(frames, len(self.fade))
                out[:n, 0] = self.fade[:n]
                self.fade = self.fade[n:] if n < len(self.fade) else None
                filled = frames
            while filled < frames:
                if not len(self.cur_buf):
                    if self.cur and self.cur["pieces"]:
                        self.cur_buf = self.cur["pieces"].popleft()
                        continue
                    if self.cur and self.cur["done"]:
                        events.append(("say_end", {"id": self.cur["id"]}))
                        self.cur = None
                    if self.cur is None and self.items and (self.items[0]["pieces"] or self.items[0]["done"]):
                        self.cur = self.items.popleft()
                        est = max(400, int(len(self.cur["text"]) * 62))
                        events.append(("say_start", {"id": self.cur["id"], "text": self.cur["text"], "durationMs": est}))
                        continue
                    break  # underrun or nothing to play
                n = min(frames - filled, len(self.cur_buf))
                out[filled:filled + n, 0] = self.cur_buf[:n]
                self.cur_buf = self.cur_buf[n:]
                filled += n
            active = self.cur is not None or bool(self.items)
            if self.was_active and not active:
                events.append(("idle", {}))
            self.was_active = active
        for e in events:
            self.emit(*e)


# ======================================================================= server
class Sidecar:
    def __init__(self, args):
        self.args = args
        self.clients: set = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.mic_enabled = True
        self.mode = "vad"
        self.ptt_active = False
        self.say_q: asyncio.Queue = asyncio.Queue()
        self.gen = 0  # bumps on stop(): stale synth work is dropped
        self.frames: asyncio.Queue = asyncio.Queue()

    # -------- plumbing
    def emit(self, type_, payload=None):
        """Thread-safe event to Node."""
        msg = json.dumps({"type": type_, **(payload or {})})
        if self.loop:
            self.loop.call_soon_threadsafe(self._broadcast, msg)

    def _broadcast(self, msg):
        for ws in list(self.clients):
            asyncio.ensure_future(self._safe_send(ws, msg))

    async def _safe_send(self, ws, msg):
        try:
            await ws.send(msg)
        except Exception:
            self.clients.discard(ws)

    def log(self, m):
        print(m, flush=True)
        self.emit("log", {"message": m})

    # -------- boot
    def load(self):
        t = time.perf_counter()
        self.vad = SileroVAD()
        self.turn = None if self.args.no_smart_turn else SmartTurn(self.args.smart_turn_path)
        self.stt = ParakeetSTT(self.args.stt_model)
        self.tts = TTSRouter(en=self.args.tts_en, fi=self.args.tts_fi, voice_ref=self.args.voice_ref,
                             voxcpm_model=self.args.voxcpm_model, timesteps=self.args.timesteps)
        self.tts.warmup()
        self.log(f"models ready in {time.perf_counter() - t:.1f}s")

    async def handler(self, ws):
        self.clients.add(ws)
        await ws.send(json.dumps({"type": "ready", "engines": {
            "stt": self.args.stt_model, "tts": {"en": self.args.tts_en, "fi": self.args.tts_fi},
            "vad": "silero-v5", "turn": None if self.turn is None else "smart-turn-v3.2"}}))
        try:
            async for raw in ws:
                self.on_command(json.loads(raw))
        finally:
            self.clients.discard(ws)

    def on_command(self, m):
        t = m.get("type")
        if t == "say":
            self.player.enqueue(m["id"], m["text"])
            self.say_q.put_nowait((self.gen, m["id"], m["text"], m.get("lang", "en")))
        elif t == "stop":
            self.stop_speaking()
        elif t == "mic":
            self.mic_enabled = bool(m.get("enabled", True))
        elif t == "mode":
            self.mode = m.get("mode", "vad")
        elif t == "ptt":
            self.ptt_active = bool(m.get("active"))

    def stop_speaking(self):
        self.gen += 1
        while not self.say_q.empty():
            self.say_q.get_nowait()
        self.player.stop()

    # -------- TTS worker: synthesize ahead while the previous chunk plays
    async def tts_worker(self):
        while True:
            gen, item_id, text, lang = await self.say_q.get()
            if gen != self.gen:
                continue

            def run():
                for audio, sr in self.tts.stream(text, lang):
                    if gen != self.gen:
                        return
                    self.player.append(item_id, audio, sr)
                self.player.finish(item_id)

            try:
                await asyncio.to_thread(run)
            except Exception as e:  # never kill the worker
                self.player.finish(item_id)
                self.emit("error", {"message": f"tts: {e}"})

    # -------- mic + turn-taking
    def _mic_cb(self, indata, frames, _t, _s):
        self.loop.call_soon_threadsafe(self.frames.put_nowait, indata[:, 0].copy())

    async def listen(self):
        import sounddevice as sd
        a = self.args
        stream = sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=FRAME,
                                callback=self._mic_cb, device=a.input_device)
        stream.start()
        preroll = collections.deque(maxlen=int(0.3 * SR / FRAME))
        speech: list[np.ndarray] = []
        in_speech = False
        voiced = silent = 0
        pause_at = None       # epoch ms when the current pause began
        turn_checked = False
        last_partial = 0.0
        partial_task = None
        barge_frames = 0
        was_ptt = False

        async def finalize(end_ms):
            nonlocal speech, in_speech, voiced, silent, pause_at, turn_checked
            audio = np.concatenate(speech) if speech else np.zeros(0, np.float32)
            speech, in_speech, voiced, silent, pause_at, turn_checked = [], False, 0, 0, None, False
            self.vad.reset()
            self.emit("vad", {"speaking": False})
            t0 = time.perf_counter()
            text = await asyncio.to_thread(self.stt.transcribe, audio)
            self.emit("final", {"text": text, "sttMs": int((time.perf_counter() - t0) * 1000),
                                "endOfSpeechAt": end_ms, "audioMs": int(len(audio) / SR * 1000)})

        while True:
            frame = await self.frames.get()
            if not self.mic_enabled:
                continue

            # ---------- push-to-talk: record while active, send on release
            if self.mode == "ptt":
                if self.ptt_active:
                    if not was_ptt:
                        self.stop_speaking()
                        self.emit("vad", {"speaking": True})
                        speech = []
                    speech.append(frame)
                    was_ptt = True
                    if time.monotonic() - last_partial > a.partial_every and (partial_task is None or partial_task.done()):
                        last_partial = time.monotonic()
                        partial_task = asyncio.create_task(self._partial(np.concatenate(speech)))
                elif was_ptt:
                    was_ptt = False
                    await finalize(now_ms())
                continue

            # ---------- hands-free
            p = self.vad.prob(frame)
            playing = self.player.active
            start_th = a.barge_threshold if playing else a.vad_threshold

            if not in_speech:
                preroll.append(frame)
                voiced = voiced + 1 if p >= start_th else 0
                need = a.barge_frames if playing else 2
                if voiced >= need:
                    if playing:
                        if not a.barge_in:
                            voiced = 0
                            continue
                        self.stop_speaking()
                        self.emit("barge_in", {})
                    in_speech = True
                    speech = list(preroll)
                    preroll.clear()
                    silent = 0
                    self.emit("vad", {"speaking": True})
                continue

            speech.append(frame)
            if p < a.vad_threshold - 0.15:
                silent += 1
                if pause_at is None:
                    pause_at = now_ms() - FRAME * 1000 // SR
            else:
                silent, pause_at, turn_checked = 0, None, False

            pause_ms = silent * FRAME * 1000 / SR
            # 1) short pause -> ask Smart Turn whether the thought is complete
            if pause_ms >= a.stop_ms and not turn_checked:
                turn_checked = True
                done = True
                if self.turn is not None:
                    prob = await asyncio.to_thread(self.turn.complete_prob, np.concatenate(speech))
                    done = prob >= a.turn_threshold
                if done:
                    await finalize(pause_at or now_ms())
                    continue
            # 2) user paused mid-thought: end anyway after max silence
            if pause_ms >= a.max_silence_ms:
                await finalize(pause_at or now_ms())
                continue
            # live partials
            if time.monotonic() - last_partial > a.partial_every and (partial_task is None or partial_task.done()):
                last_partial = time.monotonic()
                partial_task = asyncio.create_task(self._partial(np.concatenate(speech)))
            if len(speech) * FRAME > a.max_utterance_s * SR:
                await finalize(now_ms())

    async def _partial(self, audio):
        try:
            text = await asyncio.to_thread(self.stt.transcribe, audio)
            if text:
                self.emit("partial", {"text": text})
        except Exception as e:
            self.emit("error", {"message": f"stt partial: {e}"})

    async def main(self):
        import websockets
        self.loop = asyncio.get_running_loop()
        await asyncio.to_thread(self.load)
        self.player = Player(self.emit)
        asyncio.create_task(self.tts_worker())
        asyncio.create_task(self.listen())
        async with websockets.serve(self.handler, self.args.host, self.args.port, max_size=None):
            self.log(f"vocalo speech sidecar on ws://{self.args.host}:{self.args.port}")
            await asyncio.Future()


# ======================================================================= bench
def bench(args):
    """Measure what matters for responsiveness on *this* Mac."""
    import soundfile as sf  # noqa: F401
    print("loading…")
    stt = ParakeetSTT(args.stt_model)
    for secs in (2, 5):
        a = (np.random.randn(SR * secs) * 0.01).astype(np.float32)
        t = time.perf_counter(); stt.transcribe(a); dt = time.perf_counter() - t
        print(f"STT parakeet {secs}s audio: {dt * 1000:.0f} ms")
    samples = {
        "en": "Sure, here's the short version: plants turn sunlight into sugar.",
        "fi": "Selvä, lyhyesti: kasvit muuttavat auringonvalon sokeriksi.",
        "mix": "Okei, eli tämä function palauttaa promisen, ja sitten awaitataan se.",
    }
    for engine in sorted({args.tts_en, args.tts_fi, "voxcpm2", "kokoro"}):
        try:
            r = TTSRouter(en=engine, fi=engine, voice_ref=args.voice_ref, voxcpm_model=args.voxcpm_model, timesteps=args.timesteps)
            r.warmup()
        except Exception as e:
            print(f"TTS {engine}: unavailable ({e})")
            continue
        for k, text in samples.items():
            if engine == "kokoro" and k != "en":
                continue
            res = r.synth(text, "fi" if k != "en" else "en")
            dur = len(res.audio) / res.sr
            print(f"TTS {engine:8s} {k:3s}: first audio {res.first_audio_s * 1000:5.0f} ms · total {res.total_s:5.2f}s · "
                  f"audio {dur:4.1f}s · speed {dur / res.total_s:4.2f}x realtime")
    print("\nRule of thumb: speed >= 1.3x realtime and first audio < 400 ms feels instant.")


def parse():
    ap = argparse.ArgumentParser("vocalo-speech")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--stt-model", default="mlx-community/parakeet-tdt-0.6b-v3")
    ap.add_argument("--tts-en", default="voxcpm2", choices=["voxcpm2", "kokoro"])
    ap.add_argument("--tts-fi", default="voxcpm2", choices=["voxcpm2"])
    ap.add_argument("--voxcpm-model", default="mlx-community/VoxCPM2-8bit")
    ap.add_argument("--timesteps", type=int, default=7, help="VoxCPM2 diffusion steps (lower = faster)")
    ap.add_argument("--voice-ref", default=None, help="reference wav for the voice (auto-designed if missing)")
    ap.add_argument("--input-device", default=None)
    ap.add_argument("--vad-threshold", type=float, default=0.5)
    ap.add_argument("--stop-ms", type=int, default=200, help="pause before Smart Turn is consulted")
    ap.add_argument("--max-silence-ms", type=int, default=1200)
    ap.add_argument("--turn-threshold", type=float, default=0.5)
    ap.add_argument("--no-smart-turn", action="store_true")
    ap.add_argument("--smart-turn-path", default=None)
    ap.add_argument("--partial-every", type=float, default=0.35)
    ap.add_argument("--max-utterance-s", type=float, default=30)
    ap.add_argument("--no-barge-in", dest="barge_in", action="store_false")
    ap.add_argument("--barge-threshold", type=float, default=0.8, help="stricter VAD while Vocalo talks (no AEC)")
    ap.add_argument("--barge-frames", type=int, default=8, help="~256 ms of speech to interrupt")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--list-devices", action="store_true")
    return ap.parse_args()


def main():
    args = parse()
    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices())
        return
    if args.bench:
        return bench(args)
    asyncio.run(Sidecar(args).main())


if __name__ == "__main__":
    main()
