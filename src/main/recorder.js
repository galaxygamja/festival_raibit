'use strict';

// 관리자 2페이지 녹화: 100 ms 구간마다 CSV 한 줄, 선택 채널 원시값은 같은 이름의 .raw (int16 LE) 에 이어 쓴다.
// CSV 의 raw_start 는 그 구간 첫 샘플이 .raw 안에서 몇 번째인지라, 나중에 필터를 바꿔 다시 계산할 수 있다.

const fs = require('fs');
const path = require('path');

const MAX_MS = 30 * 60 * 1000; // 잊고 켜 두어도 30분이면 멈춘다
const LABELS = ['', '쉼', '약하게', '중간', '최대'];
const HEADER = 't_ms,label,rms,rms_raw,strength,rest_rms,score,mean,min,max,n,raw_start,phase';

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function num(v, digits) {
  return v == null || !Number.isFinite(v) ? '' : digits ? (Math.round(v * 10 ** digits) / 10 ** digits).toString() : String(v);
}

class Recorder {
  constructor({ dir }) {
    this.dir = dir;
    this._fd = null;
    this._rawFd = null;
    this.file = null;
    this.label = '';
    this.lastFile = null;
    this.lastError = null;
    this._resetWindow();
  }

  get on() {
    return this._fd !== null;
  }

  /** meta 는 CSV 맨 위 # 줄로 남긴다 (버전, 장치, 설정 등) */
  start(now, meta = {}) {
    if (this.on) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const base = path.join(this.dir, 'rec-' + stamp(new Date(now)));
      this.file = base + '.csv';
      this._fd = fs.openSync(this.file, 'w');
      this._rawFd = fs.openSync(base + '.raw', 'w');
      const head = Object.keys(meta).map((k) => '# ' + k + ': ' + JSON.stringify(meta[k])).join('\n');
      fs.writeSync(this._fd, (head ? head + '\n' : '') + '# raw: ' + path.basename(base) + '.raw (int16 LE, 선택 채널 샘플)\n' + HEADER + '\n');
      this.startedAt = now;
      this.rows = 0;
      this.rawCount = 0;
      this.labelCounts = {};
      this.lastError = null;
      this._resetWindow();
    } catch (err) {
      this.lastError = '녹화 시작 실패: ' + err.message;
      console.error('[rec]', this.lastError);
      this._close();
    }
  }

  stop() {
    if (!this.on) return;
    this.lastFile = this.file;
    this._close();
    console.log('[rec] 저장:', this.lastFile);
  }

  setLabel(label) {
    this.label = LABELS.includes(label) ? label : '';
  }

  addSamples(values) {
    if (!this.on || !values.length) return;
    const b = Buffer.alloc(values.length * 2);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
      if (this._n === 0 || v < this._min) this._min = v;
      if (this._n === 0 || v > this._max) this._max = v;
      this._sum += v;
      this._n++;
    }
    this._write(this._rawFd, b);
    this.rawCount += values.length;
  }

  /** 100 ms 구간 하나. w 가 null 이면 끊긴 구간 (값 칸을 비운다) */
  addWindow(w, info, now) {
    if (!this.on) return;
    const n = this._n;
    const row = [
      now - this.startedAt,
      this.label,
      w ? num(w.rms, 2) : '',
      w ? num(w.rmsRaw, 2) : '',
      w ? num(w.strength, 2) : '',
      num(info.restRms, 2),
      w ? num(info.score) : '',
      n ? num(this._sum / n, 1) : '',
      n ? this._min : '',
      n ? this._max : '',
      n,
      this.rawCount - n,
      info.phase || '',
    ];
    this._write(this._fd, row.join(',') + '\n');
    this.rows++;
    if (this.label) this.labelCounts[this.label] = (this.labelCounts[this.label] || 0) + 1;
    this._resetWindow();
    if (now - this.startedAt >= MAX_MS) this.stop();
  }

  status(now) {
    return {
      on: this.on,
      file: this.on ? path.basename(this.file) : null,
      elapsed: this.on ? now - this.startedAt : 0,
      rows: this.on ? this.rows : 0,
      label: this.label,
      labelCounts: this.on ? this.labelCounts : {},
      lastFile: this.lastFile ? path.basename(this.lastFile) : null,
      dir: this.dir,
      error: this.lastError,
    };
  }

  _resetWindow() {
    this._n = 0;
    this._sum = 0;
    this._min = 0;
    this._max = 0;
  }

  _write(fd, data) {
    if (fd === null) return;
    try {
      fs.writeSync(fd, data);
    } catch (err) {
      this.lastError = '녹화 쓰기 실패: ' + err.message;
      console.error('[rec]', this.lastError);
      this.lastFile = this.file;
      this._close();
    }
  }

  _close() {
    for (const k of ['_fd', '_rawFd']) {
      if (this[k] !== null) {
        try { fs.closeSync(this[k]); } catch (_) { /* ignore */ }
      }
      this[k] = null;
    }
  }
}

module.exports = { Recorder, LABELS, HEADER, MAX_MS };
