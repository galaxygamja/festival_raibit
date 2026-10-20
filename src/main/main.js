'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker, shell, dialog } = require('electron');
const { Game, scoreOf, pctOf, DEFAULT_SCORE, CURVE_PRESETS } = require('./game');
const hall = require('./hall');
const { Store, normalizeSettings } = require('./store');
const { SerialManager } = require('./serial');
const { EmgWindow, EmgFilter, RestMeter, strengthOf } = require('./emg');
const { Simulator } = require('./sim');
const { Diag } = require('./diag');
const { Recorder } = require('./recorder');
const { AutoCal } = require('./calib');

const argv = process.argv.slice(1);
const START_SIM = argv.includes('--sim');
// 시작 화면: --windowed / --fullscreen 이 있으면 그걸 따르고, 없으면 마지막으로 고른 방식(settings.fullscreen)
const FORCE_WINDOWED = argv.includes('--windowed');
const FORCE_FULLSCREEN = argv.includes('--fullscreen');
const IS_MAC = process.platform === 'darwin';

if (!app.requestSingleInstanceLock()) {
  // 두 개가 뜨면 시리얼 포트를 서로 뺏으므로 하나만 실행
  app.quit();
}

let win = null;
let store, settings, records, hallTop = [], recordsRev = 0, lastResult = null, game, serial, sim;
const emgWin = new EmgWindow(); // 거른 신호 (점수용)
const rawWin = new EmgWindow(); // 거르기 전 신호 (진단 화면 비교용)
const emgFilter = new EmgFilter();
const rest = new RestMeter(3000);
const autocal = new AutoCal(); // 관리자 3페이지 자동 보정 (쉼 → 최대 힘)
let live = { raw: null, rms: 0, rmsRaw: 0, strength: 0, score: 0 };
let lastRaw = null; // 선택 채널의 마지막 원시값 (관리자 화면 확인용)
const diag = new Diag();
let diagOn = false; // 관리자 2페이지가 열려 있을 때만 진단 정보를 payload 에 싣는다
let recorder = null; // 관리자 2페이지 녹화 (userData/recordings)
const startedAt = Date.now();
// 도전자 이름: nextName = 다음 측정에 쓸 이름 (Control+F 로 입력), currentName = 지금 측정 중인 사람, namePrompt = START 가 눌렸는데 이름이 없어 입력창을 띄운 상태
let nextName = null, currentName = null, namePrompt = false;

// 최근 로그를 진단 화면에서 보이게 모아 둔다
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    logs.push({ at: Date.now(), level, text: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300) });
    if (logs.length > 60) logs.shift();
  };
}
let zeroStartedAt = 0;
const EMG_WINDOW_MS = 100;
const ZERO_TIMEOUT_MS = 10000;
const SIM_PORT = '시뮬레이션';
let lastSaveError = null;
let lastPayload = '';

function now() {
  return Date.now();
}

/** 기록이 바뀌면 저장하고, 명예의 전당(상위 5개)을 다시 계산하고, 관리자 화면이 다시 받아 가도록 rev 를 올린다 */
function setRecords(next) {
  records = next;
  hallTop = hall.hallOf(records);
  recordsRev++;
  try {
    store.saveRecords(records);
    lastSaveError = null;
  } catch (err) {
    lastSaveError = '기록 저장 실패: ' + err.message;
    console.error('[main]', lastSaveError);
  }
}

function payload() {
  const t = now();
  return {
    game: game.snapshot(t),
    result: lastResult,
    name: { next: nextName, current: currentName, prompt: namePrompt },
    hall: hallTop,
    recordsRev, // 전체 기록은 크기가 커서 payload 에 싣지 않고, 관리자 화면이 records:get 으로 받아 간다
    recordsTotal: records.length,
    ports: serial.status(t),
    emg: {
      raw: live.raw, rms: Math.round(live.rms * 10) / 10, rmsRaw: Math.round(live.rmsRaw * 10) / 10, strength: Math.round(live.strength * 10) / 10,
      score: live.score, restRms: settings.emg.restRms, margin: settings.emg.margin, zeroing: rest.running,
      pct: Math.round(pctOf(live.strength, settings.score) * 10) / 10, // 기준 힘 대비 %
    },
    settings,
    scoreDefault: DEFAULT_SCORE,
    curvePresets: CURVE_PRESETS,
    calib: autocal.status(t),
    sim: sim.enabled,
    platform: process.platform,
    fullscreen: isFullscreen(),
    saveError: lastSaveError,
    dataDir: store.dir,
    version: app.getVersion(),
    diag: diagOn ? diagPayload(t) : null,
    rec: recorder.status(t),
  };
}

