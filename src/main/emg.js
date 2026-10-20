'use strict';

// SpikerBox 샘플 → 100 ms 구간 AC RMS (PLAN.md 2장). 구간 평균을 빼므로 중심값·드리프트를 몰라도 된다.

class EmgWindow {
  constructor() {
    this._n = 0;
    this._sum = 0;
    this._sumSq = 0;
  }

  add(values) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      this._n++;
      this._sum += v;
      this._sumSq += v * v;
    }
  }

  /** 모은 샘플로 { rms, count } 를 돌려주고 비운다. 샘플이 없으면 null */
  take() {
    if (!this._n) return null;
    const n = this._n;
    const mean = this._sum / n;
    const variance = this._sumSq / n - mean * mean;
    this._n = 0;
    this._sum = 0;
    this._sumSq = 0;
    return { rms: variance > 0 ? Math.sqrt(variance) : 0, count: n };
  }
}

// 전원 잡음 거르기. 실제 녹화(2026-10-20)에서 쉴 때 RMS 의 대부분이 60 Hz 와 홀수 배수였고, 크기가 시간에 따라 5~50 으로 바뀌어
// 영점 하나로는 뺄 수 없었다. 80 Hz 고역 통과(2차 × 2) + 60 Hz 배수 노치로 쉼 RMS 가 15 → 2, 최대 ÷ 쉼이 5배 → 24배가 됐다.
// HID 로 프레임이 15% 쯤 빠지지만 받은 덩어리 안의 간격은 장치 샘플 주기 그대로라, 장치가 알려 준 샘플레이트(MSF)로 설계한다.
// 관리자 3페이지에서 바꿀 수 있다 (settings.emg.mainsHz / notch / highpassHz). 아래는 기본값.
const MAINS_HZ = 60;
const NOTCH_HARMONICS = [1, 3, 5, 7, 9];
const NOTCH_Q = 4;
const HIGHPASS_HZ = 80;

function biquad(type, f0, q, rate) {
  const w = (2 * Math.PI * f0) / rate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b = type === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [1, -2 * c, 1];
  return { hp: type === 'hp', b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

class EmgFilter {
  /** opts: { mainsHz (50|60), notch (켜기/끄기), highpassHz (0 = 끄기) } */
  constructor(rate = 10000, opts = {}) {
    this.configure(rate, opts);
  }

  setRate(rate) {
    this.configure(rate, this.opts);
  }

  configure(rate, opts = {}) {
    rate = Number(rate) > 0 ? Number(rate) : 10000;
    const o = {
      mainsHz: Number(opts.mainsHz) === 50 ? 50 : MAINS_HZ,
      notch: opts.notch !== false,
      highpassHz: Number.isFinite(Number(opts.highpassHz)) && opts.highpassHz !== null ? Math.max(0, Number(opts.highpassHz)) : HIGHPASS_HZ,
    };
    const key = [rate, o.mainsHz, o.notch, o.highpassHz].join('|');
    if (key === this._key) return;
    this._key = key;
    this.rate = rate;
    this.opts = o;
    this._stages = [];
    if (o.highpassHz > 0 && o.highpassHz < rate / 2) {
      this._stages.push(biquad('hp', o.highpassHz, Math.SQRT1_2, rate), biquad('hp', o.highpassHz, Math.SQRT1_2, rate));
    }
    if (o.notch) NOTCH_HARMONICS.forEach((k) => { if (o.mainsHz * k < rate / 2) this._stages.push(biquad('notch', o.mainsHz * k, NOTCH_Q, rate)); });
    this._primed = false;
  }

  /** 원시 샘플 배열 → 거른 샘플 배열 (상태는 다음 호출로 이어진다) */
  process(values) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let v = values[i];
      if (!this._primed) {
        // 첫 샘플의 직류(≈512)로 정상 상태를 채워 처음에 큰 튐이 생기지 않게 한다 (고역 통과는 직류 → 0, 노치는 직류를 그대로 통과)
        let dc = v;
        for (const f of this._stages) {
          const y = f.hp ? 0 : dc;
          f.x1 = f.x2 = dc;
          f.y1 = f.y2 = y;
          dc = y;
        }
        this._primed = true;
      }
      for (const f of this._stages) {
        const y = f.b0 * v + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
        f.x2 = f.x1; f.x1 = v; f.y2 = f.y1; f.y1 = y;
        v = y;
      }
      out[i] = v;
    }
    return out;
  }
}

// 영점을 뺀 뒤에도 쉴 때 구간 RMS 가 ±1 정도 흔들린다. 점수 곡선은 0 근처가 가팔라서 이 흔들림이 수백 점이 되므로 조금 더 뺀다.
const REST_MARGIN = 1.5;

function strengthOf(rms, restRms, margin = REST_MARGIN) {
  return Math.max(0, rms - (restRms || 0) - margin);
}

/** 영점 잡기: 일정 시간 동안 구간 RMS 평균 */
class RestMeter {
  constructor(durationMs = 3000) {
    this._duration = durationMs;
    this._startedAt = 0;
    this._sum = 0;
    this._n = 0;
    this._running = false;
  }

  start(now) {
    this._startedAt = now;
    this._sum = 0;
    this._n = 0;
    this._running = true;
  }

  /** 구간 RMS 를 넣는다. 시간이 다 차면 true */
  add(rms, now) {
    if (!this._running) return false;
    this._sum += rms;
    this._n++;
    if (now - this._startedAt >= this._duration) {
      this._running = false;
      return true;
    }
    return false;
  }

  stop() {
    this._running = false;
  }

  get running() {
    return this._running;
  }

  result() {
    return this._n ? this._sum / this._n : 0;
  }
}

module.exports = { EmgWindow, EmgFilter, strengthOf, RestMeter, MAINS_HZ, HIGHPASS_HZ, REST_MARGIN };
