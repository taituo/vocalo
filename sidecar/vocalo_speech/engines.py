"""Speech engines for Vocalo, all local on Apple Silicon.

STT : Parakeet TDT 0.6B v3 (MLX)            25 EU languages incl. Finnish, auto language
VAD : Silero VAD v5 (ONNX, CPU)              32 ms frames
Turn: Pipecat Smart Turn v3.2 (ONNX, CPU)    "is the user done?" ~40 ms, audio-only, multilingual
TTS : VoxCPM2 (MLX, 30 langs incl. Finnish)  one consistent designed/cloned female voice for EN+FI+mixed
      Kokoro-82M (MLX)                       very fast English-only fallback (af_heart)

Library APIs move fast; every call that depends on an upstream signature goes
through `_call` which drops kwargs the installed version does not accept.
"""
from __future__ import annotations

import inspect
import os
import tempfile
import threading
import time
from pathlib import Path

import numpy as np

SR = 16000

# Priorities on the GPU lane (lower runs first)
P_FINAL, P_TTS, P_PARTIAL, P_BG = 0, 1, 2, 3


class GpuLane:
    """All MLX work runs on ONE thread, in priority order.

    Why: MLX arrays/streams are not safe to share across ad-hoc threads, and STT and
    TTS fighting over the GPU makes both slow. A final transcript (the user just
    stopped talking) must never wait behind a partial or a whole TTS sentence,
    so TTS advances one generator step per job and a final can cut in between."""

    def __init__(self):
        import itertools, queue
        self.q = queue.PriorityQueue()
        self.seq = itertools.count()
        self.thread = threading.Thread(target=self._loop, name="gpu-lane", daemon=True)
        self.thread.start()

    def _loop(self):
        while True:
            _, _, fn, box, done = self.q.get()
            try:
                box["result"] = fn()
            except BaseException as e:  # noqa: BLE001 - re-raised in caller
                box["error"] = e
            done.set()

    def run(self, fn, prio=P_BG):
        if threading.current_thread() is self.thread:
            return fn()  # re-entrant (e.g. warm-up inside a job)
        box, done = {}, threading.Event()
        self.q.put((prio, next(self.seq), fn, box, done))
        done.wait()
        if "error" in box:
            raise box["error"]
        return box.get("result")


LANE = GpuLane()


def _call(fn, *args, **kwargs):
    try:
        params = inspect.signature(fn).parameters
        if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
            kwargs = {k: v for k, v in kwargs.items() if k in params}
    except (TypeError, ValueError):
        pass
    return fn(*args, **kwargs)


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(audio) == 0:
        return audio.astype(np.float32)
    try:
        import soxr
        return soxr.resample(audio, src, dst).astype(np.float32)
    except ImportError:
        n = int(round(len(audio) * dst / src))
        return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


# ---------------------------------------------------------------- VAD
class SileroVAD:
    def __init__(self):
        from silero_vad import load_silero_vad
        import torch
        self.torch = torch
        self.model = load_silero_vad(onnx=True)

    def prob(self, frame512: np.ndarray) -> float:
        return float(self.model(self.torch.from_numpy(frame512), SR).item())

    def reset(self):
        try:
            self.model.reset_states()
        except Exception:
            pass


# ---------------------------------------------------------------- Smart Turn
class SmartTurn:
    """Smart Turn v3.2 ONNX with the Whisper front-end embedded (soniqo export):
    feed raw 16 kHz PCM (last <= 8 s), get P(turn complete)."""

    REPO = "soniqo/Smart-Turn-v3.2-ONNX"
    FILE = "smart-turn-v3.2-int8.onnx"

    def __init__(self, path: str | None = None):
        import onnxruntime as ort
        if not path:
            from huggingface_hub import hf_hub_download
            path = hf_hub_download(self.REPO, self.FILE)
        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self.sess = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0]

    def complete_prob(self, audio: np.ndarray) -> float:
        a = audio[-8 * SR:].astype(np.float32)
        shape = self.inp.shape
        if len(shape) == 2 and isinstance(shape[1], int):  # fixed-length input: left-pad to 8 s
            n = shape[1]
            a = np.pad(a, (max(0, n - len(a)), 0))[-n:]
        out = self.sess.run(None, {self.inp.name: a[None, :]})[0]
        return float(np.asarray(out).reshape(-1)[0])


