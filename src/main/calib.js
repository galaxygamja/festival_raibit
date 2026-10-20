'use strict';

// 자동 보정 (관리자 3페이지). 쉬는 동안과 최대로 힘 주는 동안 원시 샘플을 모두 모아, 이 노트북·이 장소에 맞는 신호 설정을 고른다.
//   전원 주파수: 쉼 신호를 60 Hz / 50 Hz 노치로 각각 걸러 쉼 RMS 가 더 낮은 쪽
//   채널·고역 통과: 후보마다 "최대 힘 ÷ 쉴 때 흔들림 상한"이 가장 큰 조합 (차이가 작으면 지금 값을 둔다)
//   영점·여유: 고른 설정으로 쉴 때 구간 RMS 의 평균과, 그 위로 흔들리는 폭
//   최대 힘: 고른 설정으로 힘 준 구간 세기의 최댓값 (점수표의 기준 힘 = 100%)
// 구간은 실제 점수 경로처럼 메인의 100 ms 타이머로 끊는다. 순수 함수(analyzeCalibration)와 시간을 인자로 받는 진행기(AutoCal)로 나눠 테스트한다.

const { EmgFilter } = require('./emg');

const MAINS = [60, 50];
const HIGHPASS = [30, 50, 80, 120]; // 30 Hz 아래는 팔·전선 움직임이 커서 후보에서 뺀다
const SETTLE_WINDOWS = 3; // 필터가 자리 잡는 동안의 첫 구간들은 빼고 본다
const MIN_RATIO = 2.5; // 최대 힘이 쉼 흔들림 상한의 이 배수보다 작으면 "힘 준 신호가 안 보인다"
const KEEP_IF_WITHIN = 0.1; // 후보가 지금 설정보다 10% 이상 낫지 않으면 지금 설정을 둔다
const MARGIN_MIN = 0.5;

// 단계별 길이 (ms). full = 쉼 → 준비 → 힘, noise = 쉼만, max = 준비 → 힘 (지금 설정 그대로 최대 힘만)
const STEPS = {
  full: [['rest', 5000], ['prep', 2500], ['squeeze', 4000]],
  noise: [['rest', 5000]],
  max: [['prep', 2500], ['squeeze', 4000]],
};

function round(v, d = 2) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/** 한 채널을 설정 하나로 거른 뒤 구간마다 RMS (구간 평균을 뺀다, EmgWindow 와 같다) */
function windowRms(samples, windows, rate, opts) {
  const f = new EmgFilter(rate, opts).process(samples);
  return windows.map((w) => {
    const n = w.end - w.start;
    if (n <= 0) return null;
    let s = 0, s2 = 0;
    for (let i = w.start; i < w.end; i++) { s += f[i]; s2 += f[i] * f[i]; }
    const v = s2 / n - (s / n) ** 2;
    return v > 0 ? Math.sqrt(v) : 0;
  });
}

/** 구간 RMS → 쉼 / 힘 통계 */
function measure(samples, windows, rate, opts) {
  const r = windowRms(samples, windows, rate, opts);
  const rest = [], sq = [];
  r.forEach((v, i) => {
    if (v == null || i < SETTLE_WINDOWS) return;
    if (windows[i].phase === 'rest') rest.push(v);
    else if (windows[i].phase === 'squeeze') sq.push(v);
  });
  const rs = rest.slice().sort((a, b) => a - b);
  const restMid = quantile(rs, 0.5); // 영점: 중간값 (쉬다가 한두 번 움찔한 구간에 끌려가지 않게)
  const restHigh = quantile(rs, 0.95); // 쉴 때 흔들림 상한
  const ss = sq.slice().sort((a, b) => b - a);
  const top = ss.slice(0, Math.max(1, Math.ceil(ss.length / 4)));
  const sqTop = top.reduce((a, b) => a + b, 0) / top.length; // 힘 준 구간 위쪽 1/4 평균 (한 번 튄 값보다 꾸준한 힘을 본다)
  const sqMax = ss.length ? ss[0] : 0;
  const ceiling = Math.max(restHigh, restMid * 1.05, 0.1);
  return { opts, rest, sq, restMid, restHigh, sqMax, ratio: sq.length ? sqTop / ceiling : 0 };
}

/**
 * @param {object} input
 * @param {number} input.rate 장치 샘플레이트 (MSF)
 * @param {number[][]} input.channels 채널마다 원시 샘플 (모은 순서 그대로)
 * @param {{start:number,end:number,phase:string}[]} input.windows 100 ms 구간 (샘플 번호)
 * @param {object} input.current 지금 settings.emg
 * @param {'full'|'noise'|'max'} input.mode
 */
