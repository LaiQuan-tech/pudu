/**
 * 表格形狀偵測引擎
 *
 * 輸入：二維陣列（第一列為標題）
 * 輸出：每一欄的型別 + 整張表的形狀 + 欄位角色指派
 *
 * 設計原則：所有判斷都要能說出理由（reason），否則無法驗證準確度。
 */
(function (root) {
  'use strict';

  /* ══ 值的型別測試 ══ */

  function ymd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;   // 擋掉 2/30
    return dt;
  }

  // 認得：2026年8月14日 / 2026-08-14 / 2026/8/14 / 民國114/8/14 / 8/14
  function parseDateish(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s.length > 40) return null;
    var m;
    if ((m = s.match(/(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/)))
      return ymd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(?:民國\s*)?(\d{2,3})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/))) {
      var y = +m[1];
      return ymd(y < 200 ? y + 1911 : y, +m[2], +m[3]);
    }
    if ((m = s.match(/^(\d{1,2})\s*[\-\/.月]\s*(\d{1,2})\s*日?\s*(前|後|底|初|中|左右|以前|之前|以後)?$/)))
      return ymd(new Date().getFullYear(), +m[1], +m[2]);
    return null;
  }

  // 認得：上午 10:30 / 下午 7:00 / 14:05 / 2:30 PM
  function parseTimeish(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s.length > 20) return null;
    var m = s.match(/^(上午|下午|早上|晚上|AM|PM)?\s*(\d{1,2})[:：](\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    var h = +m[2], mi = +m[3];
    if (h > 23 || mi > 59) return null;
    var tag = (m[1] || '') + (m[4] || '');
    if (/下午|晚上|PM/i.test(tag) && h < 12) h += 12;
    if (/上午|早上|AM/i.test(tag) && h === 12) h = 0;
    return { h: h, m: mi, text: (h < 10 ? '0' : '') + h + ':' + m[3], mins: h * 60 + mi };
  }

  var reNumber = /^-?\s*[\d,]+(\.\d+)?\s*$/;
  var reMoney  = /[$＄¥￥€]|NT|元|塊/i;
  var reEmail  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var reUrl    = /^https?:\/\/\S+$/i;

  function isPhoneish(v) {
    var s = String(v).trim();
    if (!/^[\d\-+()#\s]+$/.test(s)) return false;
    var digits = s.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
  }

  /* ══ 單欄偵測 ══ */

  var NAME_HINTS = {
    date:     /日期|時間|date|day|時程|檔期|deadline|due|到期/i,
    time:     /時間|時刻|time|hour|開始|結束/i,
    money:    /價|金額|費用|費$|價格|單價|小計|總計|預算|薪|稅|帳款|收款|付款|營收|支出|請款|報價|price|amount|cost|fee|budget|total|salary|revenue|invoice/i,
    person:   /人員|負責|姓名|名字|承辦|窗口|聯絡人|主辦|owner|assignee|name|person|contact|staff|member/i,
    phone:    /電話|手機|聯絡|分機|phone|tel|mobile|cell/i,
    email:    /信箱|郵件|email|mail/i,
    status:   /狀態|進度|階段|status|state|stage|phase|完成|處理/i,
    category: /類別|分類|種類|群組|組別|部門|類型|category|type|group|dept|kind|tag/i,
    note:     /備註|說明|內容|描述|摘要|note|memo|remark|desc|comment|detail/i,
    qty:      /數量|人數|件數|qty|quantity|count|數$/i
  };

  var RE_NULLISH = /^([-–—－]|N\/A|n\/a|NA|無|nil|null)$/;

  function detectColumn(name, values) {
    var all = values.map(function (v) { return String(v == null ? '' : v); });
    // 「-」代表「沒有」，不是資料。當成空白才不會把金額欄拉成一般文字。
    var filled = all.filter(function (v) {
      var t = v.trim(); return t !== '' && !RE_NULLISH.test(t);
    });
    var n = filled.length;

    var col = {
      name: name,
      filled: n,
      total: all.length,
      fillRate: all.length ? n / all.length : 0,
      samples: filled.slice(0, 3),
      distinct: 0,
      avgLen: 0,
      type: 'empty',
      confidence: 0,
      reason: '整欄空白'
    };
    if (!n) return col;

    var uniq = {};
    filled.forEach(function (v) { uniq[v.trim()] = 1; });
    col.distinct = Object.keys(uniq).length;
    col.avgLen = filled.reduce(function (a, v) { return a + v.length; }, 0) / n;
    col.multiline = filled.some(function (v) { return v.indexOf('\n') >= 0; });
    col.multilineRatio = filled.filter(function (v) { return v.indexOf('\n') >= 0; }).length / n;

    var ratio = function (fn) { return filled.filter(fn).length / n; };
    var hint = function (k) { return NAME_HINTS[k].test(name); };
    var pct = function (r) { return Math.round(r * 100) + '%'; };

    var rDate  = ratio(function (v) { return !!parseDateish(v); });
    var rTime  = ratio(function (v) { return !!parseTimeish(v); });
    var rNum   = ratio(function (v) { return reNumber.test(v); });
    var rMoney = ratio(function (v) { return reMoney.test(v) && /\d/.test(v); });
    var rMail  = ratio(function (v) { return reEmail.test(v.trim()); });
    var rUrl   = ratio(function (v) { return reUrl.test(v.trim()); });
    var rPhone = ratio(isPhoneish);
    var repeats = col.distinct < n;          // 至少有一個值出現過兩次才算得上分類

    // 依序判斷，先中先贏
    if (rDate >= 0.6) {
      col.type = 'date'; col.confidence = rDate;
      col.reason = pct(rDate) + ' 的值可解析為日期';
    } else if (rTime >= 0.6 || (hint('time') && rTime >= 0.3)) {
      col.type = 'time'; col.confidence = rTime;
      col.reason = pct(rTime) + ' 的值可解析為時間' + (hint('time') ? '，欄名也含時間字樣' : '');
    } else if (rMail >= 0.5) {
      col.type = 'email'; col.confidence = rMail;
      col.reason = pct(rMail) + ' 的值是電子郵件格式';
    } else if (rUrl >= 0.5) {
      col.type = 'url'; col.confidence = rUrl;
      col.reason = pct(rUrl) + ' 的值是網址';
    } else if (rPhone >= 0.6 && (hint('phone') || rPhone >= 0.85)) {
      col.type = 'phone'; col.confidence = rPhone;
      col.reason = pct(rPhone) + ' 的值像電話號碼' + (hint('phone') ? '，欄名也含電話字樣' : '');
    } else if ((rMoney >= 0.5) || (rNum >= 0.7 && hint('money'))) {
      col.type = 'money'; col.confidence = Math.max(rMoney, rNum);
      col.reason = hint('money') ? '欄名含金額字樣，且 ' + pct(rNum) + ' 是數字'
                                 : pct(rMoney) + ' 的值帶有金額符號';
    } else if (rNum >= 0.8) {
      col.type = 'number'; col.confidence = rNum;
      col.reason = pct(rNum) + ' 的值是數字';
    } else if (col.multilineRatio >= 0.15 || col.avgLen > 25) {
      // 只看「有沒有換行」會誤判：145 筆裡 2 筆換行的人員欄不是長文字
      col.type = 'longtext'; col.confidence = Math.min(1, col.avgLen / 40);
      col.reason = col.multilineRatio >= 0.15
        ? Math.round(col.multilineRatio * 100) + '% 的值有換行，屬長文字'
        : '平均長度 ' + Math.round(col.avgLen) + ' 字，屬長文字';
    } else if (hint('person')) {
      col.type = 'person'; col.confidence = 0.8;
      col.reason = '欄名含人員／負責人字樣';
    } else if (repeats && !hint('note') && col.distinct <= 8 && col.avgLen <= 10) {
      // 用「值有沒有重複出現」當門檻，而不是比例。
      // 比例門檻（distinct < n*0.5）在小表上永遠不成立：
      // 4 列的表有 3 種狀態時 3 < 2 為假，狀態欄就會被誤判成一般文字。
      col.type = hint('status') ? 'status' : 'category';
      col.confidence = 1 - col.distinct / Math.max(n, 1);
      col.reason = '只有 ' + col.distinct + ' 種不同的值、字都很短，適合當' +
                   (col.type === 'status' ? '狀態' : '分類');
    } else if (repeats && !hint('note') && col.distinct <= 20 && col.distinct <= n * 0.6 && col.avgLen <= 14) {
      col.type = 'category'; col.confidence = 1 - col.distinct / Math.max(n, 1);
      col.reason = col.distinct + ' 種重複出現的短值，可當分類';
    } else {
      col.type = 'text'; col.confidence = 0.5;
      col.reason = '一般文字（' + col.distinct + ' 種相異值）';
    }
    return col;
  }

  /* ══ 整張表的形狀 ══ */

  function pick(cols, type) {
    var hit = cols.filter(function (c) { return c.type === type; });
    hit.sort(function (a, b) { return b.confidence - a.confidence; });
    return hit[0] || null;
  }

  // 代碼欄：長度整齊、都含數字、幾乎全相異，例如 AT-114-001
  function codeLike(c) {
    // 只有文字欄才可能是代碼。金額欄同樣「長度整齊、含數字、幾乎全相異」，
    // 這條規則原本只用來扣標題分數（金額本來就不會當標題，誤判無害），
    // 一旦拿來隱藏欄位就會把 857,143 跟 AT-114-001 一起藏掉。
    if (c.type !== 'text') return false;
    var s2 = c.samples;
    if (s2.length < 2) return false;
    var lens = s2.map(function (v) { return v.length; });
    var min = Math.min.apply(null, lens), max = Math.max.apply(null, lens);
    return min >= 5 && max - min <= 2 &&
           s2.every(function (v) { return /\d/.test(v); }) &&
           c.distinct / Math.max(c.filled, 1) > 0.9;
  }

  // 流水號欄：1,2,3… 這種連號整數，對閱讀沒有任何幫助
  function serialLike(c) {
    if (c.type !== 'number' || c.filled < 4) return false;
    if (c.distinct !== c.filled) return false;              // 有重複就不是流水號
    var nums = c.samples.map(function (v) { return parseFloat(String(v).replace(/,/g, '')); });
    if (nums.some(isNaN)) return false;
    return nums.every(function (v) { return v === Math.round(v) && v >= 0 && v <= c.filled + 2; });
  }

  // 主標題欄：相異度高、不太長、不是日期或數字的那一欄，越靠左越優先
  function pickTitle(cols) {
    var cand = cols.filter(function (c) {
      // 幾乎空白、或整欄同一個值的欄位當不了標題（試算表尾端常有這種殘欄）
      return ['text', 'longtext', 'person', 'category'].indexOf(c.type) >= 0
             && c.fillRate >= 0.5 && c.distinct > 1;
    });
    if (!cand.length) return null;
    cand.forEach(function (c, i) {
      c._score = c.distinct / Math.max(c.filled, 1)          // 越獨特越像標題
               - (c.type === 'longtext' ? 0.35 : 0)          // 長文字比較像內容
               - (codeLike(c) ? 0.6 : 0)                     // 單號、編號不是給人讀的名稱
               - cols.indexOf(c) * 0.04;                     // 越左邊越優先
    });
    cand.sort(function (a, b) { return b._score - a._score; });
    return cand[0];
  }

  function detectShape(cols, allCols) {
    allCols = allCols || cols;
    var date  = pick(cols, 'date');
    var time  = pick(cols, 'time');
    var money = pick(cols, 'money');
    var phone = pick(cols, 'phone');
    var mail  = pick(cols, 'email');
    var status = pick(cols, 'status');
    var person = pick(cols, 'person');
    var cat   = pick(cols, 'category');
    var title = pickTitle(cols);

    // 有日期不等於是排程。帳表的日期幾乎每列都不同，按日期分組會變成
    // 幾十組各一兩筆；那裡的主角是金額，不是時間軸。
    var moneys = cols.filter(function (c) { return c.type === 'money'; });
    if (date && moneys.length >= 2 && date.distinct / Math.max(date.filled, 1) > 0.45) {
      var main = moneys.filter(function (c) { return /含稅|總|合計|應收|小計/.test(c.name); })[0] || moneys[moneys.length - 1];
      var t2 = pickTitle(cols);
      return {
        shape: 'ledger', label: '帳務／明細表',
        reason: '有日期欄「' + date.name + '」但幾乎每列都不同（' +
                date.distinct + '/' + date.filled + '），且有 ' + moneys.length +
                ' 欄金額，判定為明細帳而非排程',
        group: null, lead: main, title: t2, person: null
      };
    }
    if (date) return {
      shape: 'schedule', label: '排程／時程表',
      reason: '偵測到日期欄「' + date.name + '」（' + date.reason + '）' +
              (time ? '，並有時間欄「' + time.name + '」' : ''),
      group: date, lead: time, title: title, person: person
    };
    if ((phone || mail) && title) return {
      shape: 'directory', label: '名冊／通訊錄',
      reason: '偵測到' + (phone ? '電話欄「' + phone.name + '」' : '') +
              (phone && mail ? '與' : '') + (mail ? '信箱欄「' + mail.name + '」' : '') +
              '，以「' + title.name + '」為主要名稱',
      group: cat, lead: null, title: title, person: person
    };
    // 矩陣：第一欄是標籤序列，後面兩欄以上是數值。
    // 這裡要用「宣告的欄位」而不是「有資料的欄位」——整欄空白代表這次沒發生，
    // 不代表這個欄位不存在。用有資料的欄位判斷，會讓同結構的表因資料稀疏而判成不同形狀。
    var first = allCols[0], others = allCols.slice(1);
    var nums = others.filter(function (c) { return c.type === 'number' || c.type === 'money'; });
    var numOrEmpty = others.filter(function (c) {
      return c.type === 'number' || c.type === 'money' || c.type === 'empty';
    });
    if (first && others.length >= 2 && nums.length >= 1 &&
        numOrEmpty.length / others.length >= 0.8 &&
        ['text', 'category', 'person'].indexOf(first.type) >= 0) {
      return {
        shape: 'matrix', label: '矩陣／報表', matrix: true,
        reason: '第一欄「' + first.name + '」是標籤，後面 ' + others.length + ' 欄是數值（' +
                others.map(function (c) { return c.name + (c.type === 'empty' ? '：整欄空白' : ''); }).join('、') + '）',
        group: null, lead: null, title: first, person: null, values: nums, allValues: others
      };
    }
    if (money && title) return {
      shape: 'pricelist', label: '品項／價目表',
      reason: '偵測到金額欄「' + money.name + '」，以「' + title.name + '」為品項名稱',
      group: cat, lead: money, title: title, person: null
    };
    if (status && title) return {
      shape: 'board', label: '狀態清單',
      reason: '偵測到狀態欄「' + status.name + '」（' + status.distinct + ' 種狀態）',
      group: status, lead: null, title: title, person: person
    };
    return {
      shape: 'cards', label: '一般表格',
      reason: title ? '沒有可辨識的主軸，以「' + title.name + '」為標題逐列呈現'
                    : '沒有可辨識的結構，逐列呈現所有欄位',
      group: cat, lead: null, title: title, person: person
    };
  }

  /* ══ 角色指派：形狀決定每欄怎麼呈現 ══ */

  function assignRoles(cols, shape) {
    var used = {};
    var take = function (c, role) {
      if (!c || used[c.name]) return null;
      used[c.name] = role; return c;
    };
    var roles = {
      group: take(shape.group, 'group'),
      lead:  take(shape.lead,  'lead'),
      title: take(shape.title, 'title'),
      meta:  [], body: [], rest: []
    };
    // 人員、狀態、分類當次要資訊；長文字當內文；其餘列成欄位對
    cols.forEach(function (c) {
      if (used[c.name] || c.type === 'empty') return;
      if (['person', 'status', 'category', 'phone', 'email', 'url'].indexOf(c.type) >= 0) { used[c.name] = 'meta'; roles.meta.push(c); }
    });
    cols.forEach(function (c) {
      if (used[c.name] || c.type === 'empty') return;
      if (c.type === 'longtext') { used[c.name] = 'body'; roles.body.push(c); }
    });
    roles.hidden = [];
    cols.forEach(function (c) {
      if (used[c.name] || c.type === 'empty') return;
      if (serialLike(c) || codeLike(c)) { used[c.name] = 'hidden'; roles.hidden.push(c); return; }
      used[c.name] = 'rest'; roles.rest.push(c);
    });
    roles.assigned = used;
    return roles;
  }

  /* ══ 對外 ══ */

  function analyse(rows) {
    if (!rows || rows.length < 2) return null;
    var header = rows[0].map(function (h, i) {
      var s = String(h == null ? '' : h).trim();
      return s || ('欄 ' + (i + 1));
    });
    var body = rows.slice(1).filter(function (r) {
      return r.some(function (v) { return String(v == null ? '' : v).trim() !== ''; });
    });

    var cols = header.map(function (name, i) {
      return detectColumn(name, body.map(function (r) { return r[i]; }));
    });
    var live = cols.filter(function (c) { return c.type !== 'empty'; });
    var shape = detectShape(live, cols);
    return {
      header: header, rows: body, cols: cols,
      shape: shape, roles: assignRoles(live, shape)
    };
  }

  root.SheetShape = {
    isNoise: function (c) { return serialLike(c) || codeLike(c); },
    analyse: analyse,
    detectColumn: detectColumn,
    parseDateish: parseDateish,
    parseTimeish: parseTimeish
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ══════════════════════════════════════════════════════════
   結構前處理：真實試算表不是資料表，是排版成表格樣子的文件。
   在判型之前，要先找出「表格到底在哪裡」。
   ══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var S = root.SheetShape;

  function blank(v) { return String(v == null ? '' : v).trim() === ''; }

  function normalize(grid) {
    var w = 0;
    grid.forEach(function (r) { if (r && r.length > w) w = r.length; });
    return grid.map(function (r) {
      var out = [];
      for (var i = 0; i < w; i++) out.push(String((r && r[i]) == null ? '' : r[i]));
      return out;
    });
  }

  // 連續為 false 的區間 → [[start,end], ...]
  function runs(flags) {
    var out = [], s = -1;
    for (var i = 0; i <= flags.length; i++) {
      if (i < flags.length && !flags[i]) { if (s < 0) s = i; }
      else if (s >= 0) { out.push([s, i - 1]); s = -1; }
    }
    return out;
  }

  var RE_TOTAL = /^(總計|合計|小計|總和|加總|total|sum|subtotal)/i;

  /* 找標題列：滿、短、不重複、不是數字，而且下面幾列有資料 */
  function dataCols(rows, from) {
    var set = {};
    rows.slice(from, from + 25).forEach(function (r) {
      r.forEach(function (v, c) { if (!blank(v)) set[c] = 1; });
    });
    return set;
  }

  function scoreHeader(rows, i, w) {
    var cells = rows[i].map(function (v) { return String(v).trim(); });
    var filled = cells.filter(function (v) { return v !== ''; });
    if (filled.length < 2) return -Infinity;
    if (RE_TOTAL.test(filled[0])) return -Infinity;

    var uniq = {}; filled.forEach(function (v) { uniq[v] = 1; });
    var avgLen = filled.reduce(function (a, v) { return a + v.length; }, 0) / filled.length;
    var numish = filled.filter(function (v) {
      return /^[\d.]/.test(v) || !!S.parseDateish(v) || !!S.parseTimeish(v);
    }).length / filled.length;

    var below = rows.slice(i + 1, i + 6);
    var belowFill = below.length
      ? below.reduce(function (a, r) {
          return a + r.filter(function (v) { return !blank(v); }).length;
        }, 0) / (below.length * w)
      : 0;

    // 標題列應該蓋住下方真正有資料的欄位
    var dc = dataCols(rows, i + 1), dcKeys = Object.keys(dc);
    var hit = 0;
    cells.forEach(function (v, c) { if (v !== '' && dc[c]) hit++; });
    var coverage = dcKeys.length ? hit / dcKeys.length : 0;

    // 涵蓋率權重要夠高：甘特圖的標題列本來就是月份數字（7、8、9），
    // 「標題不該是數字」的扣分會蓋過一切，讓跨欄大標反而勝出。
    return coverage * 4                                    // 標題該蓋住底下有資料的欄
         + (filled.length / w) * 2                         // 填得越滿越像標題
         + Object.keys(uniq).length / filled.length        // 欄名不該重複
         + (avgLen <= 12 ? 1 : avgLen <= 20 ? 0.3 : -0.5)  // 標題通常短
         - numish                                          // 但數字標題是有的，扣分放輕
         + belowFill                                       // 下面要有資料
         - i * 0.08;                                       // 越前面越優先
  }

  function buildTable(rows, meta) {
    var w = rows[0].length;
    var best = 0, bestScore = -Infinity;
    var limit = Math.min(rows.length, 12);
    for (var i = 0; i < limit; i++) {
      var sc = scoreHeader(rows, i, w);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }

    var preamble = rows.slice(0, best)
      .map(function (r) {
        return r.map(function (v) { return String(v).replace(/\s+/g, ' ').trim(); })
                .filter(Boolean).join(' · ');
      })
      .filter(Boolean);

    // 只有一格有值的列不能當成合計：請假表裡「3月」沒請假就是這種樣子，那是正常資料。
    // 改成碰到「總計/合計」之後的所有列才算尾巴。
    var body = [], totals = [], seenTotal = false;
    rows.slice(best + 1).forEach(function (r) {
      if (r.every(blank)) return;
      var first = String(r.filter(function (v) { return !blank(v); })[0] || '').trim();
      if (RE_TOTAL.test(first)) { seenTotal = true; totals.push(r); return; }
      // 夾在資料中間的小計：前兩欄（識別碼）空白，但後面數值欄有值。
      // 這種列不是資料，也不代表表格結束——後面通常還有更多資料。
      var idBlank = blank(r[0]) && (r.length < 2 || blank(r[1]));
      var numFilled = r.slice(2).filter(function (v) {
        return !blank(v) && /^[\d,.\-]+$/.test(String(v).trim());
      }).length;
      if (idBlank && numFilled >= 2) { totals.push(r); return; }
      if (seenTotal) { totals.push(r); return; }
      body.push(r);
    });

    var header = rows[best].slice();
    var notes = [];

    var col = collapsePeriods(header, body);
    if (col) { header = col.header; body = col.rows; notes.push(col.note); }

    var fd = fillDownLabels(header, body);
    if (fd.length) notes.push('向下填補合併儲存格：' + fd.join('、'));

    return {
      title: preamble.join(' · '),
      headerRow: best,
      grid: [header].concat(body),
      totals: totals,
      skipped: preamble.length,
      notes: notes,
      range: meta
    };
  }

  /* 甘特圖：日期散在一排時間軸欄位上，每列只落在其中一格。
     那排欄位的「位置」和日期本身重複，收合成單一日期欄才讀得出來。 */
  function collapsePeriods(header, rows) {
    if (!rows.length) return null;
    var n = header.length, dateish = [], c;
    for (c = 0; c < n; c++) {
      var vals = rows.map(function (r) { return String(r[c] == null ? '' : r[c]).trim(); })
                     .filter(Boolean);
      if (!vals.length) continue;
      var ok = vals.filter(function (v) { return !!S.parseDateish(v); }).length / vals.length;
      if (ok >= 0.8) dateish.push(c);
    }
    if (dateish.length < 3) return null;

    var multi = rows.filter(function (r) {
      return dateish.filter(function (c2) { return !blank(r[c2]); }).length > 1;
    }).length;
    if (multi / rows.length > 0.15) return null;      // 一列有多個日期就不是甘特圖

    // 時間軸範圍內、收合後空掉的欄是軸的殘骸（那些「7」「10」的月份標頭），一併清掉。
    // 只限這個範圍——請假表那種整欄空白的「事假」是真欄位，不能砍。
    var lo = Math.min.apply(null, dateish), hi = Math.max.apply(null, dateish);
    var keep = [];
    for (c = 0; c < n; c++) {
      if (dateish.indexOf(c) >= 0) continue;
      var any = rows.some(function (r) { return !blank(r[c]); });
      if (any) { keep.push(c); continue; }
      if (c >= lo && c <= hi) continue;              // 軸內的空殼
      // 軸的月份標頭可能落在日期範圍之外（標頭在 C/G/K…，日期只出現在 D 到 Z）。
      // 空欄而且欄名是純數字 → 也是軸的殘骸；欄名是文字的空欄要留（例如請假表的「病假」）。
      if (/^\d{1,4}$/.test(String(header[c]).trim())) continue;
      if (!blank(header[c])) keep.push(c);
    }
    return {
      header: keep.map(function (c2) { return header[c2]; }).concat(['日期']),
      rows: rows.map(function (r) {
        var v = '';
        dateish.forEach(function (c2) { if (!v && !blank(r[c2])) v = String(r[c2]).trim(); });
        return keep.map(function (c2) { return r[c2]; }).concat([v]);
      }),
      note: '把散在 ' + dateish.length + ' 欄時間軸上的日期收合成單一「日期」欄'
    };
  }

  /* 合併儲存格：分類只填在每組第一列，其餘留白。往下補齊才分得了組。 */
  function fillDownLabels(header, rows) {
    var done = [];
    for (var c = 0; c < Math.min(header.length, 2); c++) {
      var vals = rows.map(function (r) { return String(r[c] == null ? '' : r[c]).trim(); });
      var filled = vals.filter(Boolean);
      if (!filled.length) continue;
      var uniq = {}; filled.forEach(function (v) { uniq[v] = 1; });
      var distinct = Object.keys(uniq).length;
      // 數值欄絕對不能向下填補：空白代表「沒有」，不是「同上」。
      // 請假表把「特休」填下去，等於讓沒請假的月份繼承上個月的時數——那是捏造資料。
      var numeric = filled.filter(function (v) {
        return /^-?[\d,]+(\.\d+)?$/.test(v);
      }).length;
      if (numeric / filled.length > 0.3) continue;

      // 稀疏、少量相異值、且不是每列都有 → 典型的合併儲存格
      if (filled.length / rows.length > 0.6 || distinct > 20 || distinct < 2) continue;
      var last = '';
      rows.forEach(function (r, i) {
        if (vals[i]) last = vals[i];
        else if (last) r[c] = last;
      });
      done.push(header[c] || ('欄 ' + (c + 1)));
    }
    return done;
  }

  /* 把一張工作表切成獨立的表格區塊 */
  function findTables(grid) {
    var g = normalize(grid);
    if (!g.length || !g[0].length) return [];
    var h = g.length, w = g[0].length;

    var colBlank = [], c, r;
    for (c = 0; c < w; c++) {
      var any = false;
      for (r = 0; r < h; r++) if (!blank(g[r][c])) { any = true; break; }
      colBlank.push(!any);
    }
    var rowBlank = g.map(function (row) { return row.every(blank); });

    var colRuns = runs(colBlank), rowRuns = runs(rowBlank), tables = [];

    // 空白欄不一定是表格分界：甘特圖的時間軸本來就很稀疏，
    // 硬切會把一張表絞成好幾塊、欄名全變成「欄 1」。
    // 只有當每一塊都找得到一列「大部分格子有字」的標題列時，才承認這是並排的獨立表格。
    if (colRuns.length > 1) {
      var ok = colRuns.every(function (cr) {
        var width = cr[1] - cr[0] + 1;
        if (width < 2) return false;
        for (var i = 0; i < Math.min(h, 12); i++) {
          var filled = 0;
          for (var c = cr[0]; c <= cr[1]; c++) if (!blank(g[i][c])) filled++;
          if (filled / width >= 0.6 && filled >= 2) return true;
        }
        return false;
      });
      if (!ok) colRuns = [[0, w - 1]];
    }

    colRuns.forEach(function (cr) {
      var chunks = [];
      rowRuns.forEach(function (rr) {
        var sub = [];
        for (var i = rr[0]; i <= rr[1]; i++) sub.push(g[i].slice(cr[0], cr[1] + 1));
        if (sub.some(function (row) { return row.some(function (v) { return !blank(v); }); }))
          chunks.push({ rows: sub, r0: rr[0] });
      });
      if (!chunks.length) return;

      // 第一個夠大的區塊是主表，後面矮的（合計、註腳）併回去
      var main = null;
      chunks.forEach(function (ch) {
        if (!main && ch.rows.length >= 3) {
          main = ch;
        } else if (main) {
          main.rows = main.rows.concat([new Array(main.rows[0].length).fill('')], ch.rows);
        }
      });
      if (!main) main = chunks[0];

      var t = buildTable(main.rows, { c0: cr[0], c1: cr[1], r0: main.r0 });
      if (t.grid.length >= 2 && t.grid[0].length >= 2) tables.push(t);
    });

    return tables;
  }

  S.findTables = findTables;

  /* 包一層：先切表，再對每一塊做原本的判型 */
  S.analyseSheet = function (grid) {
    var tables = findTables(grid);
    if (!tables.length) return { tables: [] };
    return {
      tables: tables.map(function (t) {
        var a = S.analyse(t.grid);
        if (a) {
          a.title = t.title;
          a.headerRow = t.headerRow;
          a.totals = t.totals;
          a.notes = t.notes || [];      // 做過哪些結構轉換，要讓使用者看得到
          a.range = t.range;
        }
        return a;
      }).filter(Boolean)
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
