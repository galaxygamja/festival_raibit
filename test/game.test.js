'use strict';

// node test/game.test.js — 아두이노·Electron 없이 경기 로직, 명예의 전당, 저장, 줄 파싱을 검사한다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, toScore } = require('../src/main/game');
const hall = require('../src/main/hall');
const { Store, normalizeSettings } = require('../src/main/store');

// serial.js 는 serialport 를 불러오므로 parseLine 만 따로 검사
const { SerialManager, parseLine, classifyProbe, roleKeyOf, retryDelay } = require('../src/main/serial');
const { Simulator } = require('../src/main/sim');

const { SpikerBoxParser, parseMessageText, encodeFrames, encodeMessage } = require('../src/main/spikerbox');
const { EmgWindow, EmgFilter, strengthOf, RestMeter } = require('../src/main/emg');
const { unwrapReport, buildCommand, deviceKey, pickDevices } = require('../src/main/hid');
const { Diag, buckets } = require('../src/main/diag');
const { Recorder, HEADER } = require('../src/main/recorder');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FAIL  ' + name);
    throw err;
  }
}

function makeGame(settings) {
  const results = [];
  const s = settings || { calibration: 1 };
  const g = new Game({ getSettings: () => s, onResult: (r) => results.push(r) });
  return { g, results, s };
}

/** 0.1초 간격으로 값을 넣는다 */
function feed(g, t0, n, f) {
  let t = t0;
  for (let i = 0; i < n; i++) {
    t += 100;
    g.sample('p1', f(i), t);
  }
  return t;
}

console.log('경기 흐름');

test('IDLE → MEASURING → 50개 차면 바로 RESULT, 현재 값과 최댓값 따로', () => {
  const { g, results } = makeGame();
  assert.strictEqual(g.phase, 'idle');
  assert.ok(g.start(0));
  assert.strictEqual(g.phase, 'measuring');
  let t = feed(g, 0, 49, (i) => (i === 10 ? 4270 : 100));
  assert.strictEqual(g.phase, 'measuring');
  const snap = g.snapshot();
  assert.strictEqual(snap.p1.samples, 49);
  assert.strictEqual(snap.p1.score, 4270); // 최댓값
  assert.strictEqual(snap.p1.current, 100); // 방금 들어온 값
  assert.strictEqual(snap.p2, undefined);
  assert.strictEqual(snap.winner, undefined);
  feed(g, t, 1, () => 1);
  assert.strictEqual(g.phase, 'result'); // 판정 대기 없이 바로
  assert.deepStrictEqual(results, [{ score: 4270 }]);
});

test('50개 넘게 들어온 값은 무시, p1 이 아닌 입력도 무시', () => {
  const { g } = makeGame();
  g.start(0);
  g.sample('p2', 5000, 50);
  assert.strictEqual(g.p1.samples, 0);
  feed(g, 0, 50, () => 100);
  g.sample('p1', 9000, 5100);
  assert.strictEqual(g.p1.score, 100);
  assert.strictEqual(g.p1.samples, 50);
  assert.strictEqual(g.phase, 'result');
});

test('MEASURING 중 START 무시, RESULT 에서 START 하면 0으로 비우고 재측정', () => {
  const { g } = makeGame();
  g.start(0);
  feed(g, 0, 10, () => 500);
  assert.strictEqual(g.start(1500), false);
  assert.strictEqual(g.p1.samples, 10);
  const t = feed(g, 1000, 40, () => 500);
  assert.strictEqual(g.phase, 'result');
  assert.ok(g.start(t + 100));
  assert.strictEqual(g.phase, 'measuring');
  assert.strictEqual(g.p1.score, 0);
  assert.strictEqual(g.p1.current, 0);
  assert.strictEqual(g.p1.samples, 0);
});

test('8초 안전장치: 신호가 끊겨도 받은 것까지로 확정', () => {
  const { g, results } = makeGame();
  g.start(0);
  feed(g, 0, 12, () => 200);
  g.tick(7999);
  assert.strictEqual(g.phase, 'measuring');
  g.tick(8000);
  assert.strictEqual(g.phase, 'result');
  assert.deepStrictEqual(results, [{ score: 200 }]);
});

test('경기 중지: 기록 없이 IDLE, IDLE/RESULT 에서는 아무 일 없음', () => {
  const { g, results } = makeGame();
  assert.strictEqual(g.stop(), false);
  g.start(0);
  const t = feed(g, 0, 30, () => 300);
  assert.ok(g.stop());
  assert.strictEqual(g.phase, 'idle');
  g.tick(t + 10000);
  assert.strictEqual(results.length, 0);
  assert.strictEqual(g.p1.score, 0);
  g.start(t + 20000);
  feed(g, t + 20000, 50, () => 300);
  assert.strictEqual(g.phase, 'result');
  assert.strictEqual(g.stop(), false);
});

