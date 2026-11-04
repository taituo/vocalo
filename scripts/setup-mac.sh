#!/usr/bin/env bash
# One-time setup on Apple Silicon. Needs: Node 22+, uv (brew install uv), Kiro CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
uv venv --python 3.12 sidecar/.venv
uv pip install --python sidecar/.venv/bin/python -r sidecar/requirements.txt
[ -f vocalo.config.json ] || cp vocalo.config.example.json vocalo.config.json
echo "Downloading + warming models (Parakeet v3, Silero, Smart Turn, VoxCPM2; designs the Vocalo voice once)…"
(cd sidecar && .venv/bin/python -m vocalo_speech.server --bench)
cat <<MSG

Done. Next:
  1. edit vocalo.config.json (kiro-cli full path: \`which kiro-cli\`, project cwd)
  2. copy steering:  mkdir -p <project>/.kiro/steering && cp steering/vocalo.md <project>/.kiro/steering/
  3. run:            npm start            (stage opens as an app window; just talk)
  Text-only demo:    npm run demo
  Native window:     npm run desktop:build   (optional, needs Rust: brew install rust)
  Remote Kiro:       node src/index.js --remote me@box:/path --doctor
MSG
