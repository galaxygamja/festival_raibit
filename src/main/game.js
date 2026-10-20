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
// v2.1.8 부터 화면에서 고치는 점수표(scoreTable)를 쓴다. toScore 는 표가 없을 때(테스트·예전 설정)와 기본 표를 만들 때만 쓴다.
const DEFAULT_CURVE = 0.6;

// 기본 점수표 [세기, 점수]: 보정 176 · 곡선 0.6 과 거의 같다. 실제 녹화의 최대 힘(세기 ≈ 31)이 7000점.
// 구간마다 직선이라 "세기 1 당 점수"(가중치)가 구간별로 다르다: 0~2 는 650, 31~45 는 121.
const DEFAULT_SCORE_TABLE = [[0, 0], [2, 1300], [5, 2300], [10, 3500], [20, 5300], [31, 7000], [45, 8700], [57, 9999]];

/** 표를 정리한다: 숫자만, 세기 오름차순, 같은 세기는 하나, 점수 0~9999. 2개 미만이면 null */
function cleanScoreTable(table) {
  if (!Array.isArray(table)) return null;
  const pts = [];
  table.forEach((p) => {
    const s = Array.isArray(p) ? Number(p[0]) : NaN, v = Array.isArray(p) ? Number(p[1]) : NaN;
    if (Number.isFinite(s) && Number.isFinite(v) && s >= 0) pts.push([Math.round(s * 100) / 100, Math.max(0, Math.min(MAX_SCORE, Math.round(v)))]);
  });
  pts.sort((a, b) => a[0] - b[0]);
  const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0]);
  return out.length >= 2 ? out : null;
}

/** 점수표로 세기 → 점수. 첫 점 아래는 (0, 0) 에서 첫 점까지 직선, 마지막 점 위는 마지막 점수 그대로 */
function scoreFromTable(strength, table) {
  const s = Math.max(0, Number(strength) || 0);
  const t = table;
  let v;
  if (s <= t[0][0]) v = t[0][0] > 0 ? (t[0][1] * s) / t[0][0] : t[0][1];
  else if (s >= t[t.length - 1][0]) v = t[t.length - 1][1];
  else {
    let i = 1;
    while (t[i][0] < s) i++;
    const [s0, v0] = t[i - 1], [s1, v1] = t[i];
    v = v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
  }
  return Math.max(0, Math.min(MAX_SCORE, Math.round(v)));
}

/** 설정에 맞는 점수 계산 (점수표가 있으면 표, 없으면 보정계수·곡선) */
function scoreOf(strength, settings) {
  const s = settings || {};
  return Array.isArray(s.scoreTable) && s.scoreTable.length >= 2 ? scoreFromTable(strength, s.scoreTable) : toScore(strength, s.calibration, s.scoreCurve);
}

function toScore(raw, factor, curve = 1) {
  const x = Math.max(0, Number(raw) * Number(factor));
  const c = Number(curve) > 0 ? Number(curve) : 1;
  const v = Math.round(c === 1 ? x : MAX_SCORE * Math.pow(Math.min(1, x / MAX_SCORE), c));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, v));
}

function emptyPlayer() {
  // current: 방금 들어온 값(현재 힘), score: 지금까지의 최댓값(= 최종 점수), rawMax: 점수로 바꾸기 전 세기의 최댓값 (점수표 맞추기용)
  return { score: 0, current: 0, samples: 0, rawMax: 0 };
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
    const v = scoreOf(raw, this.getSettings());
    p.samples += 1;
    p.rawMax = Math.max(p.rawMax, Math.round((Number(raw) || 0) * 10) / 10);
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

module.exports = { Game, PHASE, SAMPLES_NEEDED, MEASURE_TIMEOUT_MS, MAX_SCORE, DEFAULT_CURVE, DEFAULT_SCORE_TABLE, toScore, scoreFromTable, scoreOf, cleanScoreTable };