test('보정계수는 숫자 하나, 0~9999 로 자름', () => {
  const { g } = makeGame({ calibration: 0.5 });
  g.start(0);
  feed(g, 0, 50, () => 1001);
  assert.strictEqual(g.p1.score, 501); // round(500.5)
  assert.strictEqual(toScore(-5, 1), 0);
  assert.strictEqual(toScore(6000, 2), 9999);
});

console.log('명예의 전당');

const D = new Date('2026-10-19T12:00:00Z');

function seed(scores) {
  // 서로 다른 시각에 세운 기록들 (앞쪽이 먼저)
  let recs = [];
  scores.forEach((sc, i) => { recs = hall.addResult(recs, sc, new Date(D.getTime() + i * 1000)).records; });
  return recs;
}

test('모든 기록이 남고, 명예의 전당은 상위 5개', () => {
  let r = hall.addResult([], 3815, D);
  assert.ok(r.changed);
  assert.deepStrictEqual([r.rank, r.place, r.total], [1, 1, 1]);
  r = hall.addResult(r.records, 4270, D);
  assert.deepStrictEqual([r.rank, r.place, r.total], [1, 1, 2]);
  assert.deepStrictEqual(hall.hallOf(r.records).map((e) => [e.score, e.name]), [[4270, 'ㅇㅇㅇ'], [3815, 'ㅇㅇㅇ']]);
  assert.strictEqual(r.records[0].at, D.toISOString());
  assert.ok(!('player' in r.records[0]));
  const recs = seed([9000, 8000, 7000, 6000, 5000, 4000, 3000]);
  assert.strictEqual(recs.length, 7);
  assert.deepStrictEqual(hall.hallOf(recs).map((e) => e.score), [9000, 8000, 7000, 6000, 5000]);
});

test('5위 밖이면 rank null 이지만 전체 순위(place)는 나온다, 0점은 남기지 않는다', () => {
  const recs = seed([9000, 8000, 7000, 6000, 5000]);
  let r = hall.addResult(recs, 5000, new Date(D.getTime() + 99000));
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual([r.rank, r.place, r.total], [null, 6, 6]);
  r = hall.addResult(recs, 9500, new Date(D.getTime() + 99000));
  assert.deepStrictEqual([r.rank, r.place], [1, 1]);
  r = hall.addResult(recs, 0, D);
  assert.deepStrictEqual([r.changed, r.rank, r.place, r.total], [false, null, null, 5]);
});

test('같은 점수면 먼저 세운 기록이 위', () => {
  const recs = [{ id: 'old', score: 6000, name: '선배', at: '2026-01-01T00:00:00Z' }];
  const r = hall.addResult(recs, 6000, D);
  assert.strictEqual(r.rank, 2);
  assert.deepStrictEqual(hall.hallOf(r.records).map((e) => e.name), ['선배', 'ㅇㅇㅇ']);
});

test('이름·점수 수정: 빈 이름은 ㅇㅇㅇ, 점수는 0~9999, 잘못된 점수는 무시, 순위 다시 매김', () => {
  const recs = seed([100, 50, 30]);
  const [a, b, c] = hall.sortRecords(recs).map((e) => e.id);
  const next = hall.editRecords(recs, {
    [a]: { name: '  김 철수  ' },
    [b]: { name: '   ', score: 99999 },
    [c]: { score: 'abc' },
    없는id: { name: 'x' },
  });
  const byId = Object.fromEntries(next.map((e) => [e.id, e]));
  assert.deepStrictEqual([byId[a].name, byId[a].score], ['김 철수', 100]);
  assert.deepStrictEqual([byId[b].name, byId[b].score], ['ㅇㅇㅇ', 9999]);
  assert.strictEqual(byId[c].score, 30);
  assert.deepStrictEqual(hall.hallOf(next).map((e) => e.id), [b, a, c]);
  assert.strictEqual(hall.editRecords(recs, null), recs);
});

test('하나씩 지우기, 0점으로 고친 기록은 명예의 전당에서 빠진다', () => {
  const recs = seed([300, 200, 100]);
  const [top, mid] = hall.sortRecords(recs).map((e) => e.id);
  const del = hall.deleteRecords(recs, [top]);
  assert.deepStrictEqual(del.map((e) => e.score).sort((x, y) => y - x), [200, 100]);
  assert.strictEqual(hall.deleteRecords(recs, 'bad').length, 3);
  const zero = hall.editRecords(recs, { [mid]: { score: 0 } });
  assert.deepStrictEqual(hall.hallOf(zero).map((e) => e.score), [300, 100]);
});