function analyzeCalibration({ rate = 10000, channels = [], windows = [], current = {}, mode = 'full' }) {
  const cur = {
    channel: current.channel === 2 ? 2 : 1,
    mainsHz: current.mainsHz === 50 ? 50 : 60,
    notch: current.notch !== false,
    highpassHz: Number.isFinite(current.highpassHz) ? current.highpassHz : 80,
    restRms: current.restRms || 0,
    margin: Number.isFinite(current.margin) ? current.margin : 1.5,
  };
  const out = { ok: false, mode, emg: null, maxStrength: null, report: [], warnings: [] };
  const n = channels.length ? channels[0].length : 0;
  const seconds = n / (rate || 10000);
  const hasRest = windows.some((w) => w.phase === 'rest');
  const hasSq = windows.some((w) => w.phase === 'squeeze');
  if (!n || windows.length < SETTLE_WINDOWS + 5) {
    out.error = 'SpikerBox 신호가 거의 안 들어왔습니다. 연결(2페이지 진단)을 확인하고 다시 해 주세요.';
    return out;
  }
  const chCount = channels.length;
  const chIdx = (ch) => (ch - 1 < chCount ? ch - 1 : 0);

  // 10비트 장치(0~1023)인데 끝값에 많이 붙어 있으면 신호가 잘린 것
  channels.forEach((c, i) => {
    let mx = -Infinity, clip = 0;
    for (const v of c) { if (v > mx) mx = v; }
    if (mx > 1023) return;
    for (const v of c) if (v <= 0 || v >= 1023) clip++;
    if (clip / c.length > 0.001) out.warnings.push('채널 ' + (i + 1) + ' 신호가 끝값(0/1023)에 닿습니다. 전극 연결을 확인하세요.');
  });

  const emg = { ...cur };
  let channel = chIdx(cur.channel);

  // 1) 전원 주파수: 쉬는 신호에서 남는 잡음이 적은 쪽 (힘 준 구간과 상관없다)
  if (hasRest) {
    const by = MAINS.map((hz) => ({ hz, m: measure(channels[channel], windows, rate, { mainsHz: hz, notch: true, highpassHz: cur.highpassHz || 80 }) }));
    by.sort((a, b) => a.m.restMid - b.m.restMid);
    const [best, other] = by;
    const pick = best.m.restMid < other.m.restMid * 0.97 ? best.hz : cur.mainsHz;
    emg.mainsHz = pick;
    emg.notch = true;
    out.report.push('전원 잡음: ' + pick + ' Hz 로 거름 (쉴 때 RMS ' + by.map((b) => b.hz + ' Hz ' + round(b.m.restMid, 1)).join(' · ') + ')');
  }

  // 2) 채널·고역 통과: 최대 힘이 쉼 흔들림 위로 가장 많이 올라오는 조합
  if (mode === 'full' && hasRest && hasSq) {
    const cands = [];
    for (let c = 0; c < chCount; c++) {
      for (const hp of HIGHPASS) cands.push({ c, hp, m: measure(channels[c], windows, rate, { mainsHz: emg.mainsHz, notch: true, highpassHz: hp }) });
    }
    const curCand = cands.find((x) => x.c === channel && x.hp === cur.highpassHz);
    cands.sort((a, b) => b.m.ratio - a.m.ratio);
    let best = cands[0];
    if (curCand && curCand.m.ratio >= best.m.ratio * (1 - KEEP_IF_WITHIN)) best = curCand;
    if (best.m.ratio < MIN_RATIO) {
      out.warnings.push('힘 줄 때 신호가 쉴 때와 거의 같습니다 (' + round(best.m.ratio, 1) + '배). 전극 위치·연결을 확인하고, 최대로 꽉 쥐면서 다시 해 주세요. 채널·고역은 그대로 둡니다.');
    } else {
      channel = best.c;
      emg.channel = best.c + 1;
      emg.highpassHz = best.hp;
    }
    const perCh = [];
    for (let c = 0; c < chCount; c++) {
      const top = cands.filter((x) => x.c === c).sort((a, b) => b.m.ratio - a.m.ratio)[0];
      perCh.push('채널 ' + (c + 1) + ' ' + round(top.m.ratio, 1) + '배');
    }
    out.report.push('채널: ' + emg.channel + ' (최대 힘 ÷ 쉴 때 상한: ' + perCh.join(' · ') + ')');
    out.report.push('고역 통과: ' + emg.highpassHz + ' Hz (' + HIGHPASS.map((hp) => {
      const x = cands.find((y) => y.c === channel && y.hp === hp);
      return hp + ' Hz ' + round(x.m.ratio, 1) + '배';
    }).join(' · ') + ')');
  }

  const fin = measure(channels[channel], windows, rate, { mainsHz: emg.mainsHz, notch: emg.notch, highpassHz: emg.highpassHz });

  // 3) 영점·여유: 쉴 때 중간값, 그리고 쉴 때 흔들림이 0점이 되도록 그 위 폭 × 1.5 + 0.5
  if (hasRest) {
    if (fin.rest.length < 10) {
      out.error = '쉬는 동안 신호가 너무 적게 들어왔습니다. 다시 해 주세요.';
      return out;
    }
    emg.restRms = round(fin.restMid, 2);
    emg.margin = Math.max(MARGIN_MIN, round((fin.restHigh - fin.restMid) * 1.5 + 0.5, 1));
    const spread = fin.restHigh - fin.restMid;
    out.report.push('영점 ' + emg.restRms + ' · 여유 ' + emg.margin + ' (쉴 때 거른 RMS ' + round(fin.restMid, 1) + ', 흔들림 +' + round(spread, 1) + ')');
    if (spread > Math.max(3, fin.restMid)) out.warnings.push('쉬는 동안 신호가 많이 흔들렸습니다. 팔을 움직였거나 잡음이 큰 곳일 수 있습니다. 가만히 있는 상태로 다시 해 보세요.');
  }

  // 4) 최대 힘 (기준 힘 후보)
  if (hasSq) {
    const st = Math.max(0, fin.sqMax - emg.restRms - emg.margin);
    out.maxStrength = round(st, 1);
    out.report.push('최대 힘 세기 ' + out.maxStrength + ' (거른 RMS 최고 ' + round(fin.sqMax, 1) + ')');
    if (st < 1) out.warnings.push('최대 힘이 거의 0 입니다. 힘을 주는 동안 신호가 들어오지 않았습니다.');
  }

  if (seconds > 0) {
    const expected = windows.length * 0.1 * rate;
    if (n < expected * 0.5) out.warnings.push('샘플이 기대보다 적게 들어옵니다 (' + Math.round((n / expected) * 100) + '%). USB 연결을 확인하세요.');
  }
  out.ok = true;
  out.emg = emg;
  return out;
}

