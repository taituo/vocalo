#!/usr/bin/env python3
"""Drive the web stage with headless Chrome against the mock agent and save screenshots.

    python3 scripts/ui-snapshot.py [outdir]
Needs: playwright (pip) and a Chrome/Chromium. No mic, no models, no Kiro.
"""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "screens")
PORT = 8799
os.makedirs(OUT, exist_ok=True)
chrome = shutil.which("google-chrome") or shutil.which("chromium") or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

env = dict(os.environ, MOCK_DELAY="45", MOCK_WORK_STEPS="25")
cfg = os.path.join(OUT, "_cfg.json")
json.dump({"ui": {"eventsPort": PORT, "open": False}}, open(cfg, "w"))
proc = subprocess.Popen(["node", "src/index.js", "--config", cfg, "--no-speech", "--agent", "node test/mock-agent.js"],
                        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
url = f"http://127.0.0.1:{PORT}"
for _ in range(100):
    try: urllib.request.urlopen(url + "/state", timeout=0.3); break
    except Exception: time.sleep(0.1)

def cmd(obj):
    req = urllib.request.Request(url + "/command", data=json.dumps(obj).encode(), headers={"content-type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=2)

errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 1280, "height": 760}, device_scale_factor=1)
        pg.set_default_timeout(90000)
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url + ("?lite" if os.environ.get("LITE", "1") == "1" else "")); time.sleep(2.5)
        pg.screenshot(path=f"{OUT}/1-idle.png")
        cmd({"type": "text", "text": "Explain photosynthesis"}); time.sleep(0.9)
        pg.screenshot(path=f"{OUT}/2-speaking.png")
        time.sleep(2.2)
        pg.screenshot(path=f"{OUT}/3-code.png")
        pg.keyboard.press("c"); time.sleep(0.3)
        cmd({"type": "text", "text": "refactor the loop"}); time.sleep(0.6)
        pg.screenshot(path=f"{OUT}/4-plan-working.png")
        time.sleep(2.0)
        pg.screenshot(path=f"{OUT}/5-diff.png")
        cmd({"type": "command", "line": "sessions"}); time.sleep(0.5)
        pg.screenshot(path=f"{OUT}/6-sessions.png")
        pg.keyboard.press("Escape"); time.sleep(0.2)
        cmd({"type": "text", "text": "please delete the build folder"}); time.sleep(0.8)
        pg.screenshot(path=f"{OUT}/7-permission.png")
        pg.keyboard.press("n"); time.sleep(0.8)
        pg.keyboard.press("r"); pg.keyboard.down("Space"); time.sleep(0.6)
        pg.screenshot(path=f"{OUT}/8-ptt-4x3.png")
        pg.keyboard.up("Space")
        webgl = pg.evaluate("!document.documentElement.classList.contains('no-webgl')")
        b.close()
finally:
    proc.terminate()
    try: os.remove(cfg)
    except OSError: pass
print("webgl:", webgl, "| console errors:", errors or "none")
print("saved to", OUT)