test('v2.0.x 파일 옮기기: 명예의 전당 이름은 살리고, 나머지 점수는 임시 이름으로', () => {
  const oldHall = [
    { id: 'h1', name: '홍길동', score: 7812, player: 'PLAYER 1', at: '2026-10-20T01:00:00Z' },
    { id: 'h2', name: 'ㅇㅇㅇ', score: 500, at: '2026-10-20T02:00:00Z' },
  ];
  const recs = hall.migrateRecords(oldHall, [500, 300, 7812, 0, 'x', 300]);
  assert.deepStrictEqual(hall.sortRecords(recs).map((e) => e.name + ' ' + e.score), ['홍길동 7812', 'ㅇㅇㅇ 500', 'ㅇㅇㅇ 300', 'ㅇㅇㅇ 300']);
  assert.ok(recs.every((e) => !('player' in e)));
  assert.deepStrictEqual(hall.migrateRecords(null, null), []);
  assert.deepStrictEqual(hall.normalizeRecords('bad'), []);
  const norm = hall.normalizeRecords([{ id: 'a', score: '12' }, { id: 'a', score: 20000, name: 'x' }, { score: 'nope' }]);
  assert.deepStrictEqual(norm.map((e) => [e.score, e.name]), [[12, 'ㅇㅇㅇ'], [9999, 'x']]);
  assert.notStrictEqual(norm[0].id, norm[1].id);
});

console.log('저장');

const DEFAULTS = { calibration: 176, scoreCurve: 0.6, emg: { channel: 1, restRms: 0, filtered: true }, portRoles: {}, fullscreen: true };

