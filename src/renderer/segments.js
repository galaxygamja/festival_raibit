'use strict';

// Main.dc.html 의 digits() / pad() / wrap() 을 그대로 옮긴 7세그먼트 표시.

(function () {
  var MAP = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', ' ': '' };

  function digits(str, size, color) {
    var h = size, w = Math.round(size * 0.56), t = Math.max(3, Math.round(size * 0.12)), g = Math.max(1, Math.round(t * 0.18));
    var vl = Math.round(h / 2 - t / 2 - 2 * g);
    var ht = t / 2;
    var hp = 'polygon(' + ht + 'px 0,calc(100% - ' + ht + 'px) 0,100% 50%,calc(100% - ' + ht + 'px) 100%,' + ht + 'px 100%,0 50%)';
    var vp = 'polygon(50% 0,100% ' + ht + 'px,100% calc(100% - ' + ht + 'px),50% 100%,0 calc(100% - ' + ht + 'px),0 ' + ht + 'px)';
    var geo = {
      a: [ht + g, 0, w - t - 2 * g, t, hp],
      b: [w - t, ht + g, t, vl, vp],
      c: [w - t, h / 2 + g, t, vl, vp],
      d: [ht + g, h - t, w - t - 2 * g, t, hp],
      e: [0, h / 2 + g, t, vl, vp],
      f: [0, ht + g, t, vl, vp],
      g: [ht + g, h / 2 - ht, w - t - 2 * g, t, hp]
    };
    return str.split('').map(function (ch) {
      var on = MAP[ch] || '';
      return {
        box: 'position:relative;flex:none;width:' + w + 'px;height:' + h + 'px',
        segs: 'abcdefg'.split('').map(function (k) {
          var q = geo[k];
          return { style: 'position:absolute;left:' + q[0] + 'px;top:' + q[1] + 'px;width:' + q[2] + 'px;height:' + q[3] + 'px;clip-path:' + q[4] + ';background:' + (on.indexOf(k) >= 0 ? color : color + '1C') };
        })
      };
    });
  }

  function pad(n) { n = Math.max(0, Math.min(9999, Math.round(n || 0))); return String(n).padStart(4, ' '); }

  function wrap(size, color) {
    return 'display:flex;gap:' + Math.round(size * 0.14) + 'px;transform:skewX(-6deg);filter:drop-shadow(0 0 3px ' + color + ') drop-shadow(0 0 14px ' + color + '80)';
  }

  /** 디자인의 <div style={{wrap}}><sc-for digits>…</sc-for></div> 를 HTML 문자열로 */
  function display(str, size, color) {
    var html = '<div style="' + wrap(size, color) + '">';
    digits(str, size, color).forEach(function (d) {
      html += '<div style="' + d.box + '">';
      d.segs.forEach(function (s) { html += '<div style="' + s.style + '"></div>'; });
      html += '</div>';
    });
    return html + '</div>';
  }

  /** el 안의 표시를 str 로 맞춘다. 처음에만 만들고, 그 뒤로는 바뀐 자리의 세그먼트 색만 바꾼다. */
  function update(el, str, size, color) {
    if (el.__seg && el.__seg.size === size && el.__seg.color === color && el.__seg.str.length === str.length) {
      var digitEls = el.firstChild.children;
      for (var i = 0; i < str.length; i++) {
        if (str[i] === el.__seg.str[i]) continue;
        var on = MAP[str[i]] || '', segEls = digitEls[i].children;
        for (var k = 0; k < 7; k++) segEls[k].style.background = on.indexOf('abcdefg'[k]) >= 0 ? color : color + '1C';
      }
      el.__seg.str = str;
      return;
    }
    el.innerHTML = display(str, size, color);
    el.__seg = { str: str, size: size, color: color };
  }

  window.Seg = { digits: digits, pad: pad, wrap: wrap, display: display, update: update };
})();
