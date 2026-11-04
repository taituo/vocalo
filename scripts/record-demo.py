#!/usr/bin/env python3
"""Record a short demo video of the stage (mock agent, fake voice levels).

    python3 scripts/record-demo.py [out.mp4]
Needs: playwright (pip), Chrome/Chromium, ffmpeg. No mic, models or Kiro.
"""
import glob, json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "vocalo-demo.mp4")
PORT = 8798
chrome = shutil.which("google-chrome") or shutil.which("chromium") or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp = "/tmp/vocalo-rec"
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp)
cfg = os.path.join(tmp, "cfg.json")
json.dump({"ui": {"eventsPort": PORT, "open": False}}, open(cfg, "w"))
env = dict(os.environ, MOCK_DELAY="70", MOCK_WORK_STEPS="45", MOCK_FIRST_DELAY="900")
proc = subprocess.Popen(["node", "src/index.js", "--config", cfg, "--no-speech", "--agent", "node test/mock-agent.js"],
                        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
url = f"http://127.0.0.1:{PORT}"
for _ in range(100):
    try:
        urllib.request.urlopen(url + "/state", timeout=0.3)
        break
    except Exception:
        time.sleep(0.1)


def cmd(o):
    req = urllib.request.Request(url + "/command", data=json.dumps(o).encode(), method="POST", headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=2)


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = b.new_context(viewport={"width": 960, "height": 584}, record_video_dir=tmp, record_video_size={"width": 960, "height": 584})
        pg = ctx.new_page()
        pg.goto(url + "/?lite"); time.sleep(3.0)                                   # idle: breathing, blinking
        pg.mouse.move(100, 120); time.sleep(0.8); pg.mouse.move(860, 450); time.sleep(0.8)  # follows the pointer
        cmd({"type": "text", "text": "Explain photosynthesis"}); time.sleep(6.5)    # thinks, then talks (lip movement)
        pg.keyboard.press("c"); time.sleep(0.5)
        cmd({"type": "text", "text": "refactor the loop"}); time.sleep(5.5)         # thinking + plan, glances at the diff
        pg.keyboard.down("Space"); time.sleep(1.6); pg.keyboard.up("Space"); time.sleep(1.2)  # push-to-talk: listening
        ctx.close()
        b.close()
finally:
    proc.terminate()

vid = glob.glob(f"{tmp}/*.webm")[0]
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", vid, "-vf", "fps=24", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], check=True)
print("saved", OUT)
