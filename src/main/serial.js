'use strict';

// USB 시리얼 포트를 전부 열어 역할을 정한다. 포트 이름으로 구분하지 않고 "열어서 무엇이 오는지"로 판단한다.
//   1) settings.portRoles[path] 가 있으면 그 역할로 바로 연다.
//   2) 없으면 SpikerBox 탐색: 222222 → 500000 baud 로 열고 `b:;` 를 보낸 뒤 1초간 파서에 넣어 본다.
//   3) 둘 다 아니면 9600 baud 텍스트 포트(START 아두이노: `START`, `ALIVE`).
// SpikerBox Pro 처럼 시리얼이 아니라 USB HID 로 붙는 장치(벤더 0x2E73)는 hid.js 로 열고 같은 파서에 넣는다.
// 역할이 정해진 포트는 끊길 때까지 다시 탐색하지 않는다.
// 포트·USB 자리가 바뀌어도 버티게:
//   - 손으로 정한 역할은 USB 시리얼번호(있으면)로 저장해서 COM 번호·경로가 바뀌어도 따라간다.
//   - HID 장치는 검색 때 목록에서 사라졌으면 닫고, 2초 동안 프레임이 없으면 start 를 다시 보내고, 그래도 없으면 다시 연다.
//   - 열기에 계속 실패하는 포트(다른 프로그램이 쓰는 중 등)는 재시도 간격을 2초 → 최대 10초로 늘린다.

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
const HID_STALL_MS = 2000; // 이만큼 프레임이 없으면 start 를 다시 보낸다
const HID_RESTART_WAIT_MS = 3000; // 그 뒤로도 없으면 닫고 다시 연다
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 10000;
const OPEN_ERROR_SHOW_MS = 15000;

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

/** 손으로 정한 역할을 저장할 키: USB 시리얼번호가 있으면 그것(경로가 바뀌어도 같음), 없으면 경로 */
function roleKeyOf(info, p) {
  if (info && info.serialNumber && info.vendorId && info.productId) {
    return 'usb:' + String(info.vendorId).toLowerCase() + ':' + String(info.productId).toLowerCase() + ':' + info.serialNumber;
  }
  return p;
}

