'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker } = require('electron');
const { Game } = require('./game');
const hall = require('./hall');
const { Store, normalizeSettings } = require('./store');
const { SerialManager } = require('./serial');
const { EmgWindow, RestMeter, strengthOf } = require('./emg');
const { Simulator } = require('./sim');

const argv = process.argv.slice(1);
const START_SIM = argv.includes('--sim');
// 시작 화면: --windowed / --fullscreen 이 있으면 그걸 따르고, 없으면 마지막으로 고른 방식(settings.fullscreen)
const FORCE_WINDOWED = argv.includes('--windowed');
const FORCE_FULLSCREEN = argv.includes('--fullscreen');

if (!app.requestSingleInstanceLock()) {
  // 두 개가 뜨면 시리얼 포트를 서로 뺏으므로 하나만 실행
  app.quit();
}

let win = null;
let store, settings, records, hallTop = [], recordsRev = 0, lastResult = null, game, serial, sim;
const emgWin = new EmgWindow();
const rest = new RestMeter(3000);
let live = { raw: null, rms: 0, strength: 0 };
let lastRaw = null; // 선택 채널의 마지막 원시값 (관리자 화면 확인용)
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
    hall: hallTop,
    recordsRev, // 전체 기록은 크기가 커서 payload 에 싣지 않고, 관리자 화면이 records:get 으로 받아 간다
    recordsTotal: records.length,
    ports: serial.status(t),
    emg: { raw: live.raw, rms: Math.round(live.rms * 10) / 10, strength: Math.round(live.strength * 10) / 10, restRms: settings.emg.restRms, zeroing: rest.running },
    settings,
    sim: sim.enabled,
    platform: process.platform,
    fullscreen: isFullscreen(),
    saveError: lastSaveError,
    dataDir: store.dir,
    version: app.getVersion(),
  };
}

function push(force) {
  if (!win || win.isDestroyed()) return;
  const p = payload();
  const s = JSON.stringify(p);
  if (!force && s === lastPayload) return;
  lastPayload = s;
  win.webContents.send('state', p);
}

function isFullscreen() {
  return !!win && !win.isDestroyed() && (win.isKiosk() || win.isFullScreen());
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
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return;
  if (on) {
    win.setKiosk(true);
  } else {
    win.setKiosk(false);
    win.setFullScreen(false);
  }
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
    kiosk: full,
    fullscreen: full,
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
  win.once('ready-to-show', () => win.show());
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
  ipcMain.handle('game:start', () => { if (game.start(now())) lastResult = null; push(); });
  ipcMain.handle('game:stop', () => { game.stop(); push(); });
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
    saveSettings();
    push();
    return settings;
  });
  ipcMain.handle('emg:zero', () => { rest.start(now()); zeroStartedAt = now(); push(); });
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
      if (down) { if (game.start(now())) lastResult = null; push(); }
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
      // RESULT 확정 즉시 자동 저장. rank = 명예의 전당 순위, place/total = 전체 기록 중 순위
      const r = hall.addResult(records, score, new Date());
      if (r.changed) setRecords(r.records);
      lastResult = { score, rank: r.rank, place: r.place, total: r.total };
    },
  });

  serial = new SerialManager({ getSettings: () => settings });
  serial.on('emg', (values) => {
    emgWin.add(values);
    lastRaw = values[values.length - 1];
  });
  serial.on('start', () => { if (game.start(now())) lastResult = null; push(); });

  sim = new Simulator((buf) => serial.feedSpikerBox(SIM_PORT, buf));

  setupMenu();
  setupIpc();
  createWindow(FORCE_WINDOWED ? false : FORCE_FULLSCREEN ? true : settings.fullscreen);
  serial.start();
  if (START_SIM) sim.setEnabled(true);

  // 100 ms 마다: 그 사이 들어온 SpikerBox 샘플을 한 구간 세기로 만들어 게임에 넣는다
  setInterval(() => {
    const w = emgWin.take();
    const t = now();
    if (!w) {
      live = { raw: null, rms: 0, strength: 0 }; // SpikerBox 끊김: 이 구간은 건너뛴다
      if (rest.running && t - zeroStartedAt > ZERO_TIMEOUT_MS) rest.stop();
      return;
    }
    live = { raw: lastRaw, rms: w.rms, strength: strengthOf(w.rms, settings.emg.restRms) };
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
  app.quit();
});
