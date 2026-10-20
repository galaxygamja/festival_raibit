'use strict';

// 경기 상태 기계. 시간은 항상 인자로 받아서(now, ms) 테스트에서 시계를 마음대로 돌릴 수 있게 한다.
//   IDLE --start--> MEASURING --50개(0.1초 × 50 = 5초) 또는 8초--> RESULT
//   RESULT --start--> MEASURING
// 측정이 끝나면 판정 대기 없이 바로 결과. 최종 점수는 50개 값 중 최댓값. 1인 기록 모드.

const PHASE = { IDLE: 'idle', MEASURING: 'measuring', RESULT: 'result' };
const SAMPLES_NEEDED = 50;
const MEASURE_TIMEOUT_MS = 8000;
const MAX_SCORE = 9999;

// 점수 곡선: 세기 × 보정계수를 0~1 로 본 뒤 curve 제곱 (1 이면 직선). 1 보다 작으면 높은 점수일수록 같은 점수를 더 올리기 어렵다.
const DEFAULT_CURVE = 0.6;

function toScore(raw, factor, curve = 1) {
  const x = Math.max(0, Number(raw) * Number(factor));
  const c = Number(curve) > 0 ? Number(curve) : 1;
  const v = Math.round(c === 1 ? x : MAX_SCORE * Math.pow(Math.min(1, x / MAX_SCORE), c));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, v));
}

function emptyPlayer() {
  // current: 방금 들어온 값(현재 힘), score: 지금까지의 최댓값(= 최종 점수)
  return { score: 0, current: 0, samples: 0 };
}

class Game {
  /**
   * @param {object} opts
   * @param {() => {calibration: number}} opts.getSettings
   * @param {(result: {score: number}) => void} [opts.onResult]
   */
  constructor({ getSettings, onResult }) {
    this.getSettings = getSettings;
    this.onResult = onResult || (() => {});
    this.phase = PHASE.IDLE;
    this.p1 = emptyPlayer();
    this.measureStartedAt = 0;
  }

  /** START 버튼(물리 / 관리자 / 시뮬레이션). MEASURING 중에는 무시. */
  start(now) {
    if (this.phase === PHASE.MEASURING) return false;
    this.phase = PHASE.MEASURING;
    this.p1 = emptyPlayer();
    this.measureStartedAt = now;
    return true;
  }

  /** 경기 중지 · 기록하지 않음. MEASURING 중일 때만 동작. */
  stop() {
    if (this.phase !== PHASE.MEASURING) return false;
    this.phase = PHASE.IDLE;
    this.p1 = emptyPlayer();
    return true;
  }

  /** 결과 화면을 비우고 대기로 (기록 전체 삭제 뒤). MEASURING 중에는 무시. */
  clear() {
    if (this.phase === PHASE.MEASURING) return false;
    this.phase = PHASE.IDLE;
    this.p1 = emptyPlayer();
    return true;
  }

  /** 0.1초 구간의 세기 하나. which 는 'p1' 만 받는다(1인 모드). */
  sample(which, raw, now) {
    if (this.phase !== PHASE.MEASURING || which !== 'p1') return;
    const p = this.p1;
    if (p.samples >= SAMPLES_NEEDED) return;
    const s = this.getSettings();
    const v = toScore(raw, s.calibration, s.scoreCurve);
    p.samples += 1;
    p.current = v;
    p.score = Math.max(p.score, v);
    this.tick(now);
  }

  tick(now) {
    if (this.phase !== PHASE.MEASURING) return;
    const full = this.p1.samples >= SAMPLES_NEEDED;
    const timedOut = now - this.measureStartedAt >= MEASURE_TIMEOUT_MS;
    if (!full && !timedOut) return;
    this.phase = PHASE.RESULT;
    this.onResult({ score: this.p1.score });
  }

  snapshot() {
    return {
      phase: this.phase,
      samplesNeeded: SAMPLES_NEEDED,
      p1: { ...this.p1 },
    };
  }
}

module.exports = { Game, PHASE, SAMPLES_NEEDED, MEASURE_TIMEOUT_MS, MAX_SCORE, DEFAULT_CURVE, toScore };