/** n 번 연속 실패 뒤 다음 시도까지 기다릴 시간 */
function retryDelay(fails) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, fails - 1));
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
  constructor({ getSettings, hidApi, listSerial, now } = {}) {
    super();
    this.getSettings = getSettings || (() => ({ emg: { channel: 1 }, portRoles: {} }));
    this.hid = hidApi || hid; // 테스트에서 가짜 HID 를 넣는다
    this.listSerial = listSerial || (() => SerialPort.list());
    this.now = now || Date.now;
    this.entries = new Map(); // path -> entry
    this.failures = new Map(); // 기기 키 -> { count, nextAt } 열기 실패 재시도 간격
    this.roleKeys = new Map(); // path -> 역할 저장 키
    this.openError = null; // { message, at } 마지막 SpikerBox(HID) 열기 실패
    this.hidDevices = []; // 마지막 검색에서 본 HID 장치 (진단 화면용)
    this.hidListOk = true;
    this.timer = null;
    this.scanning = false;
  }

  /** 관리자 화면에서 역할을 정할 때 저장할 키 */
  roleKeyOf(path) {
    return this.roleKeys.get(path) || path;
  }

  canTry(key, now) {
    const f = this.failures.get(key);
    return !f || now >= f.nextAt;
  }

  failed(key, now) {
    const count = ((this.failures.get(key) || {}).count || 0) + 1;
    this.failures.set(key, { count, nextAt: now + retryDelay(count) });
    return count;
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
    this.failures.clear();
    setTimeout(() => this.scan(), 500);
  }

  /** 역할을 바꾼 포트를 처음부터 다시 연다 */
  reopen(path) {
    this.failures.delete(this.roleKeyOf(path));
    this.drop(path);
    setTimeout(() => this.scan(), 300);
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = this.now();
      const list = await this.listSerial();
      for (const info of list) {
        const p = normalizePath(info.path);
        if (shouldSkip(info, p)) continue;
        const key = roleKeyOf(info, p);
        this.roleKeys.set(p, key);
        if (this.entries.has(p) || !this.canTry(key, now)) continue;
        this.openNew(p);
      }
      this.scanHid(now);
    } catch (err) {
      console.error('[serial] 포트 목록 실패:', err.message);
    } finally {
      this.scanning = false;
    }
  }

  /** HID 장치: 사라진 것은 닫고, 멈춘 것은 다시 시작시키고, 새로 보이는 것은 연다 */
  scanHid(now) {
    const devs = this.hid.listDevices();
    this.hidListOk = !!devs;
    if (devs) this.hidDevices = devs;
    if (devs) {
      // 목록을 읽었을 때만 정리한다 (못 읽었으면 지금 열린 것은 그대로 둔다)
      const present = new Set(devs.map((d) => 'hid:' + d.path));
      for (const [path, e] of [...this.entries]) {
        if (e.transport === 'hid' && !present.has(path)) {
          console.log('[serial] HID 장치가 사라짐:', path);
          this.drop(path);
        }
      }
    }
    this.checkHid(now);
    for (const info of devs || []) {
      const p = 'hid:' + info.path;
      if (this.entries.has(p) || !this.canTry(this.hid.deviceKey(info), now)) continue;
      this.openHid(p, info, now);
    }
  }

  /** 열려 있는데 프레임이 안 오는 HID 장치: start 를 다시 보내고, 그래도 안 오면 닫는다 (다음 검색 때 다시 열림) */
  checkHid(now) {
    for (const [path, e] of [...this.entries]) {
      if (e.transport !== 'hid' || !e.hid) continue;
      if (now - Math.max(e.lastFrameAt, e.openedAt) < HID_STALL_MS) continue;
      if (!e.restartAt) {
        e.restartAt = now;
        console.log('[serial] HID 신호 없음, start 다시 보냄:', path);
        e.hid.restart();
      } else if (now - e.restartAt >= HID_RESTART_WAIT_MS) {
        console.log('[serial] HID 신호 없음, 다시 엶:', path);
        this.drop(path);
      }
    }
  }

  newEntry(path, role, fixed) {
    const e = {
      path, role, fixed, port: null, baud: 0, mode: 'probe', closed: false,
      parser: new SpikerBoxParser(), probeMessages: [], probeFrames: 0,
      hwt: null, name: null, hwtTries: 0, hwtTimer: null,
      lastFrameAt: 0, fpsStart: 0, fpsCount: 0, fps: 0,
      lastAliveAt: 0, lastStartAt: 0, openedAt: 0, restartAt: 0, gotFrames: false,
      msgs: {}, startCount: 0, openedAtWall: Date.now(),
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

  openHid(path, info, now = this.now()) {
    const e = this.newEntry(path, 'spikerbox', false);
    const key = this.hid.deviceKey(info);
    e.info = info;
    e.mode = 'spikerbox';
    e.transport = 'hid';
    e.parser = new hid.HidDecoder(); // HID 는 emg.py 와 같은 전용 디코더 (시리얼용 SpikerBoxParser 아님)
    e.name = info.product || null;
    e.openedAt = now;
    const failed = (err) => {
      // 다른 프로그램(Spike Recorder 등)이 쓰는 중이거나 권한 없음. 점점 길게 기다렸다가 다시 시도한다.
      const n = this.failed(key, this.now());
      this.openError = { message: err ? err.message : '장치가 바로 닫힘', at: this.now() };
      console.error('[serial] HID 열기 실패 (' + n + '번째):', this.openError.message);
    };
    try {
      e.hid = this.hid.openDevice(info, {
        onData: (buf) => this.onBytes(e, buf),
        onBadReport: () => e.parser.badReport(),
        onClose: () => {
          // 프레임을 한 번도 못 받고 닫혔으면 열기 실패로 친다
          if (!e.gotFrames && !e.closed) failed(null);
          this.drop(path);
        },
      });
      console.log('[serial] SpikerBox (HID):', info.product || path);
    } catch (err) {
      failed(err);
      this.drop(path);
    }
  }

  async openNew(path) {
    const roles = this.getSettings().portRoles || {};
    const fixedRole = roles[this.roleKeyOf(path)] || roles[path];
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
      // 다른 프로그램이 쓰는 중이거나 사라진 포트. 점점 길게 기다렸다가 다시 시도한다.
      const n = this.failed(this.roleKeyOf(path), this.now());
      console.error('[serial] 열기 실패 (' + n + '번째):', path, err.message);
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
    const t = this.now();
    e.lastAliveAt = t;
    if (msg.type === 'start') {
      e.lastStartAt = t;
      e.startCount++;
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
      if (m.type.length <= 8 && (m.type in e.msgs || Object.keys(e.msgs).length < 24)) e.msgs[m.type] = m.value.slice(0, 40);
      if (m.type === 'HWT') this.onHwt(e, m.value);
    }
    if (e.mode === 'probe') {
      e.probeFrames += r.frames.length;
      return;
    }
    if (!r.frames.length) return;
    const t = this.now();
    e.lastFrameAt = t;
    e.restartAt = 0;
    if (!e.gotFrames) {
      e.gotFrames = true;
      if (e.transport === 'hid') this.failures.delete(this.hid.deviceKey(e.info || {}));
      this.openError = null;
    }
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
    // 두 번째 인자: 장치가 알려 준 샘플레이트 (전원 잡음 필터 설계용), 세 번째: 모든 채널 프레임 (자동 보정의 채널 고르기용)
    const fallbackRate = e.transport === 'hid' ? hid.defaultRate(e.parser.channels) : 10000;
    this.emit('emg', r.frames.map((f) => f[idx]), Number(e.msgs.MSF) || fallbackRate, r.frames);
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

  /** 관리자 2페이지(진단)용: 열린 포트 하나하나의 상태, 재시도 대기, 보이는 HID 장치 */
  diagnostics(now) {
    const hex = (n) => (n == null ? '' : (Number(n) || 0).toString(16).padStart(4, '0'));
    return {
      entries: [...this.entries.values()].map((e) => ({
        path: e.path,
        mode: e.mode,
        role: e.role,
        fixed: e.fixed,
        transport: e.virtual ? 'sim' : e.transport || 'serial',
        baud: e.baud,
        hwt: e.hwt,
        name: e.name,
        channels: e.parser.channels,
        confidence: Math.round(e.parser.confidence * 100),
        fps: now - e.lastFrameAt < SPIKER_ALIVE_MS ? e.fps : 0,
        lastFrameAgo: e.lastFrameAt ? now - e.lastFrameAt : null,
        lastAliveAgo: e.lastAliveAt ? now - e.lastAliveAt : null,
        lastStartAt: e.lastStartAt || null,
        startCount: e.startCount,
        restarting: !!e.restartAt,
        msgs: e.msgs,
        roleKey: this.roleKeyOf(e.path),
        openedAt: e.openedAtWall,
      })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      failures: [...this.failures].map(([key, f]) => ({ key, count: f.count, waitMs: Math.max(0, f.nextAt - now) })),
      hidListOk: this.hidListOk,
      hidDevices: this.hidDevices.map((d) => ({
        path: d.path, product: d.product || '', manufacturer: d.manufacturer || '', serialNumber: d.serialNumber || '',
        vendorId: hex(d.vendorId), productId: hex(d.productId), usagePage: hex(d.usagePage), release: d.release,
      })),
      openError: this.openError ? { message: this.openError.message, ago: now - this.openError.at } : null,
    };
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
      openError: this.openError && now - this.openError.at < OPEN_ERROR_SHOW_MS ? this.openError.message : null,
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

module.exports = { SerialManager, parseLine, classifyProbe, roleKeyOf, retryDelay };
