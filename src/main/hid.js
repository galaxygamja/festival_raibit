'use strict';

// SpikerBox Pro 는 시리얼이 아니라 USB HID 로 연결된다 (벤더 0x2E73).
// 리포트는 64바이트: [0x3F, 길이, payload...]. 명령은 [0x3F, 0x3E, 명령 텍스트, 0 패딩] 64바이트로 보낸다.
// 시작 명령과 payload 해석(HidDecoder)은 실기기에서 값이 정확히 읽히는 것을 확인한 사용자의 emg.py 와 같게 한다.

const { parseMessageText } = require('./spikerbox');

const BYB_VID = 0x2e73;
const REPORT_SIZE = 64;
const REPORT_MARK = 0x3f;
const WRITE_MARK = 0x3e;
const MAX_PAYLOAD = 62;
// emg.py 와 같이 start → board 로 수집을 시작하고, 관리자 화면의 기기 정보(HWT·MSF)를 위해 질의 두 개를 뒤에 붙인다.
// 실기기(2026-10-20): 이 순서도 초당 약 10,100 프레임, 디코딩 결과는 emg.py 와 같았다.
const INIT_COMMANDS = ['start:;\n', 'board:;\n', '?:;\n', 'max:;\n'];
const STOP_COMMAND = 'h:;\n';

const ESC_BEGIN = [0xff, 0xff, 0x01, 0x01, 0x80, 0xff];
const ESC_END = [0xff, 0xff, 0x01, 0x01, 0x81, 0xff];
const MAX_MESSAGE = 1024;
const ADC_MAX = 1023; // SpikerBox Pro 는 10비트
const MAX_FRAME_BYTES = 8;

function isPrefixOf(marker, pending) {
  if (pending.length > marker.length) return false;
  for (let i = 0; i < pending.length; i++) if (pending[i] !== marker[i]) return false;
  return true;
}

/**
 * HID payload → 프레임·메시지 (emg.py Decoder 와 같은 규칙).
 *  - 채널 수는 BRD 메시지로 정한다(기본 2, 확장보드 1 → 4, 4·5 → 3). 통계로 추측하지 않는다.
 *  - 프레임은 다음 시작 바이트(0x80)가 왔을 때 길이가 정확히 2×채널이고 값이 모두 1023 이하일 때만 확정한다.
 *  - 이스케이프 구간(기기 메시지)은 1024바이트까지 받는다. 그 안의 바이트는 절대 샘플로 보지 않는다.
 */
class HidDecoder {
  constructor() {
    this.reset();
  }

  reset() {
    this._pending = [];
    this._message = null;
    this._frame = [];
    this._channels = 2;
    this.goodFrames = 0;
    this.badFrames = 0;
    this.badReports = 0;
  }

  get channels() {
    return this._channels;
  }

  /** 받은 프레임 중 정상 비율 (진단 화면용) */
  get confidence() {
    const total = this.goodFrames + this.badFrames;
    return total ? this.goodFrames / total : 0;
  }

  /** 형식이 깨진 리포트: emg.py 처럼 이어 붙이지 않고 진행 중이던 프레임·메시지를 버린다 */
  badReport() {
    this.badReports++;
    this._frame = [];
    this._pending = [];
    this._message = null;
  }

  push(payload) {
    const out = { frames: [], messages: [] };
    for (let k = 0; k < payload.length; k++) {
      this._pending.push(payload[k] & 0xff);
      const marker = this._message !== null ? ESC_END : ESC_BEGIN;
      while (this._pending.length && !isPrefixOf(marker, this._pending)) {
        const b = this._pending.shift();
        if (this._message === null) {
          this._sampleByte(b, out.frames);
        } else {
          this._message.push(b);
          if (this._message.length > MAX_MESSAGE) {
            // emg.py 는 여기서 멈춘다. 앱은 계속 돌아야 하므로 그 메시지만 버리고 처음부터 다시 찾는다.
            this.badReport();
          }
        }
      }
      if (this._pending.length === marker.length) {
        this._pending = [];
        if (this._message === null) {
          this._message = [];
        } else {
          this._endMessage(out.messages);
        }
      }
    }
    return out;
  }

  _endMessage(messages) {
    const text = String.fromCharCode.apply(null, this._message);
    this._message = null;
    parseMessageText(text).forEach((m) => {
      messages.push(m);
      if (m.type === 'BRD') {
        // 확장보드는 프레임 폭을 바꾼다. 다음 시작 표시부터 새 폭으로 읽는다.
        this._frame = [];
        const b = m.value.charAt(0);
        this._channels = b === '1' ? 4 : b === '4' || b === '5' ? 3 : 2;
      }
    });
  }

