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
// toScore 는 2.1.7 설정을 옮길 때만 쓴다.
const DEFAULT_CURVE = 0.6;

// 2.1.8 의 점수표 [세기, 점수] 기본값 (옮기기용). 보정 176 · 곡선 0.6 과 거의 같다.
const DEFAULT_SCORE_TABLE = [[0, 0], [2, 1300], [5, 2300], [10, 3500], [20, 5300], [31, 7000], [45, 8700], [57, 9999]];

// 점수 설정 settings.score (2.1.9~). 세기는 장치·전극·필터마다 크기가 달라서, 점수표는 "기준 힘"에 대한 % 로 둔다.
//   ref    기준 힘 (세기). 운영자가 최대로 쥐었을 때의 세기를 재서 넣는다 (자동 보정 / "최대 힘 재기"). 이 힘이 100%
//   top    곡선 버튼으로 만들 때 기준 힘(100%)의 점수
//   curve  곡선 모양 (지수, 1 = 직선, 작을수록 처음에 점수가 빨리 오르고 높은 점수는 어렵다). 점을 직접 고치면 null
//   points [[기준 대비 %, 점수], …] 점수 계산은 이것만 본다. 점과 점 사이는 직선, 마지막 점 위는 그 점수 그대로
// 기본: 기준 힘 31 (실제 녹화의 최대 힘, 80 Hz 고역) = 7000점, 곡선 0.6 (2.1.7 · 2.1.8 기본과 같은 모양)
const CURVE_PCTS = [0, 2.5, 5, 10, 20, 35, 50, 70, 100, 130, 160, 200, 260, 340];
const CURVE_PRESETS = [
  { curve: 1, name: '직선' },
  { curve: 0.8, name: '완만' },
  { curve: 0.6, name: '보통' },
  { curve: 0.45, name: '가파름' },
];

/** 곡선 모양 → 점수표 점들: 점수 = top × (%/100)^curve, 9999 에 닿는 % 에서 끝 */
function curvePoints(curve, top = 7000) {
  const k = Number(curve) > 0 ? Number(curve) : DEFAULT_CURVE;
  const t = Math.max(1, Math.min(MAX_SCORE, Number(top) || 7000));
  const pmax = 100 * Math.pow(MAX_SCORE / t, 1 / k);
  const pts = CURVE_PCTS.filter((p) => p < pmax - 0.5).map((p) => [p, Math.round(t * Math.pow(p / 100, k))]);
  pts.push([Math.round(pmax * 10) / 10, MAX_SCORE]);
  return pts;
}

const DEFAULT_SCORE = { ref: 31, top: 7000, curve: DEFAULT_CURVE, points: curvePoints(DEFAULT_CURVE, 7000) };

function defaultScore() {
  return { ...DEFAULT_SCORE, points: DEFAULT_SCORE.points.map((p) => p.slice()) };
}

/** 점들을 정리한다: 숫자만, 오름차순, 같은 x 는 하나, 점수 0~9999. 2개 미만이면 null */
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

/** 점수표로 x → 점수. 첫 점 아래는 (0, 0) 에서 첫 점까지 직선, 마지막 점 위는 마지막 점수 그대로 */
function scoreFromTable(x, table) {
  const s = Math.max(0, Number(x) || 0);
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

/** settings.score 정리. 쓸 수 없으면 null */
function cleanScore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ref = Number(raw.ref);
  if (!(ref > 0) || !Number.isFinite(ref)) return null;
  const curve = Number(raw.curve) > 0 && Number(raw.curve) <= 2 ? Math.round(Number(raw.curve) * 100) / 100 : null;
  const top = Number.isFinite(Number(raw.top)) ? Math.max(1, Math.min(MAX_SCORE, Math.round(Number(raw.top)))) : 7000;
  const points = cleanScoreTable(raw.points) || (curve ? curvePoints(curve, top) : null);
  if (!points) return null;
  return { ref: Math.round(Math.min(100000, ref) * 100) / 100, top, curve, points };
}

/** 2.1.8 의 [세기, 점수] 표 → 기준 힘 + % 표. 기준 힘 = 7000점이 되는 세기 (못 미치면 마지막 점) */
function scoreFromLegacyTable(table) {
  const t = cleanScoreTable(table);
  if (!t || JSON.stringify(t) === JSON.stringify(DEFAULT_SCORE_TABLE)) return defaultScore();
  let ref = t[t.length - 1][0], top = t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [s0, v0] = t[i - 1], [s1, v1] = t[i];
    if (v0 <= 7000 && v1 >= 7000 && v1 > v0) { ref = s0 + ((s1 - s0) * (7000 - v0)) / (v1 - v0); top = 7000; break; }
  }
  if (!(ref > 0)) return defaultScore();
  return cleanScore({ ref, top, curve: null, points: t.map(([s, v]) => [Math.round((s / ref) * 10000) / 100, v]) }) || defaultScore();
}

/** 세기 → 기준 힘 대비 % */
function pctOf(strength, score) {
  const ref = score && score.ref > 0 ? score.ref : DEFAULT_SCORE.ref;
  return (Math.max(0, Number(strength) || 0) / ref) * 100;
}

/** 설정에 맞는 점수 계산 */
function scoreOf(strength, settings) {
  const sc = (settings && settings.score) || DEFAULT_SCORE;
  return scoreFromTable(pctOf(strength, sc), sc.points);
}

function toScore(raw, factor, curve = 1) {
  const x = Math.max(0, Number(raw) * Number(factor));
  const c = Number(curve) > 0 ? Number(curve) : 1;
  const v = Math.round(c === 1 ? x : MAX_SCORE * Math.pow(Math.min(1, x / MAX_SCORE), c));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, v));
}

function emptyPlayer() {
  // current: 방금 들어온 값(현재 힘), score: 지금까지의 최댓값(= 최종 점수), rawMax: 점수로 바꾸기 전 세기의 최댓값 (기준 힘 맞추기용)
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

module.exports = {
  Game, PHASE, SAMPLES_NEEDED, MEASURE_TIMEOUT_MS, MAX_SCORE, DEFAULT_CURVE, DEFAULT_SCORE_TABLE, DEFAULT_SCORE, CURVE_PRESETS,
  toScore, scoreFromTable, scoreOf, pctOf, cleanScoreTable, cleanScore, curvePoints, defaultScore, scoreFromLegacyTable,
};