test('저장 후 다시 읽어도 유지 (앱 재시작 흉내), 손상 파일은 기본값', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-'));
  const store = new Store(dir);
  assert.deepStrictEqual(store.loadSettings(), DEFAULTS);
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  const custom = normalizeSettings({ calibration: 1.25, emg: { channel: 2, restRms: 12.5 }, portRoles: { '/dev/a': 'start' }, fullscreen: false });
  store.saveSettings(custom);
  let r = hall.addResult([], 3815, D);
  r = hall.addResult(r.records, 4270, D);
  const top = hall.sortRecords(r.records)[0].id;
  assert.strictEqual(store.loadRecords(), null); // 아직 records.json 없음 → 옛 파일에서 옮겨야 함
  store.saveRecords(hall.editRecords(r.records, { [top]: { name: '홍길동' } }));

  const again = new Store(dir);
  assert.deepStrictEqual(again.loadSettings(), custom);
  assert.strictEqual(custom.emg.channel, 2);
  const loaded = hall.sortRecords(hall.normalizeRecords(again.loadRecords()));
  assert.deepStrictEqual(loaded.map((e) => e.name + ' ' + e.score), ['홍길동 4270', 'ㅇㅇㅇ 3815']);
  assert.ok(!fs.existsSync(path.join(dir, 'records.json.tmp')));

  fs.writeFileSync(path.join(dir, 'records.json'), '{ broken');
  assert.deepStrictEqual(hall.normalizeRecords(again.loadRecords()), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('records.json.corrupt-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('설정값 범위 정리, v1 설정(calibration {p1,p2}) 이전', () => {
  assert.deepStrictEqual(normalizeSettings({ calibration: 'abc', fullscreen: 'yes' }), DEFAULTS);
  assert.deepStrictEqual(normalizeSettings({ calibration: { p1: 2, p2: 3 } }), { ...DEFAULTS, calibration: 2 });
  const s = normalizeSettings({ calibration: -1, emg: { channel: 9, restRms: -4 }, portRoles: { a: 'start', b: 'x', c: 'spikerbox' } });
  assert.strictEqual(s.calibration, 0.001);
  assert.deepStrictEqual(s.emg, { channel: 1, restRms: 0, filtered: true });
  assert.deepStrictEqual(s.portRoles, { a: 'start', c: 'spikerbox' });
});

test('v2.1.6 이전 설정: 거르지 않은 영점은 지우고, 예전 기본 보정(1)은 새 기본값으로', () => {
  const old = normalizeSettings({ calibration: 1, emg: { channel: 1, restRms: 32.4 } });
  assert.strictEqual(old.calibration, 176);
  assert.strictEqual(old.emg.restRms, 0);
  assert.strictEqual(normalizeSettings({ calibration: 3, emg: { restRms: 9 } }).calibration, 3); // 직접 바꾼 보정은 유지
  const now = normalizeSettings({ calibration: 1, emg: { channel: 2, restRms: 2.5, filtered: true } });
  assert.deepStrictEqual([now.calibration, now.emg.restRms], [1, 2.5]);
  assert.strictEqual(normalizeSettings({ scoreCurve: 5 }).scoreCurve, 1);
});

test('점수 곡선: 1 이면 직선, 0.6 이면 높은 점수일수록 더 많은 힘이 든다', () => {
  assert.strictEqual(toScore(35, 158), 5530);
  assert.strictEqual(toScore(35, 158, 1), 5530);
  assert.strictEqual(toScore(35, 158, 0.6), 7008); // 실제 녹화의 최대 힘 ≈ 7000점
  assert.strictEqual(toScore(0, 158, 0.6), 0);
  assert.strictEqual(toScore(1000, 158, 0.6), 9999);
  // 같은 세기 차이(+10)라도 위로 갈수록 점수가 덜 오른다
  const d1 = toScore(15, 158, 0.6) - toScore(5, 158, 0.6), d2 = toScore(45, 158, 0.6) - toScore(35, 158, 0.6);
  assert.ok(d1 > d2 * 1.5, d1 + ' vs ' + d2);
});

test('전원 잡음 필터: 60 Hz 와 배수는 거의 없애고, 근육 대역(100~400 Hz)은 대부분 남긴다', () => {
  const rms = (fn) => {
    const f = new EmgFilter(10000);
    const x = Array.from({ length: 20000 }, (_, i) => 512 + fn(i / 10000));
    const y = f.process(x).slice(10000);
    const m = y.reduce((a, b) => a + b, 0) / y.length;
    return Math.sqrt(y.reduce((a, b) => a + (b - m) ** 2, 0) / y.length);
  };
  const sine = (hz) => (t) => 100 * Math.sin(2 * Math.PI * hz * t); // RMS 70.7
  for (const hz of [60, 180, 300]) assert.ok(rms(sine(hz)) < 7, hz + ' Hz ' + rms(sine(hz)));
  for (const hz of [130, 240, 360]) assert.ok(rms(sine(hz)) > 40, hz + ' Hz ' + rms(sine(hz)));
  assert.ok(rms(() => 0) < 0.01); // 직류(512)만 있으면 0
});

test('v1 명예의 전당 파일(player 있음)을 읽으면 player 는 버린다', () => {
  const h = hall.normalizeRecords([{ id: 'a', name: '옛날', score: 123, player: 'PLAYER 2', at: '2026-01-01T00:00:00Z' }]);
  assert.strictEqual(h.length, 1);
  assert.ok(!('player' in h[0]));
  assert.strictEqual(h[0].score, 123);
});

console.log('시리얼 줄 형식');

test('START/ALIVE 파싱, 나머지는 무시', () => {
  assert.deepStrictEqual(parseLine('START'), { type: 'start' });
  assert.deepStrictEqual(parseLine(' start\r'), { type: 'start' });
  assert.deepStrictEqual(parseLine('ALIVE'), { type: 'alive' });
  for (const bad of ['P1 100', '', 'STARTX', 'hello']) assert.strictEqual(parseLine(bad), null, bad);
});

test('classifyProbe: HWT 가 있거나 프레임 20개 이상이면 SpikerBox', () => {
  assert.strictEqual(classifyProbe({ messages: [{ type: 'HWT', value: 'MUSCLESS' }], frameCount: 0 }), true);
  assert.strictEqual(classifyProbe({ messages: [], frameCount: 25 }), true);
  assert.strictEqual(classifyProbe({ messages: [{ type: 'EVNT', value: '1' }], frameCount: 5 }), false);
});

console.log('SpikerBox 파서 · 근전도 신호');

const F1 = [[0], [8191], [16383], [512]];
const F2 = [[1, 2], [8192, 100], [16383, 0]];
const flat = (frames) => [].concat.apply([], frames);

test('1채널·2채널 프레임 왕복', () => {
  assert.deepStrictEqual(new SpikerBoxParser({ channels: 1 }).push(encodeFrames(F1)).frames, F1);
  assert.deepStrictEqual(new SpikerBoxParser({ channels: 2 }).push(encodeFrames(F2)).frames, F2);
});

test('1바이트씩 나눠 넣어도 결과가 같다', () => {
  const buf = Buffer.concat([encodeFrames(F1), encodeMessage('HWT:MUSCLESS;'), encodeFrames(F1)]);
  const whole = new SpikerBoxParser({ channels: 1 }).push(buf);
  const p = new SpikerBoxParser({ channels: 1 });
  const frames = [];
  const messages = [];
  for (const byte of buf) {
    const r = p.push([byte]);
    frames.push.apply(frames, r.frames);
    messages.push.apply(messages, r.messages);
  }
  assert.deepStrictEqual(frames, whole.frames);
  assert.deepStrictEqual(messages, whole.messages);
  assert.strictEqual(frames.length, 8);
});

test('프레임 중간의 0x80 바이트는 그 프레임만 버린다', () => {
  const a = encodeFrames([[100, 200], [300, 400]]);
  const bad = Buffer.from([0x81]); // 2채널 프레임 중간에 새 시작 바이트
  const buf = Buffer.concat([a.slice(0, 2), bad, a.slice(4)]);
  // a[0..1] ch1 of frame1, 끼워 넣은 0x81 로 프레임 재시작 → 이후 a[4..] 는 새 프레임으로 정상 해석되지 않고 버려짐
  const r = new SpikerBoxParser({ channels: 2 }).push(Buffer.concat([buf, encodeFrames([[7, 8]])]));
  assert.deepStrictEqual(r.frames[r.frames.length - 1], [7, 8]);
  assert.ok(r.frames.length < 3);
});

test('기기 메시지는 frames 에 섞이지 않고, 청크를 중간에서 잘라도 같다', () => {
  const buf = Buffer.concat([encodeFrames(F1), encodeMessage('HWT:MUSCLESS;'), encodeFrames(F1)]);
  for (let cut = 1; cut < buf.length; cut++) {
    const p = new SpikerBoxParser({ channels: 1 });
    const a = p.push(buf.slice(0, cut));
    const b = p.push(buf.slice(cut));
    assert.deepStrictEqual(a.frames.concat(b.frames), F1.concat(F1), 'cut ' + cut);
    assert.deepStrictEqual(a.messages.concat(b.messages), [{ type: 'HWT', value: 'MUSCLESS' }], 'cut ' + cut);
  }
});

test('너무 긴 이스케이프는 버리고 끝낸다', () => {
  const junk = Buffer.concat([Buffer.from([0xFF, 0xFF, 0x01, 0x01, 0x80, 0xFF]), Buffer.alloc(100, 0x41)]);
  const r = new SpikerBoxParser({ channels: 1 }).push(Buffer.concat([junk, encodeFrames([[5]])]));
  assert.deepStrictEqual(r.messages, []);
  assert.deepStrictEqual(r.frames[r.frames.length - 1], [5]);
});

test("channels:'auto' 는 2채널을 알아낸다", () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push([100 + i, 200 + i]);
  const p = new SpikerBoxParser();
  assert.strictEqual(p.channels, null);
  const r = p.push(encodeFrames(frames));
  assert.strictEqual(p.channels, 2);
  assert.ok(r.frames.length > 0);
  assert.deepStrictEqual(r.frames[r.frames.length - 1], frames[39]);
  r.frames.forEach((f) => assert.strictEqual(f[1] - f[0], 100));
});