function diagPayload(t) {
  return {
    signal: diag.snapshot(t),
    serial: serial.diagnostics(t),
    logs: logs.slice(-40),
    env: {
      platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node,
      uptime: Date.now() - startedAt, packaged: app.isPackaged,
    },
  };
}

/** 측정 시작. 이름 받기가 켜져 있고 이름이 없으면(관리자 버튼 제외) 시작하지 않고 이름 입력창을 띄운다 */
function requestStart(fromAdmin) {
  if (game.phase === 'measuring' || autocal.running) return;
  if (!fromAdmin && settings.askName && !nextName) {
    namePrompt = true;
    push();
    return;
  }
  startMeasure();
}

function startMeasure() {
  if (!game.start(now())) return;
  lastResult = null;
  currentName = nextName;
  nextName = null;
  namePrompt = false;
  push();
}

function cleanPersonName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || null;
}

const EXPORT_KEYS = ['score', 'askName', 'emg']; // 포트 역할·전체화면은 노트북마다 다르므로 빼고, 영점은 가져올 때 지금 값을 쓴다

function push(force) {
  if (!win || win.isDestroyed()) return;
  const p = payload();
  const s = JSON.stringify(p);
  if (!force && s === lastPayload) return;
  lastPayload = s;
  win.webContents.send('state', p);
}

function isFullscreen() {
  return !!win && !win.isDestroyed() && (win.isKiosk() || win.isFullScreen() || (IS_MAC && win.isSimpleFullScreen()));
}

function saveSettings() {
  try {
    store.saveSettings(settings);
    lastSaveError = null;
  } catch (err) {
    lastSaveError = '설정 저장 실패: ' + err.message;
  }
}

/** 전체화면(kiosk) ↔ 창 모드. 고른 방식은 다음 실행 때도 유지된다. */
// macOS 에서는 setKiosk 가 창 크기를 바꾸지 않는 경우가 있어(상태만 kiosk) 즉시 덮는 simple fullscreen 을 쓴다.
function applyFullscreen(on) {
  if (IS_MAC) {
    if (!on && win.isFullScreen()) win.setFullScreen(false); // 초록 버튼으로 들어간 전체화면
    if (win.isKiosk()) win.setKiosk(false);
    win.setSimpleFullScreen(!!on);
  } else if (on) {
    win.setKiosk(true);
  } else {
    win.setKiosk(false);
    win.setFullScreen(false);
  }
}

function setFullscreen(on) {
  if (!win || win.isDestroyed()) return;
  applyFullscreen(on);
  settings = { ...settings, fullscreen: !!on };
  saveSettings();
  push();
}

function createWindow(full) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 450,
    center: true,
    backgroundColor: '#140A09',
    kiosk: full && !IS_MAC,
    fullscreen: full && !IS_MAC,
    autoHideMenuBar: true,
    show: false,
    title: 'raibitScoreboard',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (full && IS_MAC) { win.setSimpleFullScreen(true); push(); }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => push(true));
  // macOS 초록 버튼 등으로 바뀐 경우도 화면에 반영
  win.on('enter-full-screen', () => push());
  win.on('leave-full-screen', () => push());
  win.on('closed', () => { win = null; });
}

