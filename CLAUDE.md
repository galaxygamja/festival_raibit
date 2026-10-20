# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current status: v2.1.2

The v1→v2 migration (2-player Arduino contest → 1-player record mode fed by a SpikerBox) is code-complete and documented in `PLAN.md` (Phases 1–4 and checklist steps 1–10 done). **Only step 11, the on-site hardware test, remains**: real SpikerBox/EMG, macOS 222222 baud, calibration default, START Arduino, Windows exe. Update PLAN.md first if that testing changes a decision.

## Commands

```bash
npm install
npm start                    # real hardware, kiosk fullscreen
npm run sim                  # no hardware: electron . --sim
npx electron . --sim --windowed   # windowed; --fullscreen forces fullscreen
npm test                     # node test/game.test.js (plain node, no framework)
npm run build:win            # portable + nsis (x64) -> dist/
npm run build:mac            # dmg, arm64 + x64 -> dist/ (both builds can run on macOS)
npx electron-builder --mac dir --arm64   # fast unpacked build -> dist/mac-arm64/raibitScoreboard.app
```

To run a dev copy without touching the real data or colliding with an installed copy (single-instance lock is per userData dir), pass a scratch data dir: `npx electron . --sim --windowed --user-data-dir=<tmp>`. Otherwise sim results are written into the real `~/Library/Application Support/raibitScoreboard`. Add `--remote-debugging-port=<port>` to drive the window over the Chrome DevTools Protocol for screenshots and scripted checks.

There is no lint step and no way to run a single test. `test/game.test.js` is one script that runs every case, and new tests go in it too. Sim keys: `S` (start), `A` (hold to squeeze).

## Product rules (decided with the user; not obvious from code)

- **Hardware**: EMG sensor → **SpikerBox** → laptop over USB (binary waveform). A **separate Arduino** carries only the START button (`START` line at 9600 baud, plus an `ALIVE` heartbeat every 1 s). Reading EMG directly on the Arduino was abandoned because its raw values saturated at 1/1023.
- **One player**, punch-machine style: no opponent, no winner/draw. The goal is setting a record.
- One measurement = 5 seconds from the START signal: 50 samples at 0.1 s each. There is **no judging phase**. The result appears as soon as 50 samples are in (or after the 8 s timeout).
- **One sample** = the RMS of the SpikerBox signal over a 100 ms window (time-based, not sample-count-based), after subtracting the window mean (AC RMS) and then subtracting the resting-noise RMS, times the calibration factor, clamped to 0–9999. FFT is not used. Spike Recorder's FFT is only a display feature.
- Final score = the **maximum** of the 50 samples, not the last or the average. During measurement the big number shows the **current** force, smoothly animated. The max appears in the small `측정 n / 50 · 최고` line.
- Every non-zero result is kept in `records.json` as `{id, name, score, at}`; the hall of fame is derived as the top 5 (score desc, earlier record wins ties), and the result screen shows the overall place (`place`/`total`). 0 points are never recorded. New entries are named `ㅇㅇㅇ`. In the admin screen the operator can view all records ("전체 기록 보기"), edit any name **and score**, delete single records (✕), or "기록 전체 삭제" (backs up as `records.json.bak-<time>`, returns the game to IDLE).
- **Main screen layout** (accepted by the user; PLAN.md §5.1 describes an earlier idea): two 15-step level gauges on the left and right edges, and between them the banner (state label, 7-segment score, progress or `전체 n위 / N개 기록 중`) stacked above the hall of fame. No P1/P2 panels.
- Admin screen shortcut is `Ctrl+D` on Windows and `Control+D` on macOS (not Cmd), and F11 toggles fullscreen. Keys are matched by `e.code` so they work with a Korean IME active. A teammate's v1-based commit (`bb10e34`: `run.bat`, auto-launching Geometry Dash, a hidden-corner admin entry instead of Ctrl+D) was deliberately discarded; do not reintroduce those.
- Bump the `package.json` version on every user-visible change (the user checks for this). The v2 migration ships as `2.0.0`.
- The user communicates in Korean; keep UI text and replies in Korean.

## Architecture

Electron app, two processes, no bundler. UI is fixed at 1440×900 design pixels and scaled to the window by `fit()` in `src/renderer/app.js`.

- **Main process** (`src/main/`) owns all state and timing. `main.js` wires everything. It ticks the game every 50 ms and pushes a single `payload` (`game, hall, ports, settings, sim, platform, fullscreen, ...`) to the renderer only when it changed. The renderer holds no authoritative state.
- `serial.js` opens every USB serial port, rescans every 2 s, and skips non-USB ports (Bluetooth etc.). It never routes by port name.
  - Each new port is first probed as a SpikerBox: 222222 then 500000 baud, sending `b:;` and looking for an `HWT` message or ≥20 frames with ≥90% channel-vote confidence. If both fail, the port opens as a 9600 text port (`START`, `ALIVE`). Port roles can also be fixed by hand in the admin screen (`settings.portRoles`), keyed by `usb:<vid>:<pid>:<serial>` when the port has a USB serial number (so a COM number change keeps the role) and by path otherwise.