  _sampleByte(b, frames) {
    if (b & 0x80) {
      if (this._frame.length) {
        if (this._frame.length === 2 * this._channels) {
          const vals = [];
          for (let i = 0; i < this._frame.length; i += 2) vals.push(((this._frame[i] & 0x7f) << 7) | this._frame[i + 1]);
          if (vals.every((v) => v <= ADC_MAX)) {
            frames.push(vals);
            this.goodFrames++;
          } else {
            this.badFrames++;
          }
        } else {
          this.badFrames++;
        }
      }
      this._frame = [b];
    } else if (this._frame.length) {
      this._frame.push(b);
      if (this._frame.length > MAX_FRAME_BYTES) {
        this.badFrames++;
        this._frame = [];
      }
    }
  }
}

/** 장치가 샘플레이트(MSF)를 알려 주지 않을 때: 2채널 10 kHz, 확장보드(3~4채널) 5 kHz (emg.py 와 같음) */
function defaultRate(channels) {
  return channels > 2 ? 5000 : 10000;
}

/** 수신 리포트 → payload Buffer (형식이 맞지 않으면 null). Windows 는 앞에 report ID 0 이 붙을 수 있다. */
function unwrapReport(data) {
  let r = Buffer.from(data || []);
  if (r.length >= 3 && r[0] === 0 && r[1] === REPORT_MARK) r = r.subarray(1);
  if (r.length < 2 || r[0] !== REPORT_MARK) return null;
  const len = r[1];
  if (len > MAX_PAYLOAD || len > r.length - 2) return null;
  return r.subarray(2, 2 + len);
}

/** 명령 텍스트 → 64바이트 쓰기 리포트 */
function buildCommand(text) {
  const cmd = Buffer.from(text, 'ascii');
  if (cmd.length > REPORT_SIZE - 2) throw new Error('command too long');
  const out = Buffer.alloc(REPORT_SIZE);
  out[0] = REPORT_MARK;
  out[1] = WRITE_MARK;
  cmd.copy(out, 2);
  return out;
}

const VENDOR_USAGE_PAGE = 0xff00;

/** 꽂은 USB 포트가 바뀌어도(경로가 바뀌어도) 같은 기기로 알아보는 키. 시리얼번호가 없으면 경로를 쓴다. */
function deviceKey(info) {
  const hex = (n) => (Number(n) || 0).toString(16).padStart(4, '0');
  return info.serialNumber
    ? 'hid:' + hex(info.vendorId) + ':' + hex(info.productId) + ':' + info.serialNumber
    : 'hid:' + info.path;
}

/**
 * node-hid 장치 목록 → 열 장치 목록. 벤더 0x2E73 만, 기기 하나에 HID 항목이 여러 개 보이면(Windows) 벤더 전용
 * usagePage(0xFF00) 항목 하나만 남긴다. 제품 ID 는 가리지 않는다.
 */
function pickDevices(list) {
  const byKey = new Map();
  (Array.isArray(list) ? list : []).forEach((d) => {
    if (!d || d.vendorId !== BYB_VID || !d.path) return;
    const k = deviceKey(d);
    const cur = byKey.get(k);
    if (!cur || (cur.usagePage !== VENDOR_USAGE_PAGE && d.usagePage === VENDOR_USAGE_PAGE)) byKey.set(k, d);
  });
  return [...byKey.values()];
}

/** 연결된 BackyardBrains HID 장치 목록. node-hid 를 못 불러오거나 목록을 못 읽으면 null (없는 것과 구분) */
function listDevices() {
  try {
    const HID = require('node-hid');
    return pickDevices(HID.devices());
  } catch (err) {
    console.error('[hid] 장치 목록 실패:', err.message);
    return null;
  }
}

/** 장치를 열고 초기화 명령을 보낸다. onData(Buffer payload), onBadReport(), onClose() 를 받는다. */
function openDevice(info, { onData, onBadReport, onClose }) {
  const HID = require('node-hid');
  const dev = new HID.HID(info.path);
  let closed = false;
  const fail = (err) => {
    if (closed) return;
    if (err) console.error('[hid] 오류:', info.path, err.message);
    closed = true;
    try { dev.removeAllListeners(); dev.close(); } catch (_) { /* ignore */ }
    onClose();
  };
  dev.on('data', (d) => {
    const payload = unwrapReport(d);
    if (!payload) {
      if (onBadReport) onBadReport();
      return;
    }
    if (payload.length) onData(payload);
  });
  dev.on('error', fail);
  const send = (text) => {
    if (closed) return;
    try { dev.write([...buildCommand(text)]); } catch (err) { fail(err); }
  };
  INIT_COMMANDS.forEach((c, i) => setTimeout(() => send(c), i * 20));
  return {
    send,
    /** 스트림이 멈췄을 때 다시 시작시킨다 */
    restart() { send('start:;\n'); },
    close() {
      if (closed) return;
      send(STOP_COMMAND);
      closed = true;
      try { dev.removeAllListeners(); dev.close(); } catch (_) { /* ignore */ }
    },
  };
}

module.exports = { BYB_VID, INIT_COMMANDS, HidDecoder, defaultRate, unwrapReport, buildCommand, deviceKey, pickDevices, listDevices, openDevice };