function setupMenu() {
  if (process.platform === 'darwin') {
    // kiosk 상태에서도 Cmd+Q 로 끌 수 있게 최소 메뉴만 둔다
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [{ role: 'quit' }] },
      { role: 'editMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

function setupIpc() {
  ipcMain.handle('state:get', () => payload());
  ipcMain.handle('game:start', () => requestStart(true));
  ipcMain.handle('game:stop', () => {
    // 중지하면 이번 사람 이름은 다음 측정으로 돌려 둔다
    if (game.stop() && currentName && !nextName) nextName = currentName;
    currentName = null;
    push();
  });
  ipcMain.handle('name:set', (_e, name, startNow) => {
    nextName = cleanPersonName(name);
    const wasPrompt = namePrompt;
    namePrompt = false;
    if (startNow || wasPrompt) startMeasure();
    else push();
  });
  ipcMain.handle('name:cancel', () => { namePrompt = false; push(); });
  ipcMain.handle('settings:export', async () => {
    const r = await dialog.showSaveDialog(win, { title: '설정 내보내기', defaultPath: 'raibit-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const out = {};
    EXPORT_KEYS.forEach((k) => { out[k] = settings[k]; });
    try {
      fs.writeFileSync(r.filePath, JSON.stringify({ app: 'raibitScoreboard', version: app.getVersion(), exportedAt: new Date().toISOString(), settings: out }, null, 2) + '\n');
      return { ok: true, file: r.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('settings:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: '설정 가져오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const inc = data && typeof data.settings === 'object' && data.settings ? data.settings : null;
      if (!inc) return { ok: false, error: '설정 파일이 아닙니다' };
      const picked = {};
      EXPORT_KEYS.forEach((k) => { if (k in inc) picked[k] = inc[k]; });
      const base = { ...settings };
      if (!picked.score && inc.scoreTable) { picked.scoreTable = inc.scoreTable; delete base.score; } // 2.1.8 에서 내보낸 파일
      settings = normalizeSettings({ ...base, ...picked, emg: { ...settings.emg, ...(picked.emg || {}), restRms: settings.emg.restRms, filtered: true } });
      saveSettings();
      push();
      return { ok: !lastSaveError, file: r.filePaths[0], error: lastSaveError };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('records:get', () => ({ rev: recordsRev, records: hall.sortRecords(records) }));
  ipcMain.handle('records:save', (_e, edits) => {
    if (!edits || typeof edits !== 'object') return false;
    setRecords(hall.editRecords(records, edits));
    push();
    return !lastSaveError;
  });
  ipcMain.handle('records:delete', (_e, ids) => {
    if (!Array.isArray(ids)) return false;
    setRecords(hall.deleteRecords(records, ids));
    push();
    return !lastSaveError;
  });
  ipcMain.handle('records:reset', () => {
    if (game.phase === 'measuring') return false;
    try {
      store.resetRecords();
      records = [];
      hallTop = [];
      recordsRev++;
      lastResult = null;
      lastSaveError = null;
      game.clear();
    } catch (err) {
      lastSaveError = '기록 삭제 실패: ' + err.message;
    }
    push();
    return !lastSaveError;
  });
  ipcMain.handle('serial:reconnect', () => { serial.reconnect(); push(); });
  ipcMain.handle('settings:save', (_e, next) => {
    settings = normalizeSettings({ ...settings, ...next, emg: { ...settings.emg, ...(next && next.emg) } });
    if (!settings.askName) namePrompt = false;
    saveSettings();
    push();
    return settings;
  });
  ipcMain.handle('diag:set', (_e, on) => { diagOn = !!on; push(); });
  ipcMain.handle('diag:reset', () => { diag.reset(); push(); });
  ipcMain.handle('rec:start', () => {
    const sb = serial.status(now()).spikerbox || {};
    recorder.start(now(), {
      started: new Date().toISOString(), version: app.getVersion(), platform: process.platform,
      device: { name: sb.name || null, hwt: sb.hwt || null, transport: sb.transport || null, channels: sb.channels || null },
      sim: sim.enabled, emg: settings.emg, score: settings.score, windowMs: EMG_WINDOW_MS,
      filter: 'rms 열 = 고역 통과(emg.highpassHz) ×2 + 전원 주파수(emg.mainsHz) 홀수 배수 노치 (emg.notch), rms_raw = 거르기 전, strength = rms - 영점 - emg.margin',
    });
    push();
  });
  ipcMain.handle('rec:stop', () => { recorder.stop(); push(); });
  ipcMain.handle('rec:label', (_e, label) => { recorder.setLabel(label); push(); });
  ipcMain.handle('rec:open', () => {
    if (recorder.lastFile && !recorder.on) shell.showItemInFolder(recorder.lastFile);
    else { require('fs').mkdirSync(recorder.dir, { recursive: true }); shell.openPath(recorder.dir); }
  });
  ipcMain.handle('emg:zero', () => { rest.start(now()); zeroStartedAt = now(); push(); });
  // 자동 보정: mode = full (쉼 → 최대 힘, 신호 설정 전부 + 기준 힘) | noise (쉼만, 전원·영점·여유) | max (최대 힘만, 기준 힘)
  ipcMain.handle('calib:start', (_e, mode) => {
    if (game.phase === 'measuring') return false;
    rest.stop();
    autocal.start(mode, now());
    push();
    return true;
  });
  ipcMain.handle('calib:cancel', () => { autocal.cancel(); push(); });
  // 결과 적용. useRef = 잰 최대 힘을 기준 힘(100%)으로
  ipcMain.handle('calib:apply', (_e, opts) => {
    const r = autocal.result;
    if (!r || !r.ok) return null;
    const next = { ...settings };
    if (r.mode !== 'max') next.emg = { ...settings.emg, ...r.emg, filtered: true };
    if ((r.mode === 'max' || (opts && opts.useRef)) && r.maxStrength >= 1) next.score = { ...settings.score, ref: r.maxStrength };
    settings = normalizeSettings(next);
    saveSettings();
    autocal.cancel();
    push();
    return settings;
  });
  ipcMain.handle('serial:setRole', (_e, p, role) => {
    if (typeof p !== 'string' || !['auto', 'spikerbox', 'start'].includes(role)) return false;
    // USB 시리얼번호가 있는 포트는 그 키로 저장해서 COM 번호·경로가 바뀌어도 역할이 따라가게 한다
    const key = serial.roleKeyOf(p);
    const roles = { ...settings.portRoles };
    delete roles[p];
    delete roles[key];
    if (role !== 'auto') roles[key] = role;
    settings = normalizeSettings({ ...settings, portRoles: roles });
    saveSettings();
    serial.reopen(p);
    push();
    return true;
  });
  ipcMain.handle('sim:set', (_e, on) => {
    sim.setEnabled(on);
    if (!on) serial.dropVirtual(SIM_PORT);
    push();
  });
  ipcMain.handle('sim:key', (_e, key, down) => {
    if (!sim.enabled) return;
    if (key === 's') {
      if (down) requestStart(false);
    } else if (key === 'release') {
      sim.releaseAll();
    } else {
      sim.key(key, down);
    }
  });
  ipcMain.handle('window:toggleFullscreen', () => setFullscreen(!isFullscreen()));
  ipcMain.handle('app:quit', () => app.quit());
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  settings = store.loadSettings();
  recorder = new Recorder({ dir: path.join(store.dir, 'recordings') });
  const saved = store.loadRecords();
  if (saved) {
    records = hall.normalizeRecords(saved);
    hallTop = hall.hallOf(records);
  } else {
    // 처음 실행이거나 v2.0.x 데이터: 명예의 전당 + 점수 목록을 하나로 옮긴다 (옛 파일은 그대로 둔다)
    setRecords(hall.migrateRecords(store.loadLegacyHall(), store.loadLegacyHistory()));
  }

  game = new Game({
    getSettings: () => settings,
    onResult: ({ score }) => {
      // RESULT 확정 즉시 자동 저장. rank = 명예의 전당 순위, place/total = 전체 기록 중 순위, name = 입력한 이름 (없으면 null)
      const r = hall.addResult(records, score, new Date(), currentName);
      if (r.changed) setRecords(r.records);
      lastResult = { score, rank: r.rank, place: r.place, total: r.total, id: r.id || null, name: r.changed ? currentName : null };
      currentName = null;
    },
  });

  serial = new SerialManager({ getSettings: () => settings });
  serial.on('emg', (values, rate, frames) => {
    if (autocal.running && frames) autocal.addFrames(frames, rate);
    emgFilter.configure(rate, settings.emg);
    emgWin.add(emgFilter.process(values));
    rawWin.add(values);
    lastRaw = values[values.length - 1];
    diag.addSamples(values, now());
    recorder.addSamples(values);
  });
  serial.on('start', () => requestStart(false));

  sim = new Simulator((buf) => serial.feedSpikerBox(SIM_PORT, buf));

  setupMenu();
  setupIpc();
  createWindow(FORCE_WINDOWED ? false : FORCE_FULLSCREEN ? true : settings.fullscreen);
  serial.start();
  if (START_SIM) sim.setEnabled(true);

  // 100 ms 마다: 그 사이 들어온 SpikerBox 샘플을 한 구간 세기로 만들어 게임에 넣는다
  setInterval(() => {
    if (autocal.running && autocal.tick(now(), settings.emg)) push();
    const w = emgWin.take();
    const wr = rawWin.take();
    const t = now();
    if (!w) {
      live = { raw: null, rms: 0, rmsRaw: 0, strength: 0, score: 0 }; // SpikerBox 끊김: 이 구간은 건너뛴다
      diag.addWindow(null);
      recorder.addWindow(null, { restRms: settings.emg.restRms, phase: game.phase }, t);
      if (rest.running && t - zeroStartedAt > ZERO_TIMEOUT_MS) rest.stop();
      return;
    }
    const strength = strengthOf(w.rms, settings.emg.restRms, settings.emg.margin);
    live = { raw: lastRaw, rms: w.rms, rmsRaw: wr ? wr.rms : 0, strength, score: scoreOf(strength, settings) };
    diag.addWindow(live, recorder.label);
    recorder.addWindow(live, {
      restRms: settings.emg.restRms, score: live.score, phase: game.phase,
    }, t);
    if (rest.running && rest.add(w.rms, t)) {
      settings = normalizeSettings({ ...settings, emg: { ...settings.emg, restRms: rest.result() } });
      saveSettings();
    }
    game.sample('p1', live.strength, t);
  }, EMG_WINDOW_MS);

  // 시간 흐름(측정 제한 8초)과 연결 상태 갱신
  setInterval(() => { game.tick(now()); push(); }, 50);

  powerSaveBlocker.start('prevent-display-sleep');
  console.log('[main] 데이터 폴더:', store.dir);
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => {
  if (serial) serial.stopAll();
  if (recorder) recorder.stop();
  app.quit();
});