test('parseMessageText', () => {
  assert.deepStrictEqual(parseMessageText('HWT:MUSCLESS;EVNT:3;'), [{ type: 'HWT', value: 'MUSCLESS' }, { type: 'EVNT', value: '3' }]);
  assert.deepStrictEqual(parseMessageText(''), []);
  assert.deepStrictEqual(parseMessageText('abc;;:x;HWT:A'), [{ type: 'HWT', value: 'A' }]);
});

test('EmgWindow RMS', () => {
  const w = new EmgWindow();
  assert.strictEqual(w.take(), null);
  w.add(new Array(100).fill(512));
  assert.strictEqual(w.take().rms, 0);
  const A = 200;
  const vals = [];
  for (let i = 0; i < 1000; i++) vals.push(512 + A * Math.sin((2 * Math.PI * i) / 100)); // 10주기
  w.add(vals);
  const t = w.take();
  assert.ok(Math.abs(t.rms - A / Math.SQRT2) / (A / Math.SQRT2) < 0.01);
  assert.strictEqual(t.count, 1000);
  assert.strictEqual(w.take(), null);
});

test('strengthOf', () => {
  assert.strictEqual(strengthOf(100, 30, 0), 70);
  assert.strictEqual(strengthOf(10, 30), 0);
  assert.ok(Math.abs(strengthOf(35, 2.2) - 31.3) < 1e-9); // 영점 + 여유 1.5
  assert.strictEqual(strengthOf(3.5, 2.2), 0); // 쉴 때 흔들림은 0점
  assert.ok(Math.abs(toScore(strengthOf(35, 2.2), 176, 0.6) - 7000) < 30);
});

test('RestMeter 는 3초 평균', () => {
  const m = new RestMeter(3000);
  m.start(0);
  assert.strictEqual(m.running, true);
  assert.strictEqual(m.add(10, 100), false);
  assert.strictEqual(m.add(20, 1500), false);
  assert.strictEqual(m.add(30, 3000), true);
  assert.strictEqual(m.running, false);
  assert.strictEqual(m.result(), 20);
});