- `hid.js` is the USB **HID** transport for SpikerBox Pro (vendor `0x2E73`, HWT `MUSCLESB`, 10-bit values around 512, 2 channels, 10 kHz; verified on real hardware over USB-C, no serial port appears). Reports are 64 bytes `[0x3F, len, payload…]` (payload goes to `SpikerBoxParser`); commands are `[0x3F,0x3E,text,0-pad]` (`?:; max:; board:; start:;`, `h:;` on close). `serial.js` scans HID devices in the same loop and keys them as `hid:<path>`. `node-hid` is in `asarUnpack`. `pickDevices` accepts any product ID and keeps one entry per device (vendor usagePage `0xFF00` preferred, deduped by `deviceKey` = vid:pid:serial). Each scan also closes HID entries whose path vanished (replug into another USB port), resends `start:;` after 2 s without frames and reopens after 3 s more, and backs off failed opens 2→4→8→10 s, surfacing `ports.openError` in the admin screen (usually Spike Recorder holding the device). `SerialManager` takes `hidApi`/`listSerial`/`now` so tests drive it with a fake HID.
- `spikerbox.js` parses the SpikerBox stream. A frame-start byte has bit 0x80 set, and the value is `((b0&0x7F)<<7)|(b1&0x7F)` per channel. Messages sit between escape markers `FF FF 01 01 80 FF` … `FF FF 01 01 81 FF` as `type:value;`. `emg.js` turns samples into the 100 ms score. Both are pure and testable, and PLAN.md §1–2 has the details.
- `game.js` is a pure state machine (IDLE → MEASURING → RESULT) that takes `now` as an argument so tests can drive the clock. The calibration factor is applied per sample in `toScore`.
- `sim.js` replaces the hardware: it emits a fake SpikerBox byte stream, so it exercises the real parser and RMS path. For demos it uses the 14-bit range (center 8192) and picks a random strength per `A` press, so scores land around 4000–7500 at calibration 1 and the level gauges light up.
- `hall.js` holds the pure record/ranking rules (`addResult`, `hallOf`, `editRecords`, `deleteRecords`, `migrateRecords`). `store.js` persists `settings.json` and `records.json` in `userData`: write temp → fsync → rename, retry on Windows EPERM/EBUSY, and move unreadable files to `*.corrupt-<time>`. `normalizeSettings` migrates the v1 `calibration: {p1, p2}`. When `records.json` is missing, `main.js` migrates the v2.0.x `hall-of-fame.json` + `score-history.json` once (old files are left in place), and `normalizeRecords` drops the v1 `player` field.
- The full record list is not in the pushed payload (it can be large). The payload carries `hall` (top 5), `recordsRev`, and `recordsTotal`; the admin screen calls `records:get` when `recordsRev` changes.
- **Renderer** (`src/renderer/`) is plain HTML/JS under a strict CSP (`self` only). It talks to main only through `window.api` defined in `src/preload.js` (contextIsolation + sandbox). Adding a feature that needs main usually means three edits: an IPC handler in `main.js`, a method in `preload.js`, and a call in `app.js`.
- A `requestAnimationFrame` loop in `app.js` exponentially smooths displayed numbers (`SMOOTH_MS`). The 7-segment digits come from `segments.js`.
- `arduino/start_button/start_button.ino` is the START button sketch (INPUT_PULLUP, debounced, `START` on press, `ALIVE` every 1 s).

## Reference code

- Two remotes: `origin` = https://github.com/dohye0508/Spike-Recorder (this app on its `scoreboard` branch; never push to `master` or other branches there) and `old` = https://github.com/galaxygamja/festival_raibit, whose `main` was fast-forwarded to the current `scoreboard` (2.1.1) so the app can live without the huge Spike Recorder source. Which one is canonical going forward is the user's call; push only where asked.
- That repo's `master` is a fork of Backyard Brains' Spike Recorder (C++/SDL), with only the README translated relative to upstream. It is a reference for the SpikerBox protocol only: `src/engine/ArduinoSerial.cpp` (frame parser around line 1950, sample rates by device in `setSampleRateAndNumberOfChannelsBasedOnType`, `HWT` names around line 2590, commands around line 2910). Do not vendor or build it.
- Spike Recorder and this app cannot hold the same serial port at once.

## Build notes

- `serialport` ships N-API prebuilds, so `npmRebuild: false` is set in the electron-builder config (rebuilding fails on machines without node-gyp/distutils). `@serialport/bindings-cpp` must stay in `asarUnpack`.
- Only one app instance runs (single-instance lock) so two copies never fight over serial ports.
- Do Hyeon font is bundled in `src/renderer/fonts/` (OFL); the app must work offline.

## Gotchas

- The renderer rebuilds admin rows whenever the records change. `renderAdminRows` preserves what the user is typing (per record id and field), so keep that when changing it.
- The banner text is fixed at 980 px with `nowrap` because it previously wrapped the last Korean character onto a second line.
- `design/` and `design/claude-code-prompt.md` are the **initial** spec. The behavior above (immediate result, max score, Ctrl+D, app name, and v2's single player and SpikerBox) supersedes them. PLAN.md is the v2 migration plan; where it differs from this file (screen layout, `hall-of-fame.json`/`score-history.json`, which `records.json` replaced in v2.1.0), this file wins.
- Non-standard baud 222222 on macOS through node `serialport` is unverified (PLAN.md §9).
- Real SpikerBox Pro (HID, `MUSCLESB`) opens and streams in dev and packaged builds, but it is 10-bit (rest ≈ 512) while `--sim` is 14-bit, so the default calibration 1.0 is untuned for real scores. Not yet verified: scoring with a real EMG sensor, the START Arduino, running the exe on real Windows, the fullscreen/window toggle in a live run.