# ---------------------------------------------------------------- STT
class ParakeetSTT:
    def __init__(self, model_id: str = "mlx-community/parakeet-tdt-0.6b-v3"):
        from parakeet_mlx import from_pretrained
        self.model = LANE.run(lambda: from_pretrained(model_id))
        self.transcribe(np.zeros(SR // 2, dtype=np.float32))  # warm-up / compile

    def transcribe(self, audio: np.ndarray, prio: int = P_FINAL) -> str:
        if len(audio) < SR * 0.2:
            return ""
        return LANE.run(lambda: self._transcribe(audio), prio)

    def _transcribe(self, audio: np.ndarray) -> str:
        try:
            import mlx.core as mx
            from parakeet_mlx.audio import get_logmel
            mel = get_logmel(mx.array(audio.astype(np.float32)), self.model.preprocessor_config)
            res = self.model.generate(mel)
            res = res[0] if isinstance(res, (list, tuple)) else res
            return res.text.strip()
        except (ImportError, AttributeError, TypeError):
            # fallback: file-based API
            import soundfile as sf
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                sf.write(f.name, audio, SR)
                try:
                    return self.model.transcribe(f.name).text.strip()
                finally:
                    os.unlink(f.name)


# ---------------------------------------------------------------- TTS
class TTSResult:
    def __init__(self, audio: np.ndarray, sr: int, first_audio_s: float, total_s: float):
        self.audio, self.sr, self.first_audio_s, self.total_s = audio, sr, first_audio_s, total_s


class _MlxAudioTTS:
    model_id = ""

    def __init__(self, model_id: str | None = None):
        try:
            from mlx_audio.tts.utils import load_model
        except ImportError:
            from mlx_audio.tts import load_model
        self.model = LANE.run(lambda: load_model(model_id or self.model_id))
        self.sr = int(getattr(self.model, "sample_rate", 24000))

    def _gen_kwargs(self, text: str, lang: str) -> dict:
        return {}

    def stream(self, text: str, lang: str = "en"):
        """Yield (audio_piece, sample_rate). Uses mlx-audio's incremental mode when the
        installed version supports it, so playback can start before the chunk is done."""
        kw = dict(stream=True, streaming_interval=0.4, **self._gen_kwargs(text, lang))
        gen = LANE.run(lambda: _call(self.model.generate, text=text, **kw), P_TTS)
        done = object()
        while True:
            # one step per lane job, so a final STT can cut in between pieces
            r = LANE.run(lambda: next(gen, done), P_TTS)
            if r is done:
                return
            self.sr = int(getattr(r, "sample_rate", self.sr) or self.sr)
            yield np.asarray(r.audio, dtype=np.float32).reshape(-1), self.sr

    def synth(self, text: str, lang: str = "en") -> TTSResult:
        t0 = time.perf_counter()
        first, parts = None, []
        for a, _ in self.stream(text, lang):
            if first is None:
                first = time.perf_counter() - t0
            parts.append(a)
        audio = np.concatenate(parts) if parts else np.zeros(0, np.float32)
        return TTSResult(audio, self.sr, first or 0.0, time.perf_counter() - t0)


class VoxCPM2TTS(_MlxAudioTTS):
    """One voice identity for every language: we *design* the voice once from a text
    description, save it as a reference clip, then clone from it on every call so
    the voice never drifts between sentences or between Finnish and English."""

    model_id = "mlx-community/VoxCPM2-8bit"
    VOICE_DESC = "A young woman in her late twenties, warm, bright and friendly, clear articulation, natural conversational pace, like a TV presenter"
    REF_TEXT = "Hi, I'm Vocalo. Hei, minä olen Vocalo. Let's talk about anything you like."

    def __init__(self, model_id=None, voice_ref: str | None = None, timesteps: int = 7, cfg: float = 2.0,
                 voice_desc: str | None = None):
        super().__init__(model_id)
        self.timesteps, self.cfg = timesteps, cfg
        if voice_desc:  # a profile's own voice: designed once, cached by prompt hash
            import hashlib
            self.VOICE_DESC = voice_desc
            name = "voice_" + hashlib.sha1(voice_desc.encode()).hexdigest()[:10] + ".wav"
        else:
            name = "vocalo_ref.wav"
        self.ref = Path(voice_ref or Path(__file__).resolve().parent.parent / "voices" / name)
        self.ref_text = self.REF_TEXT
        if not self.ref.exists():
            self._design_voice()
        txt = self.ref.with_suffix(".txt")
        if txt.exists():
            self.ref_text = txt.read_text().strip()

    def _design_voice(self):
        import soundfile as sf
        self.ref.parent.mkdir(parents=True, exist_ok=True)
        def design():
            return [np.asarray(r.audio, dtype=np.float32).reshape(-1)
                    for r in _call(self.model.generate, text=self.REF_TEXT, instruct=self.VOICE_DESC,
                                   inference_timesteps=10, cfg_value=self.cfg)]
        parts = LANE.run(design)
        sf.write(self.ref, np.concatenate(parts), self.sr)
        self.ref.with_suffix(".txt").write_text(self.REF_TEXT)

    def _gen_kwargs(self, text, lang):
        return dict(ref_audio=str(self.ref), ref_text=self.ref_text,
                    inference_timesteps=self.timesteps, cfg_value=self.cfg)


class KokoroTTS(_MlxAudioTTS):
    model_id = "mlx-community/Kokoro-82M-bf16"

    def __init__(self, model_id=None, voice: str = "af_heart", speed: float = 1.05):
        super().__init__(model_id)
        self.voice, self.speed = voice, speed

    def _gen_kwargs(self, text, lang):
        return dict(voice=self.voice, speed=self.speed, lang_code="a")


class TTSRouter:
    """Routes each chunk to an engine by language. Kokoro is English-only."""

    def __init__(self, en: str = "voxcpm2", fi: str = "voxcpm2", voice_ref: str | None = None,
                 voxcpm_model: str | None = None, timesteps: int = 7, voice_desc: str | None = None):
        self.engines = {}
        make = {
            "voxcpm2": lambda: VoxCPM2TTS(voxcpm_model, voice_ref=voice_ref, timesteps=timesteps, voice_desc=voice_desc),
            "kokoro": lambda: KokoroTTS(),
        }
        for name in {en, fi}:
            self.engines[name] = make[name]()
        self.route = {"en": en, "fi": fi}

    def engine(self, lang: str):
        return self.engines[self.route.get(lang, self.route["en"])]

    def stream(self, text: str, lang: str = "en"):
        return self.engine(lang).stream(text, lang)

    def synth(self, text: str, lang: str = "en") -> TTSResult:
        return self.engine(lang).synth(text, lang)

    def warmup(self):
        for lang in set(self.route):
            self.synth("Okei." if lang == "fi" else "Okay.", lang)