test('가짜 SpikerBox: 거르기 전에는 전원 잡음이 크고, 거른 뒤 A 를 누른 구간이 뗀 구간보다 5배 이상', () => {
  const chunks = [];
  const sim = new Simulator((buf) => chunks.push(buf));
  sim.setEnabled(true); // HWT 메시지 한 번
  sim.setEnabled(false);
  const parser = new SpikerBoxParser({ channels: 1 });
  const win = new EmgWindow(), rawWin = new EmgWindow(), filter = new EmgFilter(10000);
  let rawRms = 0;
  const measure = (ticks) => {
    let rms = 0;
    for (let i = 0; i < ticks; i++) {
      sim.tick();
      const r = parser.push(chunks.splice(0).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)));
      const v = r.frames.map((f) => f[0]);
      win.add(filter.process(v));
      rawWin.add(v);
      if ((i + 1) % 10 === 0) { rms = win.take().rms; rawRms = rawWin.take().rms; } // 10틱 = 100 ms
    }
    return rms;
  };
  assert.ok(chunks.length === 1 && chunks[0].includes(Buffer.from('HWT:MUSCLESS;')));
  chunks.length = 0;
  const rest = measure(100);
  assert.ok(rawRms > 10, 'raw rest ' + rawRms);
  assert.ok(rest > 1 && rest < 3.5, 'rest ' + rest);
  sim.key('a', true);
  const held = measure(200);
  assert.ok(held > rest * 5, held + ' vs ' + rest);
});

test('기록 전체 삭제: 빈 목록으로 저장하고 지우기 전 파일은 백업', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-'));
  const store = new Store(dir);
  store.saveRecords([{ id: 'a', name: '홍길동', score: 7812, at: new Date().toISOString() }]);
  store.resetRecords(123);
  const again = new Store(dir);
  assert.deepStrictEqual(again.loadRecords(), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'records.json.bak-123'), 'utf8')).records[0].score, 7812);
  // 파일이 없을 때도 실패하지 않는다
  const { g } = makeGame({ calibration: 1 });
  g.start(0);
  assert.strictEqual(g.clear(), false); // 측정 중에는 비우지 않는다
  g.tick(9000);
  assert.strictEqual(g.clear(), true);
  assert.strictEqual(g.snapshot().phase, 'idle');
  const empty = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'punch-')));
  empty.resetRecords(1);
  assert.deepStrictEqual(empty.loadRecords(), []);
});

test('HID: 62바이트씩 나뉜 리포트의 payload 를 파서에 넣으면 메시지와 프레임이 나온다 (Windows report ID 0 포함)', () => {
  const bytes = Buffer.concat([encodeMessage('HWT:MUSCLESB;'), encodeFrames(Array.from({ length: 40 }, (_, i) => [600 + i, 500 + i]))]);
  for (const winId of [false, true]) {
    const p = new SpikerBoxParser();
    const frames = [];
    let hwt = null;
    for (let i = 0; i < bytes.length; i += 62) {
      const chunk = bytes.subarray(i, i + 62);
      const report = Buffer.alloc(64);
      report[0] = 0x3f;
      report[1] = chunk.length;
      chunk.copy(report, 2);
      const raw = winId ? Buffer.concat([Buffer.from([0]), report]) : report;
      const out = p.push(unwrapReport(raw));
      frames.push(...out.frames);
      for (const m of out.messages) if (m.type === 'HWT') hwt = m.value;
    }
    assert.strictEqual(hwt, 'MUSCLESB');
    assert.strictEqual(p.channels, 2);
    assert.deepStrictEqual(frames[frames.length - 1], [639, 539]);
  }
  assert.strictEqual(unwrapReport(Buffer.from([0x40, 1, 2])), null);
  const bad = Buffer.alloc(64); bad[0] = 0x3f; bad[1] = 63;
  assert.strictEqual(unwrapReport(bad), null);
});

test('HID: 명령은 [0x3F,0x3E,텍스트,0] 64바이트', () => {
  const c = buildCommand('board:;\n');
  assert.strictEqual(c.length, 64);
  assert.deepStrictEqual([...c.subarray(0, 2)], [0x3f, 0x3e]);
  assert.strictEqual(c.subarray(2, 10).toString(), 'board:;\n');
  assert.ok(c.subarray(10).every((b) => b === 0));
});

