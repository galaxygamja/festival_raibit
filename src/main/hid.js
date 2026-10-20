'use strict';

// SpikerBox Pro 는 시리얼이 아니라 USB HID 로 연결된다 (벤더 0x2E73).
// 리포트는 64바이트: [0x3F, 길이, payload...]. payload 는 시리얼과 같은 바이트 스트림이라 SpikerBoxParser 에 그대로 넣는다.
// 명령은 [0x3F, 0x3E, 명령 텍스트, 0 패딩] 64바이트로 보낸다.

const BYB_VID = 0x2e73;
const REPORT_SIZE = 64;
const REPORT_MARK = 0x3f;
const WRITE_MARK = 0x3e;
const MAX_PAYLOAD = 62;
const INIT_COMMANDS = ['?:;\n', 'max:;\n', 'board:;\n', 'start:;\n'];
const STOP_COMMAND = 'h:;\n';

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

/** 장치를 열고 초기화 명령을 보낸다. onData(Buffer payload), onClose() 를 받는다. */
function openDevice(info, { onData, onClose }) {
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
    if (payload && payload.length) onData(payload);
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

module.exports = { BYB_VID, INIT_COMMANDS, unwrapReport, buildCommand, deviceKey, pickDevices, listDevices, openDevice };