/** 단계 진행 + 샘플 모으기. 시간은 인자로 받는다 */
class AutoCal {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = null;
    this.phase = 'off';
    this.result = null;
    this.channels = [];
    this.windows = [];
    this._winStart = 0;
  }

  get running() {
    return this.mode !== null && this.phase !== 'done' && this.phase !== 'off';
  }

  start(mode, now) {
    this.reset();
    this.mode = STEPS[mode] ? mode : 'full';
    this.startedAt = now;
    this.rate = 10000;
    this.phase = STEPS[this.mode][0][0];
  }

  cancel() {
    this.reset();
  }

  /** SpikerBox 프레임 (프레임마다 채널 값 배열) */
  addFrames(frames, rate) {
    if (!this.running || !frames.length) return;
    if (rate) this.rate = rate;
    const ch = frames[0].length;
    while (this.channels.length < ch) this.channels.push(this.channels.length ? new Array(this.channels[0].length).fill(512) : []);
    for (const f of frames) for (let c = 0; c < this.channels.length; c++) this.channels[c].push(f[c] == null ? f[0] : f[c]);
  }

  /** 100 ms 마다: 지난 구간을 끊고 단계를 넘긴다. 끝나면 분석해서 true */
  tick(now, current) {
    if (!this.running) return false;
    const end = this.channels.length ? this.channels[0].length : 0;
    this.windows.push({ start: this._winStart, end, phase: this.phase });
    this._winStart = end;
    const t = now - this.startedAt;
    let acc = 0, next = 'done';
    for (const [name, ms] of STEPS[this.mode]) {
      acc += ms;
      if (t < acc) { next = name; break; }
    }
    this.phase = next;
    if (next !== 'done') return false;
    this.result = analyzeCalibration({ rate: this.rate, channels: this.channels, windows: this.windows, current, mode: this.mode });
    this.channels = [];
    this.windows = [];
    return true;
  }

  status(now) {
    if (!this.mode) return { phase: 'off' };
    const steps = STEPS[this.mode];
    let acc = 0, left = 0, step = 0;
    const t = now - this.startedAt;
    for (let i = 0; i < steps.length; i++) {
      acc += steps[i][1];
      if (steps[i][0] === this.phase) { left = Math.max(0, acc - t); step = i; break; }
    }
    return {
      mode: this.mode, phase: this.phase, left, step, steps: steps.map((s) => s[0]),
      total: steps.reduce((a, s) => a + s[1], 0), elapsed: Math.min(t, steps.reduce((a, s) => a + s[1], 0)),
      result: this.result,
    };
  }
}

module.exports = { analyzeCalibration, AutoCal, STEPS, HIGHPASS };
