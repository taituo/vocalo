// Open the stage as an app-like window without Electron:
//   1. a built Tauri app (desktop/), if present        -> small native window (WKWebView)
//   2. Chrome / Edge / Brave / Chromium in --app mode    -> chromeless window, separate profile
//   3. the default browser                               -> tab
// On macOS, Safari's File > "Add to Dock" also turns the page into a Dock app with zero tooling.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Arc.app/Contents/MacOS/Arc',
];
const LINUX_BROWSERS = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];

function which(cmd) { try { return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; } }

export function findTauriApp() {
  const cands = [
    join(ROOT, 'desktop/src-tauri/target/release/bundle/macos/Vocalo.app'),
    join(ROOT, 'desktop/src-tauri/target/release/vocalo-desktop'),
    '/Applications/Vocalo.app',
  ];
  return cands.find((p) => existsSync(p)) ?? null;
}

export function findAppBrowser() {
  if (platform() === 'darwin') return MAC_BROWSERS.find((p) => existsSync(p)) ?? null;
  return LINUX_BROWSERS.map(which).find(Boolean) ?? null;
}

/** @returns {{how: string, proc?: import('node:child_process').ChildProcess}} */
export function openStage(url, { prefer = 'auto', kiosk = false } = {}) {
  const detached = { detached: true, stdio: 'ignore' };
  const tauri = prefer === 'browser' ? null : findTauriApp();
  if (tauri) {
    const proc = tauri.endsWith('.app') ? spawn('open', ['-a', tauri, '--args', url], detached) : spawn(tauri, [url], { ...detached, env: { ...process.env, VOCALO_URL: url } });
    proc.unref(); return { how: `tauri ${tauri}`, proc };
  }
  const browser = prefer === 'tab' ? null : findAppBrowser();
  if (browser) {
    const dir = join(homedir(), '.vocalo', 'app-profile'); // own profile: no tabs, no extensions, remembers mic-free permissions
    mkdirSync(dir, { recursive: true });
    const args = [`--app=${url}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
      '--autoplay-policy=no-user-gesture-required', ...(kiosk ? ['--kiosk'] : [])];
    const proc = spawn(browser, args, detached); proc.unref();
    return { how: `app window (${browser.split('/').pop()})`, proc };
  }
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  const proc = spawn(opener, [url], detached); proc.unref();
  return { how: 'default browser' };
}
