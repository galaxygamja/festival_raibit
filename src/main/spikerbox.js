'use strict';

// SpikerBox 바이너리 스트림 파서. 참고: Spike Recorder ArduinoSerial.cpp (PLAN.md 1장)
// 프레임 = 채널 수 × 2바이트, 첫 바이트만 0x80 비트가 켜져 있다. 기기 메시지는 이스케이프 구간에 ASCII 로 온다.

const ESC_START = [0xFF, 0xFF, 0x01, 0x01, 0x80, 0xFF];
const ESC_END = [0xFF, 0xFF, 0x01, 0x01, 0x81, 0xFF];
const ESC_MAX_TEXT = 64;
const AUTO_VOTES = 30;
const MAX_CHANNELS = 6;

const DEVICES = {
  MUSCLESS: { name: 'Muscle SpikerShield', needsConf: true },
  MUSCUSB1: { name: 'Muscle SpikerBox', needsConf: true },
  MUSCLESB: { name: 'Muscle SpikerBox Pro (HID)', needsConf: false },
  MSBPCDC: { name: 'Muscle SpikerBox Pro', needsConf: false },
  HUMANSB: { name: 'Human SpikerBox', needsConf: false },
  UNIBOX: { name: 'Uni box', needsConf: false },
};

/** 'HWT:MUSCLESS;EVNT:3;' → [{type, value}] — ':' 없는 조각은 무시 */
function parseMessageText(text) {
  const out = [];
  String(text || '').split(';').forEach((part) => {
    const i = part.indexOf(':');
    if (i <= 0) return;
    const type = part.slice(0, i).trim();
    if (!type) return;
    out.push({ type, value: part.slice(i + 1).trim() });
  });
  return out;
}

function endsWith(arr, tail) {
  if (arr.length < tail.length) return false;
  const off = arr.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (arr[off + i] !== tail[i]) return false;
  return true;
}

class SpikerBoxParser {
  constructor({ channels = 'auto' } = {}) {
    this._fixed = channels === 'auto' ? null : Math.min(MAX_CHANNELS, Math.max(1, channels | 0));
    this.reset();
  }

  reset() {
    this._channels = this._fixed;
    this._pending = [];
    this._esc = false;
    this._escBuf = [];
    this._frame = [];
    this._sinceStart = -1; // 마지막 프레임 시작 바이트 이후 바이트 수 (-1 = 아직 없음)
    this._votes = new Array(MAX_CHANNELS + 1).fill(0);
    this._voteCount = 0;
  }

  get channels() {
    return this._channels;
  }

  /** 자동 감지에서 가장 많이 나온 채널 수의 득표율(0~1). 확정 전이면 0. 잡음과 진짜 스트림을 가르는 데 쓴다. */
  get confidence() {
    if (this._channels === null || !this._voteCount) return 0;
    return this._votes[this._channels] / this._voteCount;
  }

  push(buf) {
    const out = { frames: [], messages: [] };
    for (let i = 0; i < buf.length; i++) this._byte(buf[i] & 0xFF, out);
    return out;
  }

  _byte(b, out) {
    if (this._esc) {
      this._escBuf.push(b);
      if (endsWith(this._escBuf, ESC_END)) {
        const text = String.fromCharCode.apply(null, this._escBuf.slice(0, this._escBuf.length - ESC_END.length));
        parseMessageText(text).forEach((m) => out.messages.push(m));
        this._esc = false;
        this._escBuf = [];
      } else if (this._escBuf.length > ESC_MAX_TEXT + ESC_END.length) {
        this._esc = false; // 넘치면 버리고 끝낸다
        this._escBuf = [];
      }
      return;
    }
    // 이스케이프 시작 후보는 판정이 날 때까지 보류한다
    const queue = this._pending.concat([b]);
    this._pending = [];
    while (queue.length) {
      let match = true;
      for (let i = 0; i < queue.length && i < ESC_START.length; i++) {
        if (queue[i] !== ESC_START[i]) { match = false; break; }
      }
      if (match && queue.length >= ESC_START.length) {
        this._esc = true;
        this._escBuf = [];
        this._frame = [];
        this._sinceStart = -1;
        return;
      }
      if (match) {
        this._pending = queue;
        return;
      }
      this._frameByte(queue.shift(), out);
    }
  }

  _frameByte(b, out) {
    if (this._sinceStart >= 0) this._sinceStart++;
    if (b & 0x80) {
      if (this._channels === null) this._vote();
      this._sinceStart = 0;
      this._frame = [b];
      return;
    }
    if (!this._frame.length) return; // 프레임 밖의 데이터 바이트는 버린다
    this._frame.push(b);
    if (this._channels !== null && this._frame.length === this._channels * 2) {
      const vals = [];
      for (let c = 0; c < this._channels; c++) {
        vals.push(((this._frame[c * 2] & 0x7F) << 7) | (this._frame[c * 2 + 1] & 0x7F));
      }
      out.frames.push(vals);
      this._frame = [];
    }
  }

  // 시작 바이트 사이 간격으로 채널 수를 센다
  _vote() {
    const gap = this._sinceStart;
    if (gap < 2 || gap % 2) return;
    const ch = gap / 2;
    if (ch > MAX_CHANNELS) return;
    this._votes[ch]++;
    if (++this._voteCount < AUTO_VOTES) return;
    let best = 1;
    for (let c = 2; c <= MAX_CHANNELS; c++) if (this._votes[c] > this._votes[best]) best = c;
    this._channels = best;
  }
}

/** 테스트·시뮬레이터용: number[][] → Buffer (파서의 역) */
function encodeFrames(frames) {
  const bytes = [];
  frames.forEach((f) => {
    f.forEach((v, c) => {
      const x = Math.min(16383, Math.max(0, Math.round(v)));
      bytes.push((c === 0 ? 0x80 : 0) | (x >> 7), x & 0x7F);
    });
  });
  return Buffer.from(bytes);
}

function encodeMessage(text) {
  return Buffer.concat([Buffer.from(ESC_START), Buffer.from(text, 'ascii'), Buffer.from(ESC_END)]);
}

module.exports = { SpikerBoxParser, parseMessageText, encodeFrames, encodeMessage, DEVICES, ESC_START, ESC_END };
