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
    if ((m = s.match(/^(\d{1,2})\s*[\-\/.月]\s*(\d{1,2})\s*日?$/)))
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
    money:    /價|金額|費用|費$|價格|單價|小計|總計|預算|薪|price|amount|cost|fee|budget|total|salary/i,
    person:   /人員|負責|姓名|名字|承辦|窗口|聯絡人|主辦|owner|assignee|name|person|contact|staff|member/i,
    phone:    /電話|手機|聯絡|分機|phone|tel|mobile|cell/i,
    email:    /信箱|郵件|email|mail/i,
    status:   /狀態|進度|階段|status|state|stage|phase|完成|處理/i,
    category: /類別|分類|種類|群組|組別|部門|類型|category|type|group|dept|kind|tag/i,
    note:     /備註|說明|內容|描述|摘要|note|memo|remark|desc|comment|detail/i,
    qty:      /數量|人數|件數|qty|quantity|count|數$/i
  };

  function detectColumn(name, values) {
    var all = values.map(function (v) { return String(v == null ? '' : v); });
    var filled = all.filter(function (v) { return v.trim() !== ''; });
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
               - cols.indexOf(c) * 0.04;                     // 越左邊越優先
    });
    cand.sort(function (a, b) { return b._score - a._score; });
    return cand[0];
  }

  function detectShape(cols) {
    var date  = pick(cols, 'date');
    var time  = pick(cols, 'time');
    var money = pick(cols, 'money');
    var phone = pick(cols, 'phone');
    var mail  = pick(cols, 'email');
    var status = pick(cols, 'status');
    var person = pick(cols, 'person');
    var cat   = pick(cols, 'category');
    var title = pickTitle(cols);

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
    cols.forEach(function (c) {
      if (used[c.name] || c.type === 'empty') return;
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
    var shape = detectShape(live);
    return {
      header: header, rows: body, cols: cols,
      shape: shape, roles: assignRoles(live, shape)
    };
  }

  root.SheetShape = {
    analyse: analyse,
    detectColumn: detectColumn,
    parseDateish: parseDateish,
    parseTimeish: parseTimeish
  };
})(typeof window !== 'undefined' ? window : globalThis);