test('HID: 제품 ID 는 가리지 않고, 기기 하나에 항목이 여럿이면 벤더 usagePage(0xFF00) 하나만 연다', () => {
  const devs = pickDevices([
    { vendorId: 0x2e73, productId: 1, path: 'a-kbd', serialNumber: 'S1', usagePage: 0x01 },
    { vendorId: 0x2e73, productId: 1, path: 'a-vendor', serialNumber: 'S1', usagePage: 0xff00 },
    { vendorId: 0x2e73, productId: 2, path: 'b', usagePage: 0xff00 },
    { vendorId: 0x1234, productId: 1, path: 'mouse' },
    { vendorId: 0x2e73, productId: 1 },
  ]);
  assert.deepStrictEqual(devs.map((d) => d.path).sort(), ['a-vendor', 'b']);
  // 시리얼번호가 있으면 경로가 바뀌어도 같은 키
  assert.strictEqual(deviceKey({ vendorId: 0x2e73, productId: 1, serialNumber: 'S1', path: 'x' }), deviceKey({ vendorId: 0x2e73, productId: 1, serialNumber: 'S1', path: 'y' }));
  assert.strictEqual(deviceKey({ vendorId: 0x2e73, productId: 1, path: 'x' }), 'hid:x');
});

function fakeHid() {
  const api = {
    devices: [],
    opened: [],
    fail: false,
    listDevices: () => api.devices,
    deviceKey,
    openDevice(info, cb) {
      if (api.fail) throw new Error('busy');
      const d = { info, cb, restarts: 0, closed: false, restart() { d.restarts++; }, close() { d.closed = true; } };
      api.opened.push(d);
      return d;
    },
  };
  return api;
}
const hidFrames = (n) => encodeFrames(Array.from({ length: n }, () => [516, 512]));

test('HID: 다른 USB 포트에 다시 꽂아 경로가 바뀌면 옛 연결은 닫고 새 경로로 연다', () => {
  const api = fakeHid();
  let t = 1000;
  const m = new SerialManager({ hidApi: api, now: () => t });
  const got = [];
  m.on('emg', (v) => got.push(...v));
  api.devices = [{ vendorId: 0x2e73, productId: 1, path: 'p1', serialNumber: 'S1' }];
  m.scanHid(t);
  assert.strictEqual(api.opened.length, 1);
  api.opened[0].cb.onData(hidFrames(40));
  assert.ok(m.status(t).spikerbox.connected);
  assert.strictEqual(got[0], 516);
  // 뽑았다가 다른 포트에 꽂음 (오류 이벤트 없이 경로만 바뀌는 경우)
  api.devices = [{ vendorId: 0x2e73, productId: 1, path: 'p2', serialNumber: 'S1' }];
  t += 2000;
  m.scanHid(t);
  assert.ok(api.opened[0].closed);
  assert.strictEqual(api.opened.length, 2);
  assert.deepStrictEqual([...m.entries.keys()], ['hid:p2']);
  // 목록을 못 읽은 경우(null)에는 열린 연결을 건드리지 않는다
  api.devices = null;
  m.scanHid(t);
  assert.deepStrictEqual([...m.entries.keys()], ['hid:p2']);
});

test('HID: 2초간 신호가 없으면 start 를 다시 보내고, 그래도 없으면 닫았다가 다시 연다', () => {
  const api = fakeHid();
  let t = 0;
  const m = new SerialManager({ hidApi: api, now: () => t });
  api.devices = [{ vendorId: 0x2e73, productId: 1, path: 'p1' }];
  m.scanHid(t);
  const d = api.opened[0];
  d.cb.onData(hidFrames(40));
  t = 1500; m.scanHid(t);
  assert.strictEqual(d.restarts, 0);
  t = 3000; m.scanHid(t);
  assert.strictEqual(d.restarts, 1);
  d.cb.onData(hidFrames(40)); // 다시 들어오면 정상
  t = 4000; m.scanHid(t);
  assert.ok(!d.closed);
  t = 6000; m.scanHid(t);
  assert.strictEqual(d.restarts, 2);
  t = 9000; m.scanHid(t); // start 후 3초가 지나도 신호 없음 → 닫고 같은 검색에서 다시 연다
  assert.ok(d.closed);
  assert.strictEqual(api.opened.length, 2);
});

test('HID: 열기에 계속 실패하면 재시도 간격을 2초 → 최대 10초로 늘리고 관리자 화면에 이유를 보인다', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 9].map(retryDelay), [2000, 4000, 8000, 10000, 10000]);
  const api = fakeHid();
  let t = 0;
  let tries = 0;
  const open = api.openDevice;
  api.openDevice = (info, cb) => { tries++; return open(info, cb); };
  api.fail = true;
  const m = new SerialManager({ hidApi: api, now: () => t });
  api.devices = [{ vendorId: 0x2e73, productId: 1, path: 'p1' }];
  for (t = 0; t <= 20000; t += 2000) m.scanHid(t);
  // 0, 2, 6, 14 초에 시도 (간격 2 → 4 → 8 → 10)
  assert.strictEqual(tries, 4);
  assert.strictEqual(m.status(t).openError, 'busy');
  // 다시 열리면 오류 표시가 사라지고 간격도 처음으로
  api.fail = false;
  t = 24000; m.scanHid(t);
  api.opened[0].cb.onData(hidFrames(40));
  assert.strictEqual(m.status(t).openError, null);
  assert.strictEqual(m.failures.size, 0);
});

