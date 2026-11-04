"""Run: python -m pytest sidecar/tests  (no audio hardware or models needed)."""
import asyncio
import sys
import threading
import time
import types
from types import SimpleNamespace

import numpy as np

# fake audio device
sd = types.ModuleType("sounddevice")


class _Stream:
    def __init__(self, **kw):
        self.cb = kw.get("callback")

    def start(self):
        pass


sd.OutputStream = sd.InputStream = _Stream
sys.modules["sounddevice"] = sd

from vocalo_speech import engines  # noqa: E402
from vocalo_speech.server import FRAME, Player, Sidecar  # noqa: E402


def test_gpu_lane_runs_final_before_queued_partials():
    order, gate = [], threading.Event()
    lane = engines.LANE
    blocker = threading.Thread(target=lambda: lane.run(lambda: gate.wait(), engines.P_BG))
    blocker.start()
    time.sleep(0.05)  # lane is now busy
    ts = [threading.Thread(target=lambda n=n, p=p: lane.run(lambda: order.append(n), p))
          for n, p in [("partial", engines.P_PARTIAL), ("tts", engines.P_TTS), ("final", engines.P_FINAL)]]
    for t in ts:
        t.start()
        time.sleep(0.02)
    gate.set()
    for t in ts + [blocker]:
        t.join()
    assert order == ["final", "tts", "partial"]


class FakeSTT:
    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, prio=0):
        self.calls += 1
        time.sleep(0.03)
        return f"words{len(audio) // FRAME}"


def make_sidecar(turn_prob=0.9):
    args = SimpleNamespace(input_device=None, vad_threshold=0.5, barge_threshold=0.8, barge_frames=8, barge_in=True,
                           stop_ms=200, max_silence_ms=1200, turn_threshold=0.5, partial_every=10.0,
                           max_utterance_s=30)
    sc = Sidecar(args)
    sc.vad = SimpleNamespace(prob=lambda f: float(f[0]), reset=lambda: None)
    sc.turn = SimpleNamespace(complete_prob=lambda a: turn_prob)
    sc.stt = FakeSTT()
    sc.player = SimpleNamespace(active=False)
    events = []
    sc.emit = lambda t, p=None: events.append((t, p or {}))
    return sc, events


async def _drive(sc, frames, settle=0.5):
    sc.loop = asyncio.get_running_loop()
    task = asyncio.create_task(sc.listen())
    for f in frames:
        sc.frames.put_nowait(f)
    await asyncio.sleep(settle)
    task.cancel()


def frames(spec):
    out = []
    for val, n in spec:
        out += [np.full(FRAME, val, np.float32)] * n
    return out


def test_turn_complete_reuses_speculative_transcript():
    sc, ev = make_sidecar(turn_prob=0.9)
    asyncio.run(_drive(sc, frames([(0.0, 3), (0.9, 30), (0.0, 12)])))
    finals = [p for t, p in ev if t == "final"]
    assert len(finals) == 1 and finals[0]["text"].startswith("words")
    assert sc.stt.calls == 1  # the speculative run WAS the final


def test_incomplete_turn_waits_then_finalizes_on_max_silence():
    sc, ev = make_sidecar(turn_prob=0.1)
    asyncio.run(_drive(sc, frames([(0.9, 30), (0.0, 45)])))
    finals = [p for t, p in ev if t == "final"]
    assert len(finals) == 1
    assert sc.stt.calls == 1  # still reused: only silence followed the cut


def test_resumed_speech_discards_speculation():
    sc, ev = make_sidecar(turn_prob=0.1)
    asyncio.run(_drive(sc, frames([(0.9, 20), (0.0, 8), (0.9, 20), (0.0, 45)])))
    finals = [p for t, p in ev if t == "final"]
    assert len(finals) == 1
    assert finals[0]["text"] == "words55"  # 20+8+20 speech + 7 pause frames: the 2nd cut, not the stale 1st


def test_hold_to_talk_works_in_hands_free_mode():
    sc, ev = make_sidecar()
    sc.mode = "vad"

    async def run():
        sc.loop = asyncio.get_running_loop()
        task = asyncio.create_task(sc.listen())
        sc.player = SimpleNamespace(active=False, stop=lambda: None)
        sc.ptt_active = True
        for f in frames([(0.0, 20)]):  # quiet speech: VAD would ignore it, PTT must not
            sc.frames.put_nowait(f)
        await asyncio.sleep(0.2)
        sc.ptt_active = False
        sc.frames.put_nowait(np.zeros(FRAME, np.float32))
        await asyncio.sleep(0.3)
        task.cancel()

    sc.stop_speaking = lambda: None
    asyncio.run(run())
    finals = [p for t, p in ev if t == "final"]
    assert len(finals) == 1 and finals[0]["text"] == "words20"


def test_player_streams_and_signals():
    ev = []
    p = Player(lambda t, d=None: ev.append((t, (d or {}).get("id"))))
    out = np.zeros((480, 1), np.float32)
    p.enqueue("1.1", "Hello")
    p.append("1.1", np.ones(4800, np.float32) * 0.1, 48000)
    p.finish("1.1")
    for _ in range(15):
        p.stream.cb(out, 480, None, None)
    assert ev == [("say_start", "1.1"), ("say_end", "1.1"), ("idle", None)]
