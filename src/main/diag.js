'use strict';

// 관리자 2페이지(진단)용 신호 기록. 원시값을 링 버퍼에 모아 두었다가, 화면이 볼 때만 파형·통계로 줄여서 내보낸다.

const RING = 20000; // 10 kHz 기준 2초
const HISTORY = 300; // 100 ms 구간 × 300 = 30초
const SCOPE_BUCKETS = 240;

class Diag {
  constructor() {
    this._ring = new Int32Array(RING);
    this._len = 0; // 지금까지 넣은 샘플 수 (링 위치 계산용)
    this._history = [];
    this.reset();
  }

  /** 최소·최대 범위와 누적 수치를 처음부터 다시 잰다 (파형·이력은 그대로) */
  reset() {
    this._min = null;
    this._max = null;
    this._total = 0;
    this._rateStart = 0;
    this._rateCount = 0;
    this._rate = 0;
    this._lastAt = 0;
  }

  addSamples(values, now) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      this._ring[this._len % RING] = v;
      this._len++;
      if (this._min === null || v < this._min) this._min = v;
      if (this._max === null || v > this._max) this._max = v;
    }
    this._total += values.length;
    this._lastAt = now;
    if (!this._rateStart) this._rateStart = now;
    this._rateCount += values.length;
    if (now - this._rateStart >= 1000) {
      this._rate = Math.round((this._rateCount * 1000) / (now - this._rateStart));
      this._rateStart = now;
      this._rateCount = 0;
    }
  }

  /** 100 ms 구간 하나의 결과 (끊김이면 null 로 빈칸). label 은 녹화 표시(쉼/최대 등) */
  addWindow(w, label = '') {
    this._history.push(w ? [round1(w.rms), round1(w.strength), label] : null);
    if (this._history.length > HISTORY) this._history.shift();
  }

  /** 최근 n 개 샘플 (오래된 것부터) */
  _last(n) {
    n = Math.min(n, this._len, RING);
    const out = new Array(n);
    const start = this._len - n;
    for (let i = 0; i < n; i++) out[i] = this._ring[(start + i) % RING];
    return out;
  }

  snapshot(now) {
    const rate = this._rate || 1000;
    const sec = this._last(Math.max(1, rate)); // 최근 1초
    const win = this._last(Math.max(1, Math.round(rate / 10))); // 최근 100 ms
    const bits = this._max === null ? null : this._max <= 1023 ? 10 : this._max <= 4095 ? 12 : 14;
    const top = bits ? 2 ** bits - 1 : null;
    let clip = 0;
    if (top) for (const v of sec) if (v <= 0 || v >= top) clip++;
    return {
      scope: buckets(sec, SCOPE_BUCKETS),
      win: stats(win),
      sec: stats(sec),
      range: { min: this._min, max: this._max },
      bits,
      clip,
      rate: this._rate,
      total: this._total,
      lastAgo: this._lastAt ? now - this._lastAt : null,
      history: this._history.slice(),
    };
  }
}

function round1(v) {
  return Math.round((v || 0) * 10) / 10;
}

function stats(list) {
  if (!list.length) return { n: 0, min: null, max: null, mean: null, last: null };
  let min = list[0], max = list[0], sum = 0;
  for (const v of list) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { n: list.length, min, max, mean: round1(sum / list.length), last: list[list.length - 1] };
}

/** 파형을 n 칸의 [최소, 최대] 로 줄인다 */
function buckets(list, n) {
  const out = [];
  if (!list.length) return out;
  const size = list.length / Math.min(n, list.length);
  for (let b = 0; b * size < list.length; b++) {
    const from = Math.floor(b * size), to = Math.max(from + 1, Math.floor((b + 1) * size));
    let lo = list[from], hi = list[from];
    for (let i = from + 1; i < to && i < list.length; i++) {
      if (list[i] < lo) lo = list[i];
      if (list[i] > hi) hi = list[i];
    }
    out.push([lo, hi]);
  }
  return out;
}

module.exports = { Diag, buckets, stats };
