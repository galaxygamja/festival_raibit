'use strict';

// 하드웨어 없이 테스트하는 가짜 SpikerBox. 실제 장치처럼 바이트 스트림(HWT 메시지 + 10 kHz 프레임)을 만들어
// 실제 파서와 필터·RMS 경로를 그대로 거친다. A 키를 누르는 동안 근육 신호(넓은 대역 잡음)가 서서히 커지고, 떼면 줄어든다.
// 크기는 실제 녹화(2026-10-20, SpikerBox Pro)에 맞췄다: 10비트(중심 512), 60 Hz 전원 잡음, 거른 뒤 쉼 RMS ≈ 2, 힘 RMS 15~45.
// 누를 때마다 목표 세기를 무작위로 골라 기록이 매번 다르게 나온다 (기본 보정에서 약 4000~8000점).

const { encodeFrames, encodeMessage } = require('./spikerbox');

const TICK_MS = 10;
const SAMPLES_PER_TICK = 100; // 10 kHz
const SAMPLE_RATE = 10000;
const CENTER = 512;
const MAX_RAW = 1023;
const HUM_HZ = 60;
const HUM_AMP = 20; // 거르기 전 쉼 RMS ≈ 14 (실제 녹화와 비슷)
const NOISE_RMS_PER_AMP = 1 / Math.sqrt(3); // 균일 잡음 [-1, 1] 의 RMS
const REST_RMS = 2;
const HELD_RMS_MIN = 15;
const HELD_RMS_MAX = 45;
const FOLLOW = 0.06; // 틱마다 목표를 따라가는 비율

class Simulator {
  /** feed(Buffer): SpikerBox 바이트를 넘겨 준다 */
  constructor(feed) {
    this.feed = feed;
    this.enabled = false;
    this.held = { a: false };
    this.timer = null;
    this.amp = REST_RMS;
    this.target = HELD_RMS_MAX;
    this.n = 0; // 지금까지 만든 샘플 수 (전원 잡음 위상 유지)
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    this.held = { a: false };
    if (on) {
      this.feed(encodeMessage('HWT:MUSCLESS;'));
      this.timer = setInterval(() => this.tick(), TICK_MS);
    } else {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  key(k, down) {
    if (!(k in this.held)) return;
    if (k === 'a' && down && !this.held.a) this.target = HELD_RMS_MIN + Math.random() * (HELD_RMS_MAX - HELD_RMS_MIN);
    this.held[k] = !!down;
  }

  releaseAll() {
    this.held = { a: false };
  }

  /** 10 ms 분량(100샘플)을 만들어 넘긴다 */
  tick() {
    // amp = 근육 신호 RMS
    this.amp += ((this.held.a ? this.target : REST_RMS) - this.amp) * FOLLOW;
    const frames = [];
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const hum = HUM_AMP * Math.sin((2 * Math.PI * HUM_HZ * this.n++) / SAMPLE_RATE);
      const v = CENTER + hum + ((Math.random() * 2 - 1) * this.amp) / NOISE_RMS_PER_AMP;
      frames.push([Math.max(0, Math.min(MAX_RAW, Math.round(v)))]);
    }
    this.feed(encodeFrames(frames));
  }
}

module.exports = { Simulator };