test('포트 역할 키: USB 시리얼번호가 있으면 그걸로(COM 번호가 바뀌어도 같음), 없으면 경로', () => {
  const a = roleKeyOf({ vendorId: '2341', productId: '0043', serialNumber: '95530' }, 'COM3');
  const b = roleKeyOf({ vendorId: '2341', productId: '0043', serialNumber: '95530' }, 'COM5');
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'usb:2341:0043:95530');
  assert.strictEqual(roleKeyOf({ vendorId: '1a86', productId: '7523' }, 'COM4'), 'COM4');
});

test('진단: 파형은 [최소,최대] 칸으로 줄이고, 해상도·끝값 닿음·구간 통계를 낸다', () => {
  assert.deepStrictEqual(buckets([1, 5, 2, 8, 3, 3], 3), [[1, 5], [2, 8], [3, 3]]);
  assert.deepStrictEqual(buckets([4, 7], 240), [[4, 4], [7, 7]]);
  const d = new Diag();
  let t = 0;
  // 10비트 기기처럼 512 근처, 1초에 1000 샘플
  for (let i = 0; i < 20; i++) { t += 100; d.addSamples(Array.from({ length: 100 }, (_, k) => 512 + (k % 2 ? 6 : -6)), t); }
  d.addSamples([1023], t + 1);
  d.addWindow({ rms: 6.04, strength: 1.2 }, '최대');
  d.addWindow(null);
  const s = d.snapshot(t + 5);
  assert.strictEqual(s.bits, 10);
  assert.strictEqual(s.clip, 1);
  assert.strictEqual(s.win.last, 1023);
  assert.deepStrictEqual([s.range.min, s.range.max], [506, 1023]);
  assert.ok(s.rate >= 900 && s.rate <= 1100, s.rate);
  assert.ok(s.scope.length <= 240 && s.scope.length > 0);
  assert.deepStrictEqual(s.history, [[6, 1.2, '최대'], null]);
  assert.strictEqual(s.lastAgo, 4);
  d.reset();
  assert.strictEqual(d.snapshot(t).range.min, null);
});

test('녹화: 100 ms 구간마다 CSV 한 줄, 원시값은 .raw 에 이어 쓰고 raw_start 로 맞춘다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = new Recorder({ dir });
  r.addSamples([1, 2]); // 녹화 전에는 무시
  r.start(1000, { version: '9.9.9' });
  assert.ok(r.on);
  r.setLabel('최대');
  r.addSamples([510, 514]);
  r.addSamples([512]);
  r.addWindow({ rms: 1.634, rmsRaw: 9, strength: 0.5 }, { restRms: 1.1, calibration: 2, curve: 0.6, score: 1, phase: 'idle' }, 1100);
  r.setLabel('없는 표시');
  r.addWindow(null, { restRms: 1.1, calibration: 2, curve: 0.6, phase: 'idle' }, 1200);
  r.addSamples([500]);
  r.addWindow({ rms: 0, rmsRaw: 0, strength: 0 }, { restRms: 1.1, calibration: 2, curve: 0.6, score: 0, phase: 'measuring' }, 1300);
  const st = r.status(1300);
  assert.strictEqual(st.rows, 3);
  assert.deepStrictEqual(st.labelCounts, { 최대: 1 });
  r.stop();
  assert.ok(!r.on);
  r.addWindow({ rms: 1, strength: 1 }, {}, 1400); // 멈춘 뒤에는 무시
  const csv = fs.readFileSync(r.lastFile, 'utf8').split('\n');
  assert.ok(csv[0].startsWith('# version: "9.9.9"'));
  const rows = csv.slice(csv.indexOf(HEADER) + 1).filter(Boolean);
  assert.deepStrictEqual(rows, [
    '100,최대,1.63,9,0.5,1.1,2,0.6,1,512,510,514,3,0,idle',
    '200,,,,,1.1,2,0.6,,,,,0,3,idle',
    '300,,0,0,0,1.1,2,0.6,0,500,500,500,1,3,measuring',
  ]);
  const raw = fs.readFileSync(r.lastFile.replace(/\.csv$/, '.raw'));
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => raw.readInt16LE(i * 2)), [510, 514, 512, 500]);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed}개 통과`);
