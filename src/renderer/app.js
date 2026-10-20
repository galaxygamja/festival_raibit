'use strict';

(function () {
  var api = window.api;
  var Seg = window.Seg;
  var $ = function (id) { return document.getElementById(id); };

  var P1_COLOR = '#FF4A1C', AMBER = '#FFB21E';
  var MAX_SCORE = 9999;
  var TEMP_NAME = 'ㅇㅇㅇ';

  var state = null;
  var adminOpen = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ───────────────────────── 화면 비율 유지 확대·축소 ─────────────────────────
  function fit() {
    var stage = $('stage');
    var s = Math.min(window.innerWidth / 1440, window.innerHeight / 900);
    var x = (window.innerWidth - 1440 * s) / 2, y = (window.innerHeight - 900 * s) / 2;
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ───────────────────────── 관중용 스코어보드 (Main.dc.html renderVals) ─────────────────────────
  var RAINBOW = ['#2F7BFF', '#3D6BFF', '#5A5CFF', '#7A4DFF', '#9B45F0', '#BE3FD9', '#DA3BB8', '#EE3A8F', '#F93D63', '#FF4A3D', '#FF5E2A', '#FF7A1F', '#FF9A1A', '#FFBA1A', '#FFD61F'];
  var CROWNS = [
    { c: '#FFC83D', e: '#B07A0E', label: '1위' },
    { c: '#D3DAE2', e: '#7C8792', label: '2위' },
    { c: '#D88A4E', e: '#8A4A1E', label: '3위' }
  ];


  function levelOf(v) {
    return Math.max(0, Math.min(15, Math.round((v / MAX_SCORE) * 15)));
  }

  // 왼쪽·오른쪽에 똑같이 놓는 세로 게이지 (아래 1 → 위 15). 같은 값을 두 개에 그린다.
  function gaugeHtml(v) {
    var level = levelOf(v), html = '';
    for (var i = 15; i >= 1; i--) {
      var c = RAINBOW[i - 1], lit = i <= level;
      html += '<div style="flex:1;min-height:0;border-radius:16px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:24px;' + (lit ? 'background:' + c + ';color:#1A0D0B;box-shadow:0 0 10px ' + c + ',0 0 26px ' + c + '66' : 'background:' + c + '12;color:' + c + '66;border:1px solid ' + c + '30') + '">' + i + '</div>';
    }
    return html;
  }

  function player(color, samples, needed, best) {
    samples = Math.max(0, Math.min(needed, samples || 0));
    return {
      samples: samples,
      best: best,
      bar: 'height:100%;width:' + (samples / needed * 100) + '%;background:' + color + ';box-shadow:0 0 10px ' + color,
      labelStyle: 'color:' + color + ';text-shadow:0 0 12px ' + color + '99',
      panel: 'background:#1C0F0D;border:2px solid #3A2420'
    };
  }

  function crownSvg(cr) {
    return '<svg role="img" aria-label="' + cr.label + '" width="44" height="36" viewBox="0 0 44 36" style="filter:drop-shadow(0 0 6px ' + cr.c + '99)">' +
      '<path d="M5 27 L3 9 L13 17 L22 4 L31 17 L41 9 L39 27 Z" fill="' + cr.c + '" stroke="' + cr.e + '" stroke-width="1.5" stroke-linejoin="round"></path>' +
      '<rect x="5" y="29" width="34" height="5" rx="1.5" fill="' + cr.c + '" stroke="' + cr.e + '" stroke-width="1.5"></rect>' +
      '<circle cx="3" cy="8" r="2.6" fill="' + cr.c + '"></circle>' +
      '<circle cx="22" cy="3.2" r="2.8" fill="' + cr.c + '"></circle>' +
      '<circle cx="41" cy="8" r="2.6" fill="' + cr.c + '"></circle>' +
      '<circle cx="22" cy="20" r="3" fill="' + cr.e + '"></circle>' +
      '</svg>';
  }

  function hallRows(records) {
    var html = '';
    for (var i = 0; i < 5; i++) {
      var r = records[i];
      var col = i === 0 ? AMBER : '#E8963A';
      var cr = CROWNS[i];
      var row = 'display:flex;align-items:center;gap:18px;padding:14px 18px;border-radius:14px;' + (i === 0 ? 'background:#2A1610;border:1px solid #6B4318' : 'border:1px solid transparent;border-top-color:#2E1B17');
      html += '<div style="' + row + '">' +
        '<div style="width: 48px; height: 40px; flex: none; display: flex; align-items: center; justify-content: center">' +
        (cr ? crownSvg(cr) : '<div style="font-size: 36px; color: #C9B3AC">' + (i + 1) + '</div>') +
        '</div>' +
        '<div style="flex-grow: 1; min-width: 0; font-size: 30px; color: ' + (r ? '#E9DAD5' : '#5A4540') + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">' + (r ? esc(r.name) : '-') + '</div>' +
        Seg.display(r ? Seg.pad(r.score) : '    ', 40, col) +
        '</div>';
    }
    return html;
  }

  // 배너 아래 줄: 대기 / 측정 / 결과(내 순위)
  function bannerBottom(phase, g, res) {
    var h = 'height: 78px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; white-space: nowrap';
    if (phase === 'measuring') {
      var p = player(P1_COLOR, g.p1.samples, g.samplesNeeded, g.p1.score);
      return '<div style="' + h + '"><div style="font-size: 30px; color: #E9DAD5">측정 ' + p.samples + ' / ' + g.samplesNeeded + ' · 최고 ' + p.best + '</div>' +
        '<div style="width: 520px; height: 10px; border-radius: 5px; background: #2E1B17; overflow: hidden"><div style="' + p.bar + '"></div></div></div>';
    }
    if (phase === 'result') {
      var inner;
      if (res.place) {
        inner = '<span style="font-size: 60px; color: ' + AMBER + '; text-shadow: 0 0 18px ' + AMBER + ', 0 0 44px ' + AMBER + '80">전체 ' + res.place + '위</span>' +
          '<span style="font-size: 28px; color: #C9B3AC; margin-left: 20px">' + res.total + '개 기록 중</span>';
      } else {
        inner = '<span style="font-size: 44px; color: #C9B3AC">기록이 없습니다</span>';
      }
      return '<div style="' + h + '"><div>' + inner + '</div></div>';
    }
    return '<div style="' + h + '"><div style="font-size: 46px; color: #E9DAD5">START 버튼을 누르세요</div></div>';
  }

  // 결과 화면: 순위는 명예의 전당 5위 안이 아니어도 전체 기록 기준으로 알려 준다
  function resultInfo(r) {
    return {
      place: r && r.place ? r.place : 0,
      total: r ? r.total : 0,
      rank: r && r.rank ? r.rank : 0
    };
  }

  function renderMain() {
    var g = state.game;
    var phase = g.phase;
    var res = resultInfo(phase === 'result' ? state.result : null);
    var nm = state.name || {};
    var who = function (n) { return n ? esc(n) + '님 · ' : ''; };
    var resultName = phase === 'result' && state.result ? state.result.name : null;
    var labels = {
      idle: nm.next ? '다음 도전자 · ' + esc(nm.next) + '님' : '다음 경기 대기',
      measuring: who(nm.current) + '5초 동안 힘껏 쥐세요',
      result: who(resultName) + (res.rank ? '최종 기록 · 명예의 전당 ' + res.rank + '위!' : '최종 기록'),
    };
    var bannerStyle = 'background:#1C0F0D;border:3px solid ' + AMBER + ';box-shadow:0 0 30px ' + AMBER + '55, inset 0 0 30px ' + AMBER + '22';

    var banner = '<div style="flex: none; box-sizing: border-box; padding: 18px 40px 16px; border-radius: 28px; display: flex; flex-direction: column; align-items: center; gap: 6px; ' + bannerStyle + '">' +
      '<div style="font-size: 26px; letter-spacing: 0.3em; color: #C9B3AC; white-space: nowrap">' + labels[phase] + '</div>' +
      '<div id="score-digits" style="height: 110px"></div>' +
      bannerBottom(phase, g, res) +
      '</div>';

    var hall = '<div style="flex: 1; min-height: 0; box-sizing: border-box; padding: 20px 32px; border-radius: 24px; background: #1C0F0D; border: 1px solid #3A2420; display: flex; flex-direction: column; gap: 10px; overflow: hidden">' +
      '<h2 style="margin: 0 0 4px; font-size: 44px; font-weight: 400; text-align: center; color: #FFB21E; text-shadow: 0 0 14px rgba(255,178,30,0.55)">명예의 전당</h2>' +
      hallRows(state.hall) + '</div>';

    var gauge = function (id) { return '<div id="' + id + '" style="width: 190px; flex: none; display: flex; flex-direction: column; gap: 8px"></div>'; };
    $('main').innerHTML =
      '<div style="flex: 1; min-height: 0; display: flex; gap: 54px">' +
      gauge('gauge-l') +
      '<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 26px">' + banner + hall + '</div>' +
      gauge('gauge-r') +
      '</div>';
    drawn = { p1: -1 }; // 새로 만든 칸이라 다시 그리기
    drawPlayers();
  }

  // ───────────────────────── 숫자 애니메이션 ─────────────────────────
  // 아두이노 값은 0.1초마다 오지만, 화면은 매 프레임 목표값을 향해 부드럽게 따라가서 연속적으로 오르내린다.
  // 측정 중 목표값 = 방금 들어온 값(현재 힘), 그 밖에는 최종 점수(최댓값).
  var SMOOTH_MS = 70;
  var shown = { p1: 0 };
  var drawn = { p1: -1 };
  var lastFrame = 0;

  function targetOf(k) {
    var p = state.game[k];
    return state.game.phase === 'measuring' ? p.current : p.score;
  }

  function drawPlayers() {
    ['p1'].forEach(function (k) {
      var v = Math.round(shown[k]);
      if (v === drawn[k]) return;
      drawn[k] = v;
      var d = $('score-digits'), gl = $('gauge-l'), gr = $('gauge-r');
      if (d) d.innerHTML = Seg.display(Seg.pad(v), 110, AMBER);
      if (gl) { var gh = gaugeHtml(v); gl.innerHTML = gh; if (gr) gr.innerHTML = gh; }
    });
  }

  function frame(t) {
    var dt = lastFrame ? Math.min(100, t - lastFrame) : 16;
    lastFrame = t;
    if (state) {
      var a = 1 - Math.exp(-dt / SMOOTH_MS);
      ['p1'].forEach(function (k) {
        var target = targetOf(k);
        shown[k] = Math.abs(target - shown[k]) < 1 ? target : shown[k] + (target - shown[k]) * a;
      });
      drawPlayers();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ───────────────────────── 관리자 화면 (Admin.dc.html renderVals) ─────────────────────────
  var MEDAL = ['#FFC83D', '#D3DAE2', '#D88A4E'];
  var renderedHallKey = '';

  function stateLabel(g) {
    if (g.phase === 'measuring') return ['측정 중', AMBER];
    if (g.phase === 'result') return ['기록 ' + g.p1.score + '점 · 다음 도전 대기', AMBER];
    return ['대기 중 · START 대기', '#C9B3AC'];
  }

  // 전체 기록은 payload 에 없고, recordsRev 가 바뀔 때마다 records:get 으로 받아 온다 (점수 내림차순)
  var adminRecords = [];
  var adminRev = -1;
  var fetchingRecords = false;
  var showAll = false;
  var ROW_COLS = '64px minmax(0,1fr) 128px 112px 48px';

  function syncRecords() {
    if (fetchingRecords || state.recordsRev === adminRev) return;
    fetchingRecords = true;
    api.getRecords().then(function (r) {
      fetchingRecords = false;
      adminRecords = r.records;
      adminRev = r.rev;
      renderAdminRows(false);
      if (state.recordsRev !== adminRev) syncRecords();
    }, function () { fetchingRecords = false; });
  }

  function whenOf(at) {
    var d = new Date(at);
    if (isNaN(d) || d.getTime() === 0) return '-';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function visibleRecords() {
    if (showAll) return adminRecords;
    return adminRecords.filter(function (d) { return d.score > 0; }).slice(0, 5);
  }

  function renderAdminRows(force) {
    var list = visibleRecords();
    var key = JSON.stringify([showAll, list]);
    if (!force && key === renderedHallKey) return;
    // 입력 중이던 값은 기록 id·칸 기준으로 살려 둔다
    var drafts = {};
    if (!force) {
      document.querySelectorAll('#rows input[data-id]').forEach(function (el) {
        if (el.value !== el.dataset.saved) drafts[el.dataset.id + '|' + el.dataset.field] = el.value;
      });
    }
    renderedHallKey = key;
    var draft = function (id, field, v) { var k = id + '|' + field; return Object.prototype.hasOwnProperty.call(drafts, k) ? drafts[k] : String(v); };
    var pending = 0;
    var html = list.map(function (d, i) {
      var temp = d.name === TEMP_NAME;
      if (temp) pending++;
      var row = 'display:grid;grid-template-columns:' + ROW_COLS + ';gap:12px;align-items:center;padding:8px 14px;border-radius:14px;' + (temp ? 'background:#2A1610;border:1px solid #6B4318' : 'border:1px solid #2E1B17');
      var field = 'box-sizing:border-box;width:100%;height:46px;border-radius:10px;font-family:inherit;color:#F3E6E1;background:#120807;border:2px solid ';
      var nameStyle = field + (temp ? '#FFB21E' : '#4A2E28') + ';padding:0 ' + (temp ? '96px' : '14px') + ' 0 14px;font-size:24px';
      var scoreStyle = field + '#4A2E28;padding:0 10px;font-size:26px;color:#FFB21E;font-variant-numeric:tabular-nums';
      var label = (i + 1) + '위 ' + d.name;
      return '<div style="' + row + '">' +
        '<div style="font-size: 26px; color:' + (MEDAL[i] || '#C9B3AC') + '">' + (i + 1) + '</div>' +
        '<div style="position: relative; min-width: 0">' +
        '<input type="text" maxlength="20" aria-label="' + esc(label) + ' 이름" data-id="' + esc(d.id) + '" data-field="name" data-saved="' + esc(d.name) + '" value="' + esc(draft(d.id, 'name', d.name)) + '" style="' + nameStyle + '">' +
        (temp ? '<div style="position: absolute; right: 14px; top: 0; bottom: 0; display: flex; align-items: center; pointer-events: none; font-size: 17px; color: #FFB21E">임시 이름</div>' : '') +
        '</div>' +
        '<input type="number" min="0" max="9999" step="1" aria-label="' + esc(label) + ' 점수" data-id="' + esc(d.id) + '" data-field="score" data-saved="' + d.score + '" value="' + esc(draft(d.id, 'score', d.score)) + '" style="' + scoreStyle + '">' +
        '<div style="font-size: 17px; color: #8E7770; white-space: nowrap">' + whenOf(d.at) + '</div>' +
        '<button type="button" data-del="' + esc(d.id) + '" title="이 기록 지우기" aria-label="' + esc(label) + ' 기록 지우기" style="width: 44px; height: 44px; border-radius: 10px; border: 2px solid #5A3A33; background: transparent; color: #FF8A7A; font-family: inherit; font-size: 24px; line-height: 1; cursor: pointer">✕</button>' +
        '</div>';
    }).join('');
    if (!list.length) {
      html = '<div style="padding: 40px 18px; font-size: 24px; color: #8E7770; text-align: center">아직 기록이 없습니다</div>';
    }
    $('rows').innerHTML = html;
    $('records-title').textContent = showAll ? '전체 기록 (' + adminRecords.length + '개)' : '명예의 전당';
    $('btn-toggle-records').textContent = showAll ? '명예의 전당만 보기' : '전체 기록 보기 (' + (state.recordsTotal || 0) + '개)';
    $('pending').textContent = pending ? '임시 이름 ' + pending + '개' : '';
  }

  function port(name, detail, ok, color, extra) {
    var dot = 'width:14px;height:14px;border-radius:7px;flex:none;background:' + (ok ? '#4CD964' : '#FF5A47') + ';box-shadow:0 0 10px ' + (ok ? '#4CD964' : '#FF5A47');
    return '<div style="padding: 8px 14px; border-radius: 14px; background: #241411">' +
      '<div style="display: flex; align-items: center; gap: 10px">' +
      '<div style="' + dot + '" aria-hidden="true"></div>' +
      '<div style="font-size: 21px; flex-grow: 1; color:' + color + '">' + name + '</div>' +
      '<div style="font-size: 19px; flex: none; color:' + (ok ? '#7BE08A' : '#FF8A7A') + '">' + (ok ? '연결됨' : '연결 끊김') + '</div>' +
      '</div>' +
      '<div style="margin-left: 24px; font-size: 15px; color: #B8A29B; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" title="' + esc(detail) + '">' + esc(detail) + '</div>' +
      (extra || '') + '</div>';
  }

  function timeText(ms) {
    var d = new Date(ms);
    if (!ms || isNaN(d)) return '없음';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  var renderedPortsKey = '';
  var renderedOpenKey = '';

  function renderPorts() {
    var ps = state.ports || {}, sb = ps.spikerbox || {}, st = ps.start || {}, open = ps.open || [];
    var emg = state.emg || {};
    // 포트·연결 정보가 바뀔 때만 다시 그린다
    var key = JSON.stringify([sb, st, open.length, ps.openError]);
    if (key !== renderedPortsKey) {
      renderedPortsKey = key;
      var sbDetail = sb.connected || sb.path
        ? [sb.path, sb.hwt, sb.channels ? sb.channels + '채널' : '', sb.fps ? sb.fps + ' fps' : ''].filter(Boolean).join(' · ')
        : ps.openError
          ? '열기 실패 · Spike Recorder 등 다른 프로그램이 쓰는 중인지 확인 (' + ps.openError + ')'
          : '신호 없음 · 열린 포트 ' + open.length + '개';
      var bar = '<div style="margin: 6px 0 2px 24px; height: 8px; border-radius: 4px; background: #2E1B17; overflow: hidden"><div id="rms-bar" style="height: 100%; width: 0; background: ' + AMBER + '; box-shadow: 0 0 8px ' + AMBER + '"></div></div>';
      var stDetail = st.connected || st.path
        ? [st.path, '마지막 START ' + timeText(st.lastStartAt)].filter(Boolean).join(' · ')
        : '신호 없음 · 마지막 START ' + timeText(st.lastStartAt);
      $('ports').innerHTML =
        port('SpikerBox', sbDetail, !!sb.connected, '#FF6A45', bar) +
        port('START 버튼', stDetail, !!st.connected, '#FFB21E');
    }
    // 역할 드롭다운은 포트 목록이 바뀔 때만, 그리고 고르는 중이 아닐 때만 다시 그린다 (열린 목록이 닫히지 않게)
    var openKey = JSON.stringify(open);
    var picking = document.activeElement && document.activeElement.tagName === 'SELECT' && $('open-ports').contains(document.activeElement);
    if (openKey !== renderedOpenKey && !picking) {
      renderedOpenKey = openKey;
      var ROLES = [['auto', '자동'], ['spikerbox', 'SpikerBox'], ['start', 'START']];
      $('open-ports').innerHTML = open.map(function (o) {
        var cur = o.fixed ? o.role : 'auto';
        var opts = ROLES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === cur ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('');
        var probing = o.role === 'probing' ? ' <span style="color:#8E7770">(확인 중)</span>' : '';
        return '<div style="display: flex; align-items: center; gap: 10px; font-size: 15px; color: #B8A29B">' +
          '<div style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" title="' + esc(o.path) + '">' + esc(o.path) + probing + '</div>' +
          '<select data-path="' + esc(o.path) + '" aria-label="' + esc(o.path) + ' 역할" style="height: 34px; font-family: inherit; font-size: 18px; color: #F3E6E1; background: #120807; border: 2px solid #4A2E28; border-radius: 8px">' + opts + '</select></div>';
      }).join('');
    }
    var rb = $('rms-bar');
    if (rb) rb.style.width = Math.max(0, Math.min(100, (emg.score || 0) / MAX_SCORE * 100)) + '%';
    var zeroing = !!emg.zeroing;
    $('btn-zero').disabled = zeroing;
    $('btn-zero').textContent = zeroing ? '재는 중…' : '영점 잡기';
    $('rest-text').textContent = '휴식 ' + (emg.restRms != null ? emg.restRms : (state.settings.emg || {}).restRms || 0).toFixed(1) +
      (emg.raw != null ? ' · 원시 ' + emg.raw + ' · RMS ' + (emg.rms || 0).toFixed(1) + ' · ' + (emg.score || 0) + '점' : '');
  }

  function renderAdmin() {
    var g = state.game;
    $('app-version').textContent = state.version ? 'v' + state.version : '';
    syncRecords();
    renderAdminRows(false);
    var lbl = stateLabel(g);
    $('state-text').textContent = lbl[0];
    $('state-text').style.color = lbl[1];
    var busy = g.phase === 'measuring';
    $('btn-start').disabled = busy;
    $('btn-stop').disabled = !busy;
    $('btn-reset-records').disabled = busy;
    $('ask-name').checked = !!state.settings.askName;
    var nm = state.name || {};
    $('next-name').textContent = nm.current ? '측정 중: ' + nm.current : nm.next ? '다음 도전자: ' + nm.next : '다음 도전자 이름 없음';

    renderPorts();

    $('sim-toggle').checked = state.sim;
    $('btn-fullscreen').textContent = state.fullscreen ? '창 모드로 보기' : '전체화면으로 보기';
    if (state.saveError) {
      $('names-msg').textContent = state.saveError;
      $('names-msg').style.color = '#FF8A7A';
    }
  }

  function render() {
    if (!state) return;
    renderMain();
    if (adminOpen) { if (adminPage === 2) renderDiag(); else if (adminPage === 3) renderSettings(); else renderAdmin(); }
    renderNameModal();
    checkCelebrate();
  }


  // ───────────────────────── 관리자 2페이지: 진단 ─────────────────────────
  var adminPage = 1;
  var GOOD = '#7BE08A', BAD = '#FF8A7A', DIM = '#8E7770';

  function kv(rows) {
    return '<div class="kv">' + rows.map(function (r) {
      var v = r[1] == null || r[1] === '' ? '-' : String(r[1]);
      return '<div>' + esc(r[0]) + '</div><div' + (r[2] ? ' style="color:' + r[2] + '"' : '') + '>' + esc(v) + '</div>';
    }).join('') + '</div>';
  }

  function ago(ms) {
    if (ms == null) return '없음';
    if (ms < 1000) return ms + ' ms 전';
    if (ms < 60000) return (ms / 1000).toFixed(1) + '초 전';
    return Math.floor(ms / 60000) + '분 ' + Math.floor((ms % 60000) / 1000) + '초 전';
  }

  function dur(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 3600) + '시간 ' + Math.floor((s % 3600) / 60) + '분 ' + (s % 60) + '초';
  }

  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '-';
    return d ? Number(v).toFixed(d) : String(Math.round(v));
  }

  var ROLE_NAMES = { spikerbox: 'SpikerBox', start: 'START', probing: '확인 중' };
  var MODE_NAMES = { spikerbox: 'SpikerBox', text: '텍스트(9600)', probe: '탐색 중' };
  var PHASE_NAMES = { idle: '대기', measuring: '측정 중', result: '결과' };

  function drawScope(sig) {
    var c = $('d-scope'), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    var sc = sig.scope || [];
    if (!sc.length) {
      g.fillStyle = DIM; g.font = '28px sans-serif'; g.fillText('신호 없음', 24, 48);
      $('d-scope-range').textContent = '';
      return;
    }
    var lo = Infinity, hi = -Infinity;
    sc.forEach(function (b) { if (b[0] < lo) lo = b[0]; if (b[1] > hi) hi = b[1]; });
    var pad = Math.max(4, (hi - lo) * 0.1);
    var y0 = lo - pad, y1 = hi + pad;
    var y = function (v) { return H - ((v - y0) / (y1 - y0)) * H; };
    // 평균선
    if (sig.sec && sig.sec.mean != null) {
      g.strokeStyle = '#4A2E28'; g.lineWidth = 2; g.beginPath();
      g.moveTo(0, y(sig.sec.mean)); g.lineTo(W, y(sig.sec.mean)); g.stroke();
    }
    g.strokeStyle = '#FF6A45'; g.lineWidth = Math.max(2, W / sc.length * 0.8);
    g.beginPath();
    var step = W / sc.length;
    sc.forEach(function (b, i) {
      var x = i * step + step / 2;
      g.moveTo(x, y(b[1]) - 1); g.lineTo(x, y(b[0]) + 1);
    });
    g.stroke();
    $('d-scope-range').textContent = '세로 ' + fmt(y0) + ' ~ ' + fmt(y1) + ' · 평균선 ' + fmt(sig.sec.mean, 1);
  }

  var LABEL_COLORS = { '쉼': '#5AA9E6', '약하게': '#7BE08A', '중간': '#FFB21E', '최대': '#FF5A47' };
  var HIST_N = 300; // 100 ms × 300 = 30초

  function drawHist(sig) {
    var c = $('d-hist'), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    var h = sig.history || [], top = 10, STRIP = 18, PH = H - STRIP - 4;
    h.forEach(function (p) { if (p && p[0] > top) top = p[0]; });
    top *= 1.1;
    var bw = W / HIST_N, off = HIST_N - h.length;
    var yOf = function (v) { return PH - (v / top) * PH; };
    // 5초 눈금 (오른쪽 끝이 지금)
    g.strokeStyle = '#2E1B17'; g.lineWidth = 2;
    for (var k = 1; k < 6; k++) { var gx = W - k * 50 * bw; g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, PH); g.stroke(); }
    h.forEach(function (p, i) {
      var x = (off + i) * bw;
      if (!p) { g.fillStyle = '#3A2420'; g.fillRect(x, 0, bw, PH); return; }
      g.fillStyle = 'rgba(255,178,30,0.55)'; g.fillRect(x, yOf(p[0]), bw + 0.5, PH - yOf(p[0]));
      if (p[2] && LABEL_COLORS[p[2]]) { g.fillStyle = LABEL_COLORS[p[2]]; g.fillRect(x, H - STRIP, bw + 0.5, STRIP); }
    });
    g.strokeStyle = '#FF6A45'; g.lineWidth = 3; g.beginPath();
    var pen = false;
    h.forEach(function (p, i) {
      if (!p) { pen = false; return; }
      var x = (off + i) * bw + bw / 2;
      if (pen) g.lineTo(x, yOf(p[1])); else { g.moveTo(x, yOf(p[1])); pen = true; }
    });
    g.stroke();
    g.fillStyle = DIM; g.font = '24px sans-serif';
    g.fillText('최대 ' + fmt(top / 1.1, 1), 10, 28);
    var last = h.length ? h[h.length - 1] : null;
    if (last) { g.textAlign = 'right'; g.fillText('지금 RMS ' + fmt(last[0], 1) + ' · 세기 ' + fmt(last[1], 1), W - 10, 28); g.textAlign = 'left'; }
    g.fillText('-30초', 6, PH - 8);
  }

  function renderRec() {
    var r = state.rec || {};
    var btn = $('btn-rec');
    btn.textContent = r.on ? '■ 녹화 중지' : '● 녹화 시작';
    btn.style.color = btn.style.borderColor = r.on ? '#FF5A47' : '#FFB21E';
    Array.prototype.forEach.call($('rec-labels').children, function (b) {
      var on = b.dataset.label === (r.label || '');
      var col = LABEL_COLORS[b.dataset.label] || '#F3E6E1';
      b.style.background = on ? col : 'transparent';
      b.style.color = on ? '#140A09' : '#F3E6E1';
      b.style.borderColor = on ? col : '#5A3A33';
    });
    var counts = Object.keys(r.labelCounts || {}).map(function (k) { return k + ' ' + (r.labelCounts[k] / 10).toFixed(1) + '초'; }).join(' · ');
    $('d-rec').innerHTML = kv([
      ['상태', r.on ? '녹화 중 · ' + dur(r.elapsed) : '꺼짐', r.on ? BAD : null],
      ['구간 (0.1초)', r.on ? r.rows.toLocaleString() + '개' : null],
      ['표시한 시간', counts || null],
      ['파일', r.on ? r.file : r.lastFile ? r.lastFile + ' (저장됨)' : null, !r.on && r.lastFile ? GOOD : null],
      ['오류', r.error, r.error ? BAD : null],
    ]) + '<div style="font-size: 13px; color: #8E7770; overflow-wrap: anywhere">' + esc(r.dir || '') + '</div>';
  }

  function renderDiag() {
    var d = state.diag;
    $('diag-version').textContent = state.version ? 'v' + state.version : '';
    if (!d) return;
    var sig = d.signal, ser = d.serial, ps = state.ports || {}, sb = ps.spikerbox || {}, st = ps.start || {};
    var emg = state.emg || {}, set = state.settings || {}, nPts = (set.scoreTable || []).length;
    drawScope(sig);
    drawHist(sig);
    renderRec();

    var score = emg.score || 0;
    var top = sig.bits ? Math.pow(2, sig.bits) - 1 : null;
    var nums = [
      ['원시값 (지금)', fmt(sig.win.last)],
      ['평균 (100 ms)', fmt(sig.win.mean, 1)],
      ['최소 ~ 최대 (100 ms)', sig.win.n ? sig.win.min + ' ~ ' + sig.win.max : '-'],
      ['RMS (거른 뒤)', fmt(emg.rms, 1)],
      ['RMS (거르기 전)', fmt(emg.rmsRaw, 1)],
      ['휴식 RMS (영점)', fmt(emg.restRms, 1) + (emg.zeroing ? ' · 재는 중' : '')],
      ['세기 = RMS − 휴식', fmt(emg.strength, 1)],
      ['점수 (점수표 ' + nPts + '점)', String(score)],
      ['초당 샘플', sig.rate ? sig.rate.toLocaleString() : '-'],
      ['1초 최소 ~ 최대', sig.sec.n ? sig.sec.min + ' ~ ' + sig.sec.max : '-'],
      ['누적 최소 ~ 최대', sig.range.min == null ? '-' : sig.range.min + ' ~ ' + sig.range.max],
      ['추정 해상도', sig.bits ? sig.bits + '비트 (0~' + top + ')' : '-'],
      ['끝값 닿음 (1초)', sig.bits ? sig.clip + '개' : '-'],
      ['받은 샘플 합계', sig.total.toLocaleString()],
      ['마지막 샘플', ago(sig.lastAgo)],
    ];
    $('d-signal').innerHTML = nums.map(function (n, i) {
      var color = i === 12 && sig.clip > 0 ? ' style="color:' + BAD + '"' : i === 7 ? ' style="color:' + AMBER + '"' : '';
      return '<div class="num"><span>' + esc(n[0]) + '</span><b' + color + '>' + esc(n[1]) + '</b></div>';
    }).join('');

    var spEntry = null, stEntry = null;
    ser.entries.forEach(function (e) {
      if (e.path === sb.path) spEntry = e;
      if (e.path === st.path) stEntry = e;
    });
    var msgs = spEntry ? Object.keys(spEntry.msgs).map(function (k) { return k + ':' + spEntry.msgs[k]; }).join('  ') : '';
    $('d-spiker').innerHTML = kv([
      ['상태', sb.connected ? '연결됨 · 신호 수신 중' : sb.path ? '열려 있지만 신호 없음' : '찾지 못함', sb.connected ? GOOD : BAD],
      ['연결 방식', spEntry && spEntry.transport === 'sim' ? '시뮬레이션' : sb.transport === 'hid' ? 'USB HID' : sb.transport === 'serial' ? '시리얼 ' + sb.baud + ' baud' : null],
      ['장치', sb.name],
      ['HWT', sb.hwt],
      ['채널', sb.channels ? sb.channels + '채널 · 쓰는 채널 ' + ((set.emg || {}).channel || 1) : null],
      ['프레임/초', sb.fps ? sb.fps.toLocaleString() : '0'],
      ['채널 판별 신뢰도', spEntry ? spEntry.confidence + '%' : null],
      ['마지막 프레임', spEntry ? ago(spEntry.lastFrameAgo) : null],
      ['다시 시작 중', spEntry && spEntry.restarting ? 'start 명령 보냄, 응답 기다리는 중' : '아니요', spEntry && spEntry.restarting ? AMBER : null],
      ['장치 메시지', msgs],
      ['경로', sb.path],
      ['열기 오류', ser.openError ? ser.openError.message + ' (' + ago(ser.openError.ago) + ')' : '없음', ser.openError ? BAD : null],
    ]);
    $('d-start').innerHTML = kv([
      ['상태', st.connected ? '연결됨' : st.path ? '열려 있지만 신호 없음' : '찾지 못함', st.connected ? GOOD : BAD],
      ['경로', st.path],
      ['마지막 ALIVE', stEntry ? ago(stEntry.lastAliveAgo) : null],
      ['마지막 START', st.lastStartAt ? timeText(st.lastStartAt) : '없음'],
      ['START 횟수', stEntry ? stEntry.startCount + '번 (이번 연결)' : null],
    ]);
    var g = state.game || {};
    $('d-game').innerHTML = kv([
      ['단계', PHASE_NAMES[g.phase] || g.phase],
      ['샘플', g.p1 ? g.p1.samples + ' / ' + g.samplesNeeded : null],
      ['최고 (최종 점수)', g.p1 ? g.p1.score : null],
      ['방금 값', g.p1 ? g.p1.current : null],
      ['마지막 결과', state.result ? state.result.score + '점 · 전체 ' + (state.result.place || '-') + '위 / ' + state.result.total : '없음'],
      ['기록 수', state.recordsTotal],
    ]);

    var portHtml = ser.entries.map(function (e) {
      var ok = e.mode === 'spikerbox' ? e.fps > 0 : e.mode === 'text' ? e.lastAliveAgo != null && e.lastAliveAgo < 3000 : false;
      var bits = [MODE_NAMES[e.mode] || e.mode, e.transport === 'hid' ? 'HID' : e.transport === 'sim' ? '시뮬레이션' : e.baud ? e.baud + ' baud' : '',
        e.mode === 'spikerbox' ? e.fps.toLocaleString() + ' fps' : '', e.fixed ? '역할 고정' : '자동', e.hwt || ''].filter(Boolean).join(' · ');
      return '<div style="padding: 6px 10px; border-radius: 10px; background: #241411">' +
        '<div style="display: flex; gap: 8px; align-items: center; font-size: 17px"><span style="width: 10px; height: 10px; border-radius: 5px; flex: none; background:' + (ok ? '#4CD964' : '#FF5A47') + '"></span>' +
        '<span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="' + esc(e.path) + '">' + esc(e.path) + '</span></div>' +
        '<div style="font-size: 15px; color: #B8A29B; margin-left: 18px">' + esc(bits) + '</div>' +
        (e.roleKey !== e.path ? '<div style="font-size: 13px; color: ' + DIM + '; margin-left: 18px">역할 키 ' + esc(e.roleKey) + '</div>' : '') +
        '</div>';
    }).join('');
    if (!ser.entries.length) portHtml = '<div style="font-size: 17px; color: ' + DIM + '">열린 포트 없음</div>';
    var hidHtml = '<div style="font-size: 16px; color: #B8A29B; margin-top: 4px">BackyardBrains HID 장치 (0x2E73)' + (ser.hidListOk ? '' : ' · 목록 읽기 실패') + '</div>' +
      (ser.hidDevices.length ? ser.hidDevices.map(function (h) {
        return '<div style="font-size: 14px; color: #C9B3AC; margin-left: 10px; overflow-wrap: anywhere">' +
          esc([h.product || '이름 없음', h.vendorId + ':' + h.productId, h.serialNumber ? 'S/N ' + h.serialNumber : '', h.usagePage ? 'usage ' + h.usagePage : ''].filter(Boolean).join(' · ')) + '</div>';
      }).join('') : '<div style="font-size: 14px; color: ' + DIM + '; margin-left: 10px">없음</div>');
    var failHtml = ser.failures.length ? '<div style="font-size: 16px; color: ' + BAD + '; margin-top: 4px">열기 재시도 대기</div>' + ser.failures.map(function (f) {
      return '<div style="font-size: 14px; color: #C9B3AC; margin-left: 10px; overflow-wrap: anywhere">' + esc(f.key) + ' · ' + f.count + '번 실패 · ' + (f.waitMs / 1000).toFixed(1) + '초 뒤</div>';
    }).join('') : '';
    $('d-ports').innerHTML = portHtml + hidHtml + failHtml;

    var env = d.env;
    $('d-env').innerHTML = kv([
      ['버전', 'v' + state.version + (env.packaged ? ' · 설치본' : ' · 개발 실행')],
      ['실행 시간', dur(env.uptime)],
      ['환경', env.platform + ' ' + env.arch + ' · Electron ' + env.electron],
      ['점수표 · 채널', nPts + '점 · ' + ((set.emg || {}).channel || 1) + '번'],
      ['시뮬레이션', state.sim ? '켜짐' : '꺼짐', state.sim ? AMBER : null],
    ]) + '<div style="font-size: 13px; color: #8E7770; overflow-wrap: anywhere" title="' + esc(state.dataDir || '') + '">데이터 폴더 ' + esc(state.dataDir || '-') + '</div>';

    var logs = d.logs.slice().reverse().map(function (l) {
      var c = l.level === 'error' ? BAD : l.level === 'warn' ? AMBER : '#C9B3AC';
      return '<div style="color:' + c + '">' + timeText(l.at) + ' ' + esc(l.text) + '</div>';
    }).join('');
    var box = $('d-logs');
    if (box.dataset.key !== String(d.logs.length) + (d.logs.length ? d.logs[d.logs.length - 1].at : '')) {
      box.dataset.key = String(d.logs.length) + (d.logs.length ? d.logs[d.logs.length - 1].at : '');
      box.innerHTML = logs || '<div style="color:' + DIM + '">로그 없음</div>';
    }
  }

  function showPage(n) {
    adminPage = n;
    $('admin').hidden = n !== 1;
    $('diag').hidden = n !== 2;
    $('settings').hidden = n !== 3;
    if (document.activeElement) document.activeElement.blur();
    api.setDiag(n === 2);
    if (n === 1) { renderAdminRows(true); renderAdmin(); } else if (n === 2) { renderDiag(); } else { fillSettings(); renderSettings(); }
  }

  // ───────────────────────── 관리자 화면 열기 / 닫기 ─────────────────────────
  var isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  $('shortcut').textContent = isMac ? 'Control + D' : 'Ctrl + D';
  $('fs-shortcut').textContent = isMac ? 'F11 / Control + Cmd + F' : 'F11';
  $('name-shortcut').textContent = $('name-shortcut2').textContent = isMac ? 'Control + F' : 'Ctrl + F';

  function openAdmin() {
    adminOpen = true;
    releaseSimKeys();
    $('main').hidden = true;
    showPage(1);
  }

  function closeAdmin() {
    adminOpen = false;
    if (document.activeElement) document.activeElement.blur();
    $('admin').hidden = true;
    $('diag').hidden = true;
    $('settings').hidden = true;
    $('main').hidden = false;
    if (adminPage === 2) api.setDiag(false);
    adminPage = 1;
  }

  function recordsMsg(text, ok) {
    var msg = $('names-msg');
    msg.textContent = text;
    msg.style.color = ok ? '#7BE08A' : '#FF8A7A';
  }

  /** 바뀐 이름·점수만 모아서 저장 */
  function saveRecords() {
    var edits = {}, count = 0, bad = 0;
    document.querySelectorAll('#rows input[data-id]').forEach(function (el) {
      if (el.value === el.dataset.saved) return;
      var id = el.dataset.id, f = el.dataset.field, v = el.value;
      if (f === 'score') {
        var n = Math.round(Number(v));
        if (v.trim() === '' || !isFinite(n) || n < 0 || n > 9999) { bad++; return; }
        v = n;
      }
      (edits[id] = edits[id] || {})[f] = v;
      count++;
    });
    if (bad) { recordsMsg('점수는 0~9999 숫자만 됩니다.', false); return; }
    if (!count) { recordsMsg('바뀐 내용이 없습니다.', true); return; }
    api.saveRecords(edits).then(function (ok) {
      recordsMsg(ok ? '저장했습니다. 순위를 다시 매겼습니다.' : '저장에 실패했습니다.', ok);
      // 저장한 값으로 다시 그리도록 입력 중 값은 버린다
      document.querySelectorAll('#rows input[data-id]').forEach(function (el) { el.dataset.saved = el.value; });
      renderedHallKey = '';
    });
  }

  function deleteRecord(id) {
    var list = visibleRecords(), i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].id === id) i = k;
    if (i < 0) return;
    var d = list[i];
    if (!window.confirm((i + 1) + '위 ' + d.name + ' (' + d.score + '점) 기록을 지울까요?')) return;
    api.deleteRecords([id]).then(function (ok) {
      recordsMsg(ok ? '기록을 지웠습니다.' : '기록 삭제에 실패했습니다.', ok);
      renderedHallKey = '';
    });
  }

  $('btn-close').addEventListener('click', closeAdmin);
  $('btn-close2').addEventListener('click', closeAdmin);
  $('btn-page2').addEventListener('click', function () { showPage(2); });
  $('btn-page1').addEventListener('click', function () { showPage(1); });
  $('btn-diag-reset').addEventListener('click', function () { api.resetDiag(); });
  $('btn-zero2').addEventListener('click', function () { api.zeroEmg(); });
  $('btn-rec').addEventListener('click', function () { if (state && state.rec && state.rec.on) api.recStop(); else api.recStart(); });
  $('btn-rec-open').addEventListener('click', function () { api.openRecordings(); });
  $('rec-labels').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-label]') : null;
    if (b) { api.recLabel(b.dataset.label); b.blur(); }
  });
  $('btn-reconnect2').addEventListener('click', function () { api.reconnect(); });
  $('btn-fullscreen').addEventListener('click', function () { api.toggleFullscreen(); });
  $('btn-start').addEventListener('click', function () { api.start(); });
  $('btn-stop').addEventListener('click', function () { api.stop(); });
  $('btn-save-names').addEventListener('click', saveRecords);
  $('btn-toggle-records').addEventListener('click', function () {
    showAll = !showAll;
    renderAdminRows(false);
    $('rows').scrollTop = 0;
  });
  $('rows').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-del]') : null;
    if (b) deleteRecord(b.dataset.del);
  });
  $('btn-reset-records').addEventListener('click', function () {
    var n = state ? state.recordsTotal || 0 : 0;
    if (!window.confirm('기록 ' + n + '개(명예의 전당 포함)를 모두 지울까요?\n(지우기 전 파일은 데이터 폴더에 백업됩니다)')) return;
    api.resetRecords().then(function (ok) {
      recordsMsg(ok ? '기록을 모두 지웠습니다.' : '기록 삭제에 실패했습니다.', ok);
      renderedHallKey = '';
    });
  });
  $('btn-zero').addEventListener('click', function () { if (api.zeroEmg) api.zeroEmg(); });
  $('open-ports').addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset && el.dataset.path && api.setPortRole) { api.setPortRole(el.dataset.path, el.value); el.blur(); }
  });
  $('btn-reconnect').addEventListener('click', function () { api.reconnect(); });
  $('sim-toggle').addEventListener('change', function (e) { api.setSim(e.target.checked); });
  $('btn-quit').addEventListener('click', function () {
    if (window.confirm('앱을 종료할까요?')) api.quit();
  });
  $('rows').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) saveRecords();
  });

  // ───────────────────────── 관리자 3페이지: 설정 ─────────────────────────
  // 입력칸은 페이지를 열 때와 저장한 뒤에만 채운다 (0.05초마다 오는 상태로 덮어쓰지 않게)
  var tableDraft = [];
  var lastZeroing = false;

  function settingsMsg(id, text, ok) {
    $(id).textContent = text;
    $(id).style.color = ok === false ? BAD : ok ? GOOD : DIM;
  }

  function fillSettings() {
    var set = state.settings, e = set.emg || {};
    $('s-channel').value = String(e.channel || 1);
    $('s-mains').value = String(e.mainsHz || 60);
    $('s-rest').value = Math.round((e.restRms || 0) * 100) / 100;
    $('s-margin').value = e.margin;
    $('s-hp').value = e.highpassHz;
    $('s-notch').checked = e.notch !== false;
    $('s-askname').checked = !!set.askName;
    tableDraft = (set.scoreTable || []).map(function (p) { return [String(p[0]), String(p[1])]; });
    renderTableRows();
    settingsMsg('s-msg', '', null);
  }

  function draftTable() {
    var pts = [];
    tableDraft.forEach(function (r) {
      var a = parseFloat(r[0]), b = parseFloat(r[1]);
      if (isFinite(a) && isFinite(b) && a >= 0) pts.push([a, Math.max(0, Math.min(MAX_SCORE, b))]);
    });
    pts.sort(function (x, y) { return x[0] - y[0]; });
    return pts.filter(function (p, i) { return i === 0 || p[0] !== pts[i - 1][0]; });
  }

  function scoreFromTable(st, t) {
    if (t.length < 2) return 0;
    var v;
    if (st <= t[0][0]) v = t[0][0] > 0 ? t[0][1] * st / t[0][0] : t[0][1];
    else if (st >= t[t.length - 1][0]) v = t[t.length - 1][1];
    else { var i = 1; while (t[i][0] < st) i++; v = t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (st - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); }
    return Math.max(0, Math.min(MAX_SCORE, Math.round(v)));
  }

  function renderTableRows() {
    $('t-rows').innerHTML = tableDraft.map(function (r, i) {
      return '<div class="trow"><div style="font-size: 18px; color: #8E7770">' + (i + 1) + '</div>' +
        '<input type="number" step="0.5" min="0" data-i="' + i + '" data-k="0" aria-label="' + (i + 1) + '번 점 세기" value="' + esc(r[0]) + '">' +
        '<input type="number" step="100" min="0" max="9999" data-i="' + i + '" data-k="1" aria-label="' + (i + 1) + '번 점 점수" value="' + esc(r[1]) + '">' +
        '<div class="slope" data-slope="' + i + '"></div>' +
        '<button type="button" class="btn" data-del="' + i + '" title="이 점 지우기" style="width: 44px; padding: 0; color: #FF8A7A">✕</button></div>';
    }).join('');
    updateSlopes();
  }

  function updateSlopes() {
    var t = draftTable();
    tableDraft.forEach(function (r, i) {
      var el = document.querySelector('[data-slope="' + i + '"]');
      if (!el) return;
      var a = parseFloat(r[0]), k = -1;
      for (var j = 0; j < t.length; j++) if (t[j][0] === a) k = j;
      if (k < 0) { el.textContent = '숫자를 넣으세요'; el.style.color = BAD; return; }
      el.style.color = '';
      if (k === 0) el.textContent = t[0][0] > 0 ? '0 ~ ' + t[0][0] + ': ' + fmt(t[0][1] / t[0][0], 0) + '점' : '시작점';
      else el.textContent = t[k - 1][0] + ' ~ ' + t[k][0] + ': ' + fmt((t[k][1] - t[k - 1][1]) / (t[k][0] - t[k - 1][0]), 0) + '점';
    });
    var bad = draftTable().length < 2;
    settingsMsg('t-msg', bad ? '점이 2개 이상 있어야 합니다' : '저장해야 점수에 반영됩니다 · 저장된 표: ' + (state.settings.scoreTable || []).length + '점', bad ? false : null);
  }

  function drawTable(t, liveS, maxS) {
    var c = $('t-graph'), g = c.getContext('2d'), W = c.width, H = c.height, L = 90, B = 50, R = 20, T = 20;
    g.clearRect(0, 0, W, H);
    var xmax = Math.max(10, t.length ? t[t.length - 1][0] * 1.15 : 10, (liveS || 0) * 1.05, (maxS || 0) * 1.05);
    var x = function (v) { return L + (v / xmax) * (W - L - R); };
    var y = function (v) { return H - B - (v / MAX_SCORE) * (H - B - T); };
    g.strokeStyle = '#2E1B17'; g.lineWidth = 2; g.fillStyle = DIM; g.font = '26px sans-serif';
    [0, 2500, 5000, 7500, 9999].forEach(function (v) { g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke(); g.fillText(String(v), 6, y(v) + 9); });
    var step = xmax > 60 ? 20 : xmax > 30 ? 10 : 5;
    for (var sx = 0; sx <= xmax; sx += step) { g.fillText(String(sx), x(sx) - 10, H - 14); }
    g.fillText('세기', W - R - 60, H - 14);
    if (t.length >= 2) {
      g.strokeStyle = AMBER; g.lineWidth = 5; g.beginPath();
      g.moveTo(x(0), y(scoreFromTable(0, t)));
      t.forEach(function (p) { g.lineTo(x(p[0]), y(p[1])); });
      g.lineTo(x(xmax), y(t[t.length - 1][1]));
      g.stroke();
      g.fillStyle = AMBER;
      t.forEach(function (p) { g.beginPath(); g.arc(x(p[0]), y(p[1]), 9, 0, Math.PI * 2); g.fill(); });
    }
    var mark = function (st, col, label) {
      if (st == null) return;
      var sc = scoreFromTable(st, t);
      g.strokeStyle = col; g.lineWidth = 3; g.setLineDash([10, 8]);
      g.beginPath(); g.moveTo(x(st), y(0)); g.lineTo(x(st), y(sc)); g.lineTo(L, y(sc)); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.beginPath(); g.arc(x(st), y(sc), 12, 0, Math.PI * 2); g.fill();
      g.font = '28px sans-serif'; g.fillText(label + ' ' + fmt(st, 1) + ' → ' + sc, Math.min(x(st) + 16, W - 330), y(sc) - 16);
    };
    if (maxS) mark(maxS, '#5AA9E6', '측정 최고');
    mark(liveS || 0, '#FF6A45', '지금');
  }

  function renderSettings() {
    $('settings-version').textContent = state.version ? 'v' + state.version : '';
    var emg = state.emg || {}, g = state.game || {}, t = draftTable();
    var maxS = g.p1 && g.p1.rawMax ? g.p1.rawMax : 0;
    drawTable(t, emg.strength || 0, maxS);
    $('t-live').textContent = '지금 세기 ' + fmt(emg.strength, 1) + ' → ' + scoreFromTable(emg.strength || 0, t) + '점' +
      (maxS ? ' · 마지막 측정 최고 세기 ' + fmt(maxS, 1) + ' → ' + scoreFromTable(maxS, t) + '점' : '');
    $('s-live').textContent = emg.zeroing ? '영점 재는 중… 힘을 빼세요' : '거른 RMS ' + fmt(emg.rms, 1) + ' · 거르기 전 ' + fmt(emg.rmsRaw, 1) + ' · 저장된 영점 ' + fmt(emg.restRms, 2);
    if (lastZeroing && !emg.zeroing) $('s-rest').value = Math.round((emg.restRms || 0) * 100) / 100; // 영점 잡기가 끝나면 입력칸에 넣는다
    lastZeroing = !!emg.zeroing;
  }

  function saveAllSettings() {
    var t = draftTable();
    if (t.length < 2) { settingsMsg('s-msg', '점수표에 점이 2개 이상 있어야 합니다.', false); return; }
    var num = function (id, def) { var v = parseFloat($(id).value); return isFinite(v) ? v : def; };
    var e = state.settings.emg || {};
    var next = {
      scoreTable: t,
      askName: $('s-askname').checked,
      emg: {
        channel: parseInt($('s-channel').value, 10), mainsHz: parseInt($('s-mains').value, 10), notch: $('s-notch').checked,
        restRms: num('s-rest', e.restRms), margin: num('s-margin', e.margin), highpassHz: num('s-hp', e.highpassHz),
      },
    };
    api.saveSettings(next).then(function (s) {
      state.settings = s;
      fillSettings();
      settingsMsg('s-msg', state.saveError ? state.saveError : '저장했습니다.', !state.saveError);
    });
  }

  $('t-rows').addEventListener('input', function (e) {
    var el = e.target;
    if (!el.dataset || el.dataset.i == null) return;
    tableDraft[+el.dataset.i][+el.dataset.k] = el.value;
    updateSlopes();
  });
  $('t-rows').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-del]') : null;
    if (!b) return;
    tableDraft.splice(+b.dataset.del, 1);
    renderTableRows();
  });
  $('btn-t-add').addEventListener('click', function () {
    var t = draftTable(), last = t.length ? t[t.length - 1] : [0, 0];
    tableDraft.push([String(last[0] + 10), String(Math.min(MAX_SCORE, last[1]))]);
    renderTableRows();
    $('t-rows').scrollTop = $('t-rows').scrollHeight;
  });
  $('btn-t-default').addEventListener('click', function () {
    tableDraft = (state.scoreTableDefault || []).map(function (p) { return [String(p[0]), String(p[1])]; });
    renderTableRows();
  });
  $('btn-s-save').addEventListener('click', saveAllSettings);
  $('btn-s-zero').addEventListener('click', function () { api.zeroEmg(); });
  $('btn-open-settings').addEventListener('click', function () { showPage(3); });
  $('btn-page3').addEventListener('click', function () { showPage(3); });
  $('btn-p3-page1').addEventListener('click', function () { showPage(1); });
  $('btn-p3-page2').addEventListener('click', function () { showPage(2); });
  $('btn-close3').addEventListener('click', closeAdmin);
  $('ask-name').addEventListener('change', function (e) { api.saveSettings({ askName: e.target.checked }); e.target.blur(); });
  $('btn-export').addEventListener('click', function () {
    api.exportSettings().then(function (r) {
      if (r.canceled) return;
      settingsMsg('file-msg', r.ok ? '저장한 설정(점수표 포함)을 내보냈습니다: ' + r.file : '내보내기 실패: ' + r.error, r.ok);
    });
  });
  $('btn-import').addEventListener('click', function () {
    api.importSettings().then(function (r) {
      if (r.canceled) return;
      settingsMsg('file-msg', r.ok ? '가져왔습니다: ' + r.file + ' · 영점을 다시 잡으세요' : '가져오기 실패: ' + r.error, r.ok);
      if (r.ok) api.getState().then(function (st) { state = st; fillSettings(); });
    });
  });

  // ───────────────────────── 도전자 이름 입력창 ─────────────────────────
  // Control+F 로 미리 넣거나(nameLocal), 이름 받기가 켜진 상태에서 START 가 눌리면(state.name.prompt) 뜬다
  var nameLocal = false, nameShown = false, nameQuietUntil = 0;

  function nameModalWanted() {
    // 방금 닫았으면 잠깐은 다시 띄우지 않는다 (닫기 전에 보낸 상태가 늦게 도착할 수 있다)
    return !adminOpen && !!state && (nameLocal || (performance.now() > nameQuietUntil && !!(state.name && state.name.prompt)));
  }

  function renderNameModal() {
    var want = nameModalWanted();
    if (want === nameShown) {
      if (want) $('name-hint').textContent = nameHint();
      return;
    }
    nameShown = want;
    $('name-modal').hidden = !want;
    if (want) {
      releaseSimKeys();
      $('name-input').value = (state.name && state.name.next) || '';
      $('name-hint').textContent = nameHint();
      setTimeout(function () { $('name-input').focus(); }, 0);
    } else if (document.activeElement === $('name-input')) {
      $('name-input').blur();
    }
  }

  function nameHint() {
    return state.name && state.name.prompt
      ? 'Enter: 바로 시작 · 비우고 Enter: 이름 없이 시작 · Esc: 취소'
      : 'Enter: 저장 (START 를 누르면 시작) · Esc: 닫기';
  }

  function openNameModal() {
    nameLocal = true;
    renderNameModal();
  }

  function closeNameModal() {
    nameLocal = false;
    nameQuietUntil = performance.now() + 400;
    nameShown = false;
    $('name-modal').hidden = true;
    $('name-input').blur();
  }

  $('name-input').addEventListener('keydown', function (e) {
    e.stopPropagation(); // 시뮬레이션 키(A, S) 등으로 새지 않게
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 조합 확정용
    if (e.key === 'Enter') {
      e.preventDefault();
      var prompt = !!(state.name && state.name.prompt);
      api.setName($('name-input').value, prompt);
      closeNameModal();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (state.name && state.name.prompt) api.cancelName();
      closeNameModal();
    }
  });

  // ───────────────────────── 명예의 전당 축하 (이름 받기가 켜져 있을 때만) ─────────────────────────
  var celebratedId = null, fx = null;

  function checkCelebrate() {
    var r = state.result, g = state.game;
    var on = g.phase === 'result' && r && r.rank && r.id && state.settings.askName;
    if (on && r.id !== celebratedId) {
      celebratedId = r.id;
      startCelebrate((r.name ? r.name + '님 ' : '') + r.rank + '위 축하드립니다!');
    }
    if (fx && (!on || adminOpen)) stopCelebrate();
  }

  var FX_COLORS = ['#FFD61F', '#FF9A1A', '#FF4A3D', '#EE3A8F', '#9B45F0', '#3D6BFF', '#7BE08A', '#FFFFFF'];

  function startCelebrate(text) {
    stopCelebrate();
    $('celebrate-text').textContent = text;
    $('celebrate').hidden = false;
    var c = $('fx');
    c.hidden = false;
    var g = c.getContext('2d');
    fx = { parts: [], started: performance.now(), nextBurst: 0, raf: 0 };
    var burst = function () {
      var cx = 160 + Math.random() * 1120, cy = 120 + Math.random() * 380;
      var col = FX_COLORS[Math.floor(Math.random() * FX_COLORS.length)];
      var n = 70 + Math.floor(Math.random() * 40);
      for (var i = 0; i < n; i++) {
        var a = (Math.PI * 2 * i) / n, sp = 3 + Math.random() * 6;
        fx.parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: Math.random() < 0.25 ? '#FFFFFF' : col, size: 3 + Math.random() * 3 });
      }
    };
    var last = performance.now();
    var step = function (t) {
      if (!fx) return;
      var dt = Math.min(50, t - last) / 16.7;
      last = t;
      var age = t - fx.started;
      if (age < 6000 && t >= fx.nextBurst) { burst(); if (Math.random() < 0.4) burst(); fx.nextBurst = t + 280 + Math.random() * 320; }
      g.clearRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'lighter';
      fx.parts = fx.parts.filter(function (p) {
        p.vx *= Math.pow(0.985, dt); p.vy = p.vy * Math.pow(0.985, dt) + 0.09 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= 0.012 * dt;
        if (p.life <= 0) return false;
        g.globalAlpha = Math.max(0, p.life);
        g.fillStyle = p.col;
        g.beginPath(); g.arc(p.x, p.y, p.size, 0, Math.PI * 2); g.fill();
        return true;
      });
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      if (age > 6000 && !fx.parts.length) { c.hidden = true; return; } // 폭죽은 6초, 축하 문구는 결과 화면 동안 유지
      fx.raf = requestAnimationFrame(step);
    };
    fx.raf = requestAnimationFrame(step);
  }

  function stopCelebrate() {
    if (fx) cancelAnimationFrame(fx.raf);
    fx = null;
    $('fx').hidden = true;
    $('celebrate').hidden = true;
  }

  // ───────────────────────── 키보드 ─────────────────────────
  // 한글 입력 상태에서도 동작하도록 e.key 대신 e.code 사용
  var SIM_KEYS = { KeyA: 'a' };
  var held = {};

  function releaseSimKeys() {
    held = {};
    api.simKey('release', false);
  }

  window.addEventListener('keydown', function (e) {
    // 전체화면 ↔ 창 모드 (관중 화면·관리자 화면 어디서나)
    if (e.key === 'F11' || (isMac && e.code === 'KeyF' && e.ctrlKey && e.metaKey)) {
      e.preventDefault();
      if (!e.repeat) api.toggleFullscreen();
      return;
    }
    // 관리자 화면: Control + D (Windows는 Ctrl + D). macOS의 Cmd 는 Control 과 별개라 Control 키만 본다.
    if (e.code === 'KeyD' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (adminOpen) closeAdmin(); else openAdmin();
      return;
    }
    // 도전자 이름 입력: Control + F (Windows는 Ctrl + F). macOS 의 Control + Cmd + F 는 위에서 전체화면으로 처리했다.
    if (e.code === 'KeyF' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (!adminOpen && !e.repeat) { if (nameShown) closeNameModal(); else openNameModal(); }
      return;
    }
    if (nameShown) return; // 입력창이 떠 있으면 시뮬레이션 키는 받지 않는다
    if (adminOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closeAdmin(); return; }
      // 진단 페이지: 숫자키 0~4 로 지금 하는 동작 표시 (녹화 CSV 와 그래프 아래 띠에 남는다)
      var m = adminPage === 2 && !e.ctrlKey && !e.metaKey && !e.altKey && /^(Digit|Numpad)([0-4])$/.exec(e.code);
      if (m && !e.repeat && !(e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) {
        e.preventDefault();
        api.recLabel(['', '쉼', '약하게', '중간', '최대'][+m[2]]);
      }
      return;
    }
    if (!state || !state.sim || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'KeyS') {
      if (!e.repeat) api.simKey('s', true);
    } else if (SIM_KEYS[e.code] && !held[e.code]) {
      held[e.code] = true;
      api.simKey(SIM_KEYS[e.code], true);
    }
  });

  window.addEventListener('keyup', function (e) {
    if (SIM_KEYS[e.code] && held[e.code]) {
      held[e.code] = false;
      api.simKey(SIM_KEYS[e.code], false);
    }
  });

  window.addEventListener('blur', releaseSimKeys);

  // ───────────────────────── 상태 수신 ─────────────────────────
  api.onState(function (s) { state = s; render(); });
  api.getState().then(function (s) { if (!state) { state = s; render(); } });
})();
