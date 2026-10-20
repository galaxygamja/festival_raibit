'use strict';

// USB 시리얼 포트를 전부 열어 역할을 정한다. 포트 이름으로 구분하지 않고 "열어서 무엇이 오는지"로 판단한다.
//   1) settings.portRoles[path] 가 있으면 그 역할로 바로 연다.
//   2) 없으면 SpikerBox 탐색: 222222 → 500000 baud 로 열고 `b:;` 를 보낸 뒤 1초간 파서에 넣어 본다.
//   3) 둘 다 아니면 9600 baud 텍스트 포트(START 아두이노: `START`, `ALIVE`).
// SpikerBox Pro 처럼 시리얼이 아니라 USB HID 로 붙는 장치(벤더 0x2E73)는 hid.js 로 열고 같은 파서에 넣는다.
// 역할이 정해진 포트는 끊길 때까지 다시 탐색하지 않는다.

const { EventEmitter } = require('events');
const { SerialPort, ReadlineParser } = require('serialport');
const { SpikerBoxParser, DEVICES } = require('./spikerbox');
const hid = require('./hid');

const TEXT_BAUD = 9600;
const SPIKER_BAUDS = [222222, 500000];
const SCAN_INTERVAL_MS = 2000;
const PROBE_MS = 1000;
const HWT_RETRY_MS = 2000;
const HWT_RETRY_MAX = 5;
const SPIKER_ALIVE_MS = 1000; // 1초 안에 프레임이 왔으면 연결됨
const START_ALIVE_MS = 3000; // 3초 안에 START/ALIVE 가 왔으면 연결됨
const PROBE_MIN_FRAMES = 20;
const PROBE_MIN_CONFIDENCE = 0.9;

/** 'START' / 'ALIVE' 만 인식. 나머지는 null */
function parseLine(line) {
  const s = String(line).replace(/\r/g, '').trim().toUpperCase();
  if (s === 'START') return { type: 'start' };
  if (s === 'ALIVE') return { type: 'alive' };
  return null;
}

/** 탐색 결과가 SpikerBox 인지: HWT 메시지가 왔거나 정상 프레임이 20개 이상 */
function classifyProbe({ messages, frameCount }) {
  return (messages || []).some((m) => m.type === 'HWT') || frameCount >= PROBE_MIN_FRAMES;
}

function normalizePath(p) {
  // macOS: tty.* 는 열 때 막힐 수 있어 cu.* 로 연다
  if (process.platform === 'darwin') return p.replace(/^\/dev\/tty\./, '/dev/cu.');
  return p;
}

