'use strict';

// 효과음. 결과는 로컬 WAV 팡파르, 나머지는 Web Audio 로 8비트 칩 소리를 만든다.
// 크러셔(비트 줄이기) + 짧은 메아리를 거쳐 나간다. 골라 둔 후보: 시작 A (카운트다운 + GO), 현재 힘 A, 최고 갱신 B, 결과 WAV,
// 명예의 전당 B, 0점 C, 버튼 A, 이름 입력 B.
(function () {
  var ctx = null, pre = null, bus = null, master = null;
  var enabled = true, volume = 0.7;
  var fanfare = null;

  function stopFanfare() {
    if (!fanfare) return;
    fanfare.pause();
    fanfare.currentTime = 0;
  }

  function ac() {
    if (!ctx) {
      ctx = new AudioContext();
      var crush = ctx.createWaveShaper(), curve = new Float32Array(4096);
      for (var i = 0; i < 4096; i++) curve[i] = Math.round(((i / 4095) * 2 - 1) * 24) / 24;
      crush.curve = curve;
      var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
      master = ctx.createGain(); master.gain.value = volume;
      pre = ctx.createGain(); pre.connect(crush); crush.connect(comp); comp.connect(master); master.connect(ctx.destination);
      bus = ctx.createGain(); bus.connect(pre);
      var delay = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain(), tone = ctx.createBiquadFilter();
      delay.delayTime.value = 0.16; fb.gain.value = 0.32; wet.gain.value = 0.28; tone.type = 'lowpass'; tone.frequency.value = 3200;
      bus.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(wet); wet.connect(pre);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function N(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  var pulses = {};
  function pulse(duty) {
    if (!pulses[duty]) {
      var n = 64, re = new Float32Array(n), im = new Float32Array(n);
      for (var k = 1; k < n; k++) {
        re[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k);
        im[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k);
      }
      pulses[duty] = ac().createPeriodicWave(re, im);
    }
    return pulses[duty];
  }
  function voice(c, type) {
    var v = c.createOscillator();
    if (type === 'p12') v.setPeriodicWave(pulse(0.125));
    else if (type === 'p25') v.setPeriodicWave(pulse(0.25));
    else if (type === 'p50') v.type = 'square';
    else v.type = 'triangle';
    return v;
  }
  function env(g, t0, a, peak, s, d) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.setValueAtTime(peak, t0 + a + s);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + s + d);
    return t0 + a + s + d;
  }
  function dflt(v, d) { return v == null ? d : v; }

  // o: {type: p12|p25|p50|triangle, f, f2, glide, steps, t, a, s, d, g, vib: {rate, depth, delay}, dry}
  function osc(o) {
    var c = ac(), t0 = c.currentTime + (o.t || 0);
    var a = dflt(o.a, 0.004), s = dflt(o.s, 0), d = dflt(o.d, 0.15);
    var v = voice(c, o.type);
    v.frequency.setValueAtTime(o.f, t0);
    if (o.f2) {
      var T = dflt(o.glide, a + s + d);
      if (o.steps) for (var i = 1; i <= o.steps; i++) v.frequency.setValueAtTime(o.f * Math.pow(o.f2 / o.f, i / o.steps), t0 + (T * i) / o.steps);
      else v.frequency.exponentialRampToValueAtTime(o.f2, t0 + T);
    }
    if (o.vib) {
      var l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = o.vib.rate;
      lg.gain.setValueAtTime(0, t0); lg.gain.linearRampToValueAtTime(o.vib.depth, t0 + dflt(o.vib.delay, 0.12));
      l.connect(lg); lg.connect(v.detune); l.start(t0); l.stop(t0 + a + s + d + 0.1);
    }
    var g = c.createGain(), end = env(g, t0, a, dflt(o.g, 0.1), s, d);
    v.connect(g); g.connect(o.dry ? pre : bus);
    v.start(t0); v.stop(end + 0.05);
  }

  var noiseBufs = {};
  function noiseBuffer(period, short) {
    var key = period + (short ? 's' : 'l');
    if (!noiseBufs[key]) {
      var c = ac(), len = short ? 93 * period : c.sampleRate, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0), v = 0;
      for (var i = 0; i < len; i++) { if (i % period === 0) v = Math.random() < 0.5 ? -1 : 1; d[i] = v; }
      noiseBufs[key] = b;
    }
    return noiseBufs[key];
  }
  // o: {period (클수록 낮고 거칠다), short (금속성 반복), rate, rate2, t, a, s, d, g}
  function noise(o) {
    var c = ac(), t0 = c.currentTime + (o.t || 0);
    var src = c.createBufferSource(); src.buffer = noiseBuffer(o.period || 1, o.short); src.loop = true;
    var g = c.createGain(), end = env(g, t0, dflt(o.a, 0.002), dflt(o.g, 0.15), dflt(o.s, 0), dflt(o.d, 0.1));
    src.playbackRate.setValueAtTime(o.rate || 1, t0);
    if (o.rate2) src.playbackRate.exponentialRampToValueAtTime(o.rate2, end);
    src.connect(g); g.connect(bus);
    src.start(t0, Math.random() * 0.5); src.stop(end + 0.05);
  }
  function kick(t) {
    osc({ type: 'triangle', f: 180, f2: 45, steps: 6, glide: 0.09, t: t, d: 0.12, g: 0.5 });
    noise({ period: 8, t: t, d: 0.05, g: 0.2 });
  }
  function crash(t, d) { noise({ period: 1, t: t, d: d, g: 0.2 }); }

  var SOUNDS = {
    // 레이스 카운트다운: 3-2-1 낮은 삐 (0.715초 간격. game.js COUNTDOWN_MS 와 app.js 화면 숫자도 이 간격)
    count: function () {
      [0, 0.715, 1.43].forEach(function (t) { osc({ type: 'p50', f: N(69), t: t, s: 0.12, d: 0.06, g: 0.12 }); });
    },
    // 측정 시작 순간의 높은 GO
    go: function () {
      osc({ type: 'p50', f: N(81), s: 0.45, d: 0.3, g: 0.12 });
      osc({ type: 'p25', f: N(93), s: 0.45, d: 0.3, g: 0.06 });
      osc({ type: 'triangle', f: N(45), s: 0.45, d: 0.3, g: 0.35 });
      kick(0); crash(0, 0.9);
    },
    // 레벨 업: 도미솔도 빠른 아르페지오
    peak: function () {
      [84, 88, 91].forEach(function (m, i) { osc({ type: 'p25', f: N(m), t: i * 0.04, s: 0.03, d: 0.02, g: 0.08 }); });
      osc({ type: 'p25', f: N(96), t: 0.12, s: 0.08, d: 0.15, g: 0.08 });
    },
    // 모든 결과(상위권, 순위 밖, 0점)에 같은 팡파르를 한 번 재생한다.
    result: function () {
      if (!fanfare) fanfare = new Audio('sounds/score-fanfare.wav');
      fanfare.currentTime = 0;
      fanfare.volume = volume;
      var playing = fanfare.play();
      if (playing && playing.catch) playing.catch(function () {});
    },
    // 아쉬움 (명예의 전당 밖): 반음씩 내려가다 낮게 떨리는 음
    miss: function () {
      var u = 0.15;
      [[67, 0, 1], [66, 1, 1], [65, 2, 1]].forEach(function (n) {
        osc({ type: 'p50', f: N(n[0]), t: n[1] * u, s: u * 0.75, d: u * 0.15 + 0.03, g: 0.08 });
      });
      osc({ type: 'p50', f: N(64), f2: N(62), glide: 0.9, t: 3 * u, s: 0.55, d: 0.35, g: 0.08, vib: { rate: 5, depth: 35, delay: 0.15 } });
      osc({ type: 'triangle', f: N(43), t: 0, s: 3 * u, d: 0.03, g: 0.3 });
      osc({ type: 'triangle', f: N(40), t: 3 * u, s: 0.55, d: 0.35, g: 0.3 });
    },
    // 폭죽: 올라가는 휘파람 → 펑 → 타닥타닥
    hall: function () {
      [0, 0.35, 0.6, 0.95, 1.2, 1.5].forEach(function (t, k) {
        osc({ type: 'p12', f: N(72 + k * 2), f2: N(96 + k), steps: 16, glide: 0.33, t: t, s: 0.33, d: 0.02, g: 0.04 });
        var tp = t + 0.35;
        noise({ period: 6, rate: 1, rate2: 0.25, t: tp, d: 0.5, g: 0.4 });
        for (var i = 0; i < 10; i++) noise({ period: 1, short: true, t: tp + 0.1 + Math.random() * 0.5, d: 0.012, g: 0.12 });
      });
    },
    // 오류 버저: 낮고 거친 부저 두 번
    zero: function () {
      osc({ type: 'p12', f: N(38), s: 0.14, d: 0.03, g: 0.14 });
      osc({ type: 'p12', f: N(38), t: 0.22, s: 0.3, d: 0.08, g: 0.14 });
      noise({ period: 12, s: 0.14, d: 0.03, g: 0.08 });
      noise({ period: 12, t: 0.22, s: 0.3, d: 0.08, g: 0.08 });
    },
    // 메뉴 커서
    click: function () { osc({ type: 'p50', f: N(84), s: 0.02, d: 0.015, g: 0.07, dry: true }); },
    // 동전 넣기: 동전 + 반짝임
    name: function () {
      osc({ type: 'p50', f: N(83), s: 0.05, d: 0.01, g: 0.09 });
      osc({ type: 'p50', f: N(88), t: 0.07, s: 0.12, d: 0.1, g: 0.09 });
      [100, 103, 108].forEach(function (m, i) { osc({ type: 'p12', f: N(m), t: 0.26 + i * 0.05, s: 0.03, d: 0.1, g: 0.05 }); });
    },
  };

  // 현재 힘: 원본의 8비트 충전 빔 + 점수에 따라 회전하는 모터음. 두 층 모두 기존 master 음량을 따른다.
  function Beam() {
    var c = ac(), out = c.createGain(); out.gain.value = 0; out.connect(bus);
    var o1 = voice(c, 'p25'), o2 = voice(c, 'p12'), o3 = voice(c, 'triangle');
    var g1 = c.createGain(), g2 = c.createGain(), g3 = c.createGain();
    g1.gain.value = 0.5; g2.gain.value = 0.5; g3.gain.value = 0.9;
    var lfo = c.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 12;
    var l1 = c.createGain(), l2 = c.createGain(); l1.gain.value = 0.5; l2.gain.value = -0.5;
    lfo.connect(l1); l1.connect(g1.gain); lfo.connect(l2); l2.connect(g2.gain);
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    [g1, g2, g3].forEach(function (g) { g.connect(out); });
    // juhyun5801 모터음: 톱니파 + 약간 어긋난 사각파 + 회전 진폭 변조.
    // 원본 충전음과 합칠 때 과도하게 커지지 않도록 모터 출력을 낮춘다.
    var motor = c.createOscillator(), second = c.createOscillator(), rotor = c.createOscillator();
    var motorLevel = c.createGain(), secondLevel = c.createGain(), depth = c.createGain();
    var filter = c.createBiquadFilter(), motorOut = c.createGain();
    motor.type = 'sawtooth'; second.type = 'square'; second.detune.value = 7; rotor.type = 'sine';
    motorLevel.gain.value = 0.55; secondLevel.gain.value = 0.18; depth.gain.value = 0.22;
    filter.type = 'lowpass'; filter.Q.value = 1.1; motorOut.gain.value = 0;
    motor.connect(motorLevel); second.connect(secondLevel); secondLevel.connect(motorLevel);
    rotor.connect(depth); depth.connect(motorLevel.gain);
    motorLevel.connect(filter); filter.connect(motorOut); motorOut.connect(pre);
    var nodes = [o1, o2, o3, lfo, motor, second, rotor];
    nodes.forEach(function (n) { n.start(); });
    var last = -1;
    this.set = function (p, motorRatio) {
      var t = c.currentTime, m = Math.round(40 + p * 36);
      if (m !== last) {
        last = m;
        o1.frequency.setValueAtTime(N(m), t); o2.frequency.setValueAtTime(N(m + 12), t); o3.frequency.setValueAtTime(N(m - 12), t);
      }
      lfo.frequency.setTargetAtTime(10 + p * 14, t, 0.05);
      out.gain.setTargetAtTime(p < 0.01 ? 0 : (0.05 + p * 0.13) * 0.65, t, 0.05);
      var frequency = 90 * Math.pow(10, motorRatio);
      motor.frequency.setTargetAtTime(frequency, t, 0.04);
      second.frequency.setTargetAtTime(frequency, t, 0.04);
      rotor.frequency.setTargetAtTime(14 + 65 * motorRatio, t, 0.04);
      filter.frequency.setTargetAtTime(650 + 4200 * motorRatio, t, 0.04);
      motorOut.gain.setTargetAtTime(motorRatio ? (0.4 + 0.2 * Math.sqrt(motorRatio)) * 0.15 : 0, t, 0.025);
    };
    this.stop = function () {
      out.gain.setTargetAtTime(0, c.currentTime, 0.04);
      motorOut.gain.setTargetAtTime(0, c.currentTime, 0.01);
      setTimeout(function () { nodes.forEach(function (n) { n.stop(); }); out.disconnect(); motorOut.disconnect(); }, 400);
    };
  }

  var beam = null, lastP = -1, lastMotor = -1;

  window.Sound = {
    play: function (name) {
      if (!enabled || !SOUNDS[name]) return;
      try { SOUNDS[name](); } catch (e) { console.warn('sound', name, e); }
    },
    // 측정 중 현재 힘 (0~1). null 이면 끈다.
    power: function (p, motorRatio) {
      if (p == null || !enabled) {
        if (beam) { beam.stop(); beam = null; }
        return;
      }
      p = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
      motorRatio = motorRatio == null ? p : Number.isFinite(motorRatio) ? Math.max(0, Math.min(1, motorRatio)) : 0;
      if (!beam) { beam = new Beam(); lastP = lastMotor = -1; }
      if (Math.abs(p - lastP) < 0.003 && Math.abs(motorRatio - lastMotor) < 0.003) return;
      lastP = p; lastMotor = motorRatio;
      beam.set(p, motorRatio);
    },
    configure: function (opts) {
      var on = !opts || opts.on !== false;
      var vol = opts && typeof opts.volume === 'number' ? opts.volume : volume;
      if (!on && beam) { beam.stop(); beam = null; }
      if (!on) stopFanfare();
      enabled = on;
      if (vol !== volume) {
        volume = vol;
        if (fanfare) fanfare.volume = volume;
        if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
      }
    },
  };
})();