// 아두이노·SpikerBox 는 USB 장치라 vendorId 가 있다. 블루투스 이어폰·내장 COM1 같은 포트는 열지 않는다.
const USB_NAME = /usbmodem|usbserial|wchusbserial|SLAB_USBtoUART|ttyACM|ttyUSB/i;
function shouldSkip(info, p) {
  if (/bluetooth|debug-console|wlan/i.test(p)) return true;
  return !info.vendorId && !USB_NAME.test(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openAsync(path, baudRate) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = new SerialPort({ path, baudRate, autoOpen: false });
    } catch (err) {
      reject(err);
      return;
    }
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

function closeAsync(port) {
  return new Promise((resolve) => {
    if (!port) return resolve();
    try {
      if (!port.isOpen) return resolve();
      port.removeAllListeners('data');
      port.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

class SerialManager extends EventEmitter {
  constructor({ getSettings } = {}) {
    super();
    this.getSettings = getSettings || (() => ({ emg: { channel: 1 }, portRoles: {} }));
    this.entries = new Map(); // path -> entry
    this.timer = null;
    this.scanning = false;
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stopAll() {
    clearInterval(this.timer);
    this.timer = null;
    for (const path of [...this.entries.keys()]) this.drop(path);
  }

  /** 관리자 화면의 "포트 다시 연결" (시뮬레이션 가상 포트는 그대로 둔다) */
  reconnect() {
    for (const [path, e] of [...this.entries]) if (e.port || e.hid) this.drop(path);
    setTimeout(() => this.scan(), 500);
  }

  /** 역할을 바꾼 포트를 처음부터 다시 연다 */
  reopen(path) {
    this.drop(path);
    setTimeout(() => this.scan(), 300);
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const list = await SerialPort.list();
      for (const info of list) {
        const p = normalizePath(info.path);
        if (shouldSkip(info, p) || this.entries.has(p)) continue;
        this.openNew(p);
      }
      for (const info of hid.listDevices()) {
        const p = 'hid:' + info.path;
        if (!this.entries.has(p)) this.openHid(p, info);
      }
    } catch (err) {
      console.error('[serial] 포트 목록 실패:', err.message);
    } finally {
      this.scanning = false;
    }
  }

  newEntry(path, role, fixed) {
    const e = {
      path, role, fixed, port: null, baud: 0, mode: 'probe', closed: false,
      parser: new SpikerBoxParser(), probeMessages: [], probeFrames: 0,
      hwt: null, name: null, hwtTries: 0, hwtTimer: null,
      lastFrameAt: 0, fpsStart: 0, fpsCount: 0, fps: 0,
      lastAliveAt: 0, lastStartAt: 0,
    };
    this.entries.set(path, e);
    return e;
  }

  /** 포트를 닫고 잊는다. 다음 검색 때 처음부터 다시 열린다. */
  drop(path) {
    const e = this.entries.get(path);
    if (!e) return;
    this.entries.delete(path);
    e.closed = true;
    clearInterval(e.hwtTimer);
    closeAsync(e.port);
    if (e.hid) e.hid.close();
  }

  openHid(path, info) {
    const e = this.newEntry(path, 'spikerbox', false);
    e.mode = 'spikerbox';
    e.transport = 'hid';
    e.name = info.product || null;
    try {
      e.hid = hid.openDevice(info, { onData: (buf) => this.onBytes(e, buf), onClose: () => this.drop(path) });
      console.log('[serial] SpikerBox (HID):', info.product || path);
    } catch (err) {
      // 다른 프로그램(Spike Recorder 등)이 쓰는 중이거나 권한 없음. 다음 검색 때 다시 시도한다.
      console.error('[serial] HID 열기 실패:', err.message);
      this.drop(path);
    }
  }

  async openNew(path) {
    const fixedRole = (this.getSettings().portRoles || {})[path];
    const e = this.newEntry(path, fixedRole || 'probing', !!fixedRole);
    try {
      if (fixedRole === 'start') return await this.openText(e);
      for (const baud of SPIKER_BAUDS) {
        if (e.closed) return;
        if (await this.probe(e, baud)) return;
      }
      if (e.closed) return;
      if (fixedRole === 'spikerbox') {
        // 사람이 SpikerBox 라고 정했으면 신호가 없어도 그대로 SpikerBox 로 열어 둔다
        e.parser.reset();
        const port = await openAsync(path, SPIKER_BAUDS[0]);
        this.attachSpiker(e, port, SPIKER_BAUDS[0]);
        return;
      }
      await this.openText(e);
    } catch (err) {
      // 다른 프로그램이 쓰는 중이거나 사라진 포트. 다음 검색 때 다시 시도한다.
      console.error('[serial] 열기 실패:', path, err.message);
      this.drop(path);
    }
  }

  /** baud 로 열고 1초 동안 SpikerBox 처럼 보이는지 본다. 맞으면 열어 둔 채로 SpikerBox 포트가 된다. */
  async probe(e, baud) {
    let port;
    try {
      port = await openAsync(e.path, baud);
    } catch (err) {
      console.error('[serial] 탐색 열기 실패:', e.path, baud, err.message);
      return false;
    }
    if (e.closed) { await closeAsync(port); return false; }
    e.port = port;
    e.mode = 'probe';
    e.parser.reset();
    e.probeMessages = [];
    e.probeFrames = 0;
    port.on('data', (buf) => this.onBytes(e, buf));
    port.on('close', () => this.drop(e.path));
    port.on('error', (err) => { console.error('[serial] 오류:', e.path, err.message); this.drop(e.path); });
    port.write('b:;\n');
    await sleep(PROBE_MS);
    if (e.closed) return false;
    const frameCount = e.parser.confidence >= PROBE_MIN_CONFIDENCE ? e.probeFrames : 0;
    if (classifyProbe({ messages: e.probeMessages, frameCount })) {
      this.becomeSpiker(e, baud);
      return true;
    }
    port.removeAllListeners('data');
    port.removeAllListeners('close');
    port.removeAllListeners('error');
    e.port = null;
    await closeAsync(port); // close 콜백 뒤에 다음 baud 로 다시 연다
    return false;
  }

  attachSpiker(e, port, baud) {
    e.port = port;
    port.on('data', (buf) => this.onBytes(e, buf));
    port.on('close', () => this.drop(e.path));
    port.on('error', (err) => { console.error('[serial] 오류:', e.path, err.message); this.drop(e.path); });
    this.becomeSpiker(e, baud);
    port.write('b:;\n');
  }

  becomeSpiker(e, baud) {
    e.mode = 'spikerbox';
    e.role = 'spikerbox';
    e.baud = baud;
    console.log('[serial] SpikerBox:', e.path, baud);
    // HWT 를 아직 모르면 2초마다 다시 물어본다 (최대 5번)
    clearInterval(e.hwtTimer);
    e.hwtTimer = setInterval(() => {
      if (e.hwt || e.closed || !e.port || e.hwtTries >= HWT_RETRY_MAX) { clearInterval(e.hwtTimer); return; }
      e.hwtTries++;
      try { e.port.write('b:;\n'); } catch (_) { /* ignore */ }
    }, HWT_RETRY_MS);
  }

  async openText(e) {
    const port = await openAsync(e.path, TEXT_BAUD);
    if (e.closed) { await closeAsync(port); return; }
    e.port = port;
    e.mode = 'text';
    e.role = 'start';
    e.baud = TEXT_BAUD;
    console.log('[serial] START 포트:', e.path);
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => this.handleLine(e, line));
    port.on('close', () => this.drop(e.path));
    port.on('error', (err) => { console.error('[serial] 오류:', e.path, err.message); this.drop(e.path); });
  }

  handleLine(e, line) {
    const msg = parseLine(line);
    if (!msg) return;
    const t = Date.now();
    e.lastAliveAt = t;
    if (msg.type === 'start') {
      e.lastStartAt = t;
      this.emit('start');
    }
  }

  /** 시뮬레이터가 실제 포트 대신 SpikerBox 바이트를 넣는 입구 */
  feedSpikerBox(path, buf) {
    let e = this.entries.get(path);
    if (!e) {
      e = this.newEntry(path, 'spikerbox', true);
      e.mode = 'spikerbox';
      e.virtual = true;
    }
    this.onBytes(e, buf);
  }

  dropVirtual(path) {
    const e = this.entries.get(path);
    if (e && e.virtual) this.entries.delete(path);
  }

  onBytes(e, buf) {
    const r = e.parser.push(buf);
    for (const m of r.messages) {
      if (e.mode === 'probe') e.probeMessages.push(m);
      if (m.type === 'HWT') this.onHwt(e, m.value);
    }
    if (e.mode === 'probe') {
      e.probeFrames += r.frames.length;
      return;
    }
    if (!r.frames.length) return;
    const t = Date.now();
    e.lastFrameAt = t;
    if (!e.fpsStart) e.fpsStart = t;
    e.fpsCount += r.frames.length;
    if (t - e.fpsStart >= 1000) {
      e.fps = Math.round((e.fpsCount * 1000) / (t - e.fpsStart));
      e.fpsStart = t;
      e.fpsCount = 0;
    }
    // 선택 채널이 프레임 채널 수보다 크면 채널 1을 쓴다
    const want = ((this.getSettings().emg || {}).channel || 1) - 1;
    const idx = want < r.frames[0].length ? want : 0;
    this.emit('emg', r.frames.map((f) => f[idx]));
  }

  onHwt(e, hwt) {
    if (e.hwt === hwt) return;
    e.hwt = hwt;
    const dev = DEVICES[hwt];
    e.name = dev ? dev.name : hwt;
    if (dev && dev.needsConf && e.port) {
      // 채널 수는 설정 채널이 2면 2, 아니면 1. 샘플레이트 = 10000 / 채널 수
      const ch = ((this.getSettings().emg || {}).channel) === 2 ? 2 : 1;
      try { e.port.write('conf s:' + 10000 / ch + ';c:' + ch + ';\n'); } catch (_) { /* ignore */ }
      e.parser.reset();
    }
    this.emit('device', { path: e.path, hwt, name: e.name });
  }

  status(now) {
    let spiker = null, start = null;
    for (const e of this.entries.values()) {
      if (e.mode === 'spikerbox' && (!spiker || e.lastFrameAt > spiker.lastFrameAt)) spiker = e;
      if (e.mode === 'text' && (!start || Math.max(e.lastAliveAt, e.lastStartAt) > Math.max(start.lastAliveAt, start.lastStartAt))) start = e;
    }
    const open = [...this.entries.values()]
      .map((e) => ({ path: e.path, role: e.mode === 'probe' ? 'probing' : e.role === 'probing' ? 'probing' : e.role, fixed: e.fixed }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return {
      spikerbox: spiker
        ? {
          connected: now - spiker.lastFrameAt < SPIKER_ALIVE_MS,
          path: spiker.path, hwt: spiker.hwt, name: spiker.name,
          channels: spiker.parser.channels, baud: spiker.baud, transport: spiker.hid ? 'hid' : 'serial',
          fps: now - spiker.lastFrameAt < SPIKER_ALIVE_MS ? spiker.fps : 0,
        }
        : { connected: false, path: null, hwt: null, name: null, channels: null, baud: 0, transport: null, fps: 0 },
      start: start
        ? {
          connected: now - Math.max(start.lastAliveAt, start.lastStartAt) < START_ALIVE_MS,
          path: start.path, lastStartAt: start.lastStartAt || null,
        }
        : { connected: false, path: null, lastStartAt: null },
      open,
    };
  }
}

module.exports = { SerialManager, parseLine, classifyProbe };
