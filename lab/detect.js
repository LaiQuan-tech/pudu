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
    // 只有一欄金額也可能是明細帳：零用金支出表就是日期／內容／金額／說明／專案。
    // 兩欄以上放寬到 0.45，只有一欄時要求日期幾乎全相異（0.8）才算，
    // 避免把「有預算欄的活動排程」誤判成帳表。
    var uniqDate = date ? date.distinct / Math.max(date.filled, 1) : 0;
    if (date && ((moneys.length >= 2 && uniqDate > 0.45) ||
                 (moneys.length === 1 && uniqDate > 0.8))) {
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
    // 條件放寬的理由（用 57 個真實請假表跑出來的）：
    // 多一欄「備註」就從 4/4 掉到 3/4，同一個人不同年度因此判成不同形狀；
    // 整年沒請假時所有數值欄全空，nums 為 0 也會掉出去。
    // 結構是不是矩陣，不該被一欄註記或某一年剛好沒資料改變。
    var matrixish = numOrEmpty.length >= 2 &&
                    numOrEmpty.length / others.length >= 0.6 &&
                    (nums.length >= 1 || numOrEmpty.length === others.length);
    if (first && others.length >= 2 && matrixish &&
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

  var SHAPE_LABEL = {
    schedule: '排程／時程表', pricelist: '品項／價目表', directory: '名冊／通訊錄',
    board: '狀態清單', matrix: '矩陣／報表', ledger: '帳務／明細表', cards: '一般表格'
  };

  /* 手動指定版面時，角色要跟著重算。
     只改形狀的名字沒有用——渲染是看角色（哪欄分組、哪欄前導、哪欄標題）決定的，
     名字換了角色沒動，六種版面會渲染出一模一樣的畫面。 */
  function shapeAs(cols, allCols, name) {
    var date = pick(cols, 'date'), time = pick(cols, 'time');
    var money = pick(cols, 'money'), status = pick(cols, 'status');
    var cat = pick(cols, 'category'), person = pick(cols, 'person');
    var title = pickTitle(cols);
    var base = { shape: name, label: SHAPE_LABEL[name] || name, reason: '手動指定版面',
                 group: null, lead: null, title: title, person: person };

    if (name === 'schedule') { base.group = date; base.lead = time; }
    else if (name === 'pricelist') { base.group = cat; base.lead = money; }
    else if (name === 'directory') { base.group = cat; }
    else if (name === 'board') { base.group = status || cat; }
    else if (name === 'ledger') {
      var moneys = cols.filter(function (c) { return c.type === 'money'; });
      base.lead = moneys.filter(function (c) { return /含稅|總|合計|應收|小計/.test(c.name); })[0] ||
                  moneys[moneys.length - 1] || null;
    } else if (name === 'matrix') {
      base.matrix = true;
      base.title = (allCols || cols)[0] || title;
    } else {
      base.group = cat;                             // cards
    }
    return base;
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

  /* 有哪些欄位當分組軸說得通。
     日期和分類的標準不同：日期天生有序、可以用日期軌導覽，組數多不是問題；
     分類沒有順序，組數一多就等於沒分組。 */
  function groupOptions(a) {
    var out = [];
    a.cols.forEach(function (c) {
      if (['date', 'category', 'status', 'person'].indexOf(c.type) < 0) return;
      var i = a.header.indexOf(c.name);
      var vals = a.rows.map(function (r) { return String(r[i] == null ? '' : r[i]).trim(); })
                       .filter(Boolean);
      if (!vals.length) return;

      var keyed = {};
      vals.forEach(function (v) {
        var k = c.type === 'date' ? String(v).replace(/\D+/g, '-') : v;
        keyed[k] = (keyed[k] || 0) + 1;
      });
      var n = Object.keys(keyed).length;
      var avg = vals.length / n;
      var fill = vals.length / Math.max(a.rows.length, 1);

      if (n < 2) return;
      if (c.type === 'date') {
        if (avg < 1.3) return;                       // 幾乎每列一個日期就不算分組
      } else {
        if (n > 12 || avg < 2 || fill < 0.5) return; // 分類要少而滿
      }
      out.push({ name: c.name, type: c.type, groups: n, avg: Math.round(avg * 10) / 10 });
    });
    return out;
  }

  /* 值得放進篩選器的欄位。
     這跟分組軸是兩件事，門檻差很多：分組每一組都會變成畫面上的段落標題，
     多了就是災難；篩選只是下拉選單，50 個選項完全沒問題。
     普渡的「人員」有 50 個相異值——當分組軸糟透了，當篩選軸完美。 */

  var SPLIT = /[、,，;；\/\n]+|\s{1,}/;

  function tokenizeCell(v) {
    return String(v).replace(/[（(]/g, '、').replace(/[)）]/g, '、')
      .split(SPLIT)
      .map(function (x) { return x.trim().replace(/^[-–]+|[-–]+$/g, ''); })
      .filter(function (x) { return x && x.length <= 8 && !/[：:]/.test(x); });
  }

  function tally(list) {
    var m = {}, name = {};
    list.forEach(function (v) {
      var k = v.toLowerCase();                 // Jeff 和 jeff 是同一個人
      m[k] = (m[k] || 0) + 1;
      if (!name[k]) name[k] = v;
    });
    var keys = Object.keys(m);
    var avgLen = keys.length
      ? keys.reduce(function (a, k) { return a + name[k].length; }, 0) / keys.length
      : 0;
    return { counts: m, labels: name, n: keys.length, avgLen: avgLen };
  }

  function filterOptions(a) {
    var out = [];
    a.cols.forEach(function (c) {
      if (['category', 'status', 'person', 'text'].indexOf(c.type) < 0) return;
      var i = a.header.indexOf(c.name);
      var cells = a.rows.map(function (r) { return String(r[i] == null ? '' : r[i]).trim(); })
                        .filter(Boolean);
      if (cells.length < 4) return;

      // 一格多值的欄位（「副壇主、執行長」）要拆開才篩得準。
      // 但「蔡宜勳建築師」不該被拆，所以只有拆了真的變多才採用。
      var flat = tally(cells);
      var toks = []; cells.forEach(function (v) { toks = toks.concat(tokenizeCell(v)); });
      var tok = tally(toks);
      var multi = toks.length > cells.length * 1.25 && tok.n >= 2;
      var use = multi ? tok : flat;
      var total = multi ? toks.length : cells.length;

      var n = use.n;
      var avg = total / n;
      var fill = cells.length / Math.max(a.rows.length, 1);

      if (n < 2 || n > 60) return;               // 只有一種值篩了沒意義；太多也沒用
      if (avg < 1.5) return;                     // 幾乎每列都不同 → 篩完只剩一筆
      if (fill < 0.4) return;                    // 大半列沒填 → 篩掉的比留下的多
      if (use.avgLen > 12) return;

      out.push({
        name: c.name, type: c.type, multi: multi,
        options: n, avg: Math.round(avg * 10) / 10, fill: Math.round(fill * 100),
        score: fill * Math.min(avg, 8)           // 填得滿、每個選項有料 → 越適合
      });
    });
    out.sort(function (x, y) { return y.score - x.score; });
    return out;
  }

  /* 什麼時候值得問使用者：有兩個以上的軸可選，或目前沒分組但其實有軸可用。
     只有一個軸而且已經用了它 —— 沒什麼好問的。 */
  function shouldAsk(a) {
    var opts = groupOptions(a);
    var cur = a.roles.group ? a.roles.group.name : null;
    if (opts.length >= 2) return opts;
    if (opts.length === 1 && cur !== opts[0].name) return opts;
    return [];
  }

  root.SheetShape = {
    isNoise: function (c) { return serialLike(c) || codeLike(c); },
    shapeAs: shapeAs,
    groupOptions: groupOptions,
    filterOptions: filterOptions,
    tokenizeCell: tokenizeCell,
    shouldAsk: shouldAsk,
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

  // 單格是不是「數值感」的東西（數字、金額、百分比、日期、時間）
  function numericish(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return false;
    return /^[$€£¥＄]?\s*-?[\d,]+(\.\d+)?\s*%?$/.test(t) ||
           !!S.parseDateish(t) || !!S.parseTimeish(t);
  }

  /* 標題列的格子，型別應該跟它底下那一欄不一樣。
     這比「標題不該是數字」準得多：甘特圖的月份標題「7」底下是日期欄（型別不同，合理），
     但 $3,500.00 底下是一整欄金額（型別相同，那只是被誤選的資料列）。 */
  function typeContrast(rows, i, w) {
    var score = 0, counted = 0;
    for (var c = 0; c < w; c++) {
      var head = rows[i][c];
      if (blank(head)) continue;
      var below = [], k;
      for (k = i + 1; k < rows.length && below.length < 8; k++)
        if (!blank(rows[k][c])) below.push(rows[k][c]);
      if (below.length < 2) continue;

      var belowNum = below.filter(numericish).length / below.length;
      var headNum = numericish(head);
      counted++;
      if (headNum && belowNum >= 0.7) score -= 1;        // 數值標題配數值欄 → 多半是資料列
      else if (!headNum && belowNum >= 0.7) score += 1;  // 文字標題配數值欄 → 典型的標題
    }
    return counted ? score / counted : 0;
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

    // 標題列應該蓋住整張表有資料的欄位。
    // 分母必須是「整張表」而不是「這一列底下」：愈晚的候選底下剩的資料愈少，
    // 資料欄集合跟著縮小，涵蓋率就輕易衝到 1.0。
    // 窗口從 12 放寬到 30 之後，甘特圖的標題列因此從第 1 列跑到第 29 列。
    var dc = dataCols(rows, 1), dcKeys = Object.keys(dc);
    var hit = 0;
    cells.forEach(function (v, c) { if (v !== '' && dc[c]) hit++; });
    var coverage = dcKeys.length ? hit / dcKeys.length : 0;


    // 涵蓋率權重要夠高：甘特圖的標題列本來就是月份數字（7、8、9），
    // 「標題不該是數字」的扣分會蓋過一切，讓跨欄大標反而勝出。
    return coverage * 4                                    // 標題該蓋住整張表有資料的欄
         + typeContrast(rows, i, w) * 2.5                   // 型別要跟底下那一欄不一樣
         + (filled.length / w) * 2                         // 填得越滿越像標題
         + Object.keys(uniq).length / filled.length        // 欄名不該重複
         + (avgLen <= 12 ? 1 : avgLen <= 20 ? 0.3 : -0.5)  // 標題通常短
         - numish * 0.5                                     // 數字標題是有的，這條只留微弱訊號
         + belowFill                                       // 下面要有資料
         - i * 0.08;                                       // 越前面越優先
  }

  function buildTable(rows, meta) {
    var w = rows[0].length;
    var best = 0, bestScore = -Infinity;
    // 搜尋窗口 30 列：財務報表常有摘要區塊擋在真正的欄位標題前面。
    // 個人預算表的「Category | Projected cost | Actual cost」在第 14 列，
    // 窗口 12 完全搜不到。實測 12→18.2%、20→13.8%、30→13.5%，30 之後持平。
    var limit = Math.min(rows.length, 30);
    for (var i = 0; i < limit; i++) {
      var sc = scoreHeader(rows, i, w);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }

    var preambleRows = rows.slice(0, best);
    var preamble = rows.slice(0, best)
      .map(function (r) {
        return r.map(function (v) { return String(v).replace(/\s+/g, ' ').trim(); })
                .filter(Boolean).join(' · ');
      })
      .filter(Boolean);

    // 只有一格有值的列不能當成合計：請假表裡「3月」沒請假就是這種樣子，那是正常資料。
    // 改成碰到「總計/合計」之後的所有列才算尾巴。
    // 小計是一種列，不是終止符。
    // 舊寫法碰到第一個「總計」就把後面全部當成表尾——
    // 但財務報表的小計散佈在整份文件裡：個人預算表第 6 列是
    // 「Total monthly income」，那是摘要裡的一筆正常資料，
    // 結果後面 75 列全被丟掉，整張表憑空消失。
    var body = [], totals = [];
    rows.slice(best + 1).forEach(function (r) {
      if (r.every(blank)) return;
      var first = String(r.filter(function (v) { return !blank(v); })[0] || '').trim();
      if (RE_TOTAL.test(first)) { totals.push(r); return; }
      // 夾在資料中間的小計：前兩欄（識別碼）空白，但後面數值欄有值。
      // 這種列不是資料，也不代表表格結束——後面通常還有更多資料。
      var idBlank = blank(r[0]) && (r.length < 2 || blank(r[1]));
      var numFilled = r.slice(2).filter(function (v) {
        return !blank(v) && /^[\d,.\-]+$/.test(String(v).trim());
      }).length;
      if (idBlank && numFilled >= 2) { totals.push(r); return; }
      body.push(r);
    });

    var header = rows[best].slice();
    var notes = [];

    var col = collapsePeriods(header, body);
    if (col) { header = col.header; body = col.rows; notes.push(col.note); }

    var fd = fillDownLabels(header, body);
    if (fd.length) notes.push('向下填補合併儲存格：' + fd.join('、'));

    // 表格的名字取前言的最後一段——那通常是緊貼標題列上方的區塊標題
    // （例如 Entertainment），而不是更上面的公司抬頭或摘要金額。
    // 純數字的段落跳過：個人預算表右半部的前言是「$3,405.00 · $3,064.00 · Entertainment」，
    // 取第一段會讓分頁叫「$3,405.00」。
    var named = preamble.filter(function (t) {
      return !/^[$€£¥＄(]?\s*-?[\d,]+(\.\d+)?\s*[%)]?$/.test(t.trim());
    });
    return {
      name: named.length ? named[named.length - 1] : '',
      title: preamble.join(' · '),
      preambleRows: preambleRows,
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
      // 要認得 $1,000.00、(341.00)、12% 這些寫法。
      // 只比對純數字會讓金額欄逃過這道防護——那正是這條規則要擋的東西。
      var numeric = filled.filter(function (v) {
        return /^\(?\s*[$€£¥＄]?\s*-?[\d,]+(\.\d+)?\s*[%)]?\s*\)?$/.test(v);
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
        // 窗口要跟標題列搜尋一致（30 列）。停在 12 會拒絕合法的切割：
        // 個人預算表左右並排兩個區塊，右邊的標題在第 14 列，
        // 於是兩區塊被併成一張表，渲染出「Video/DVD $1,000」這種
        // 把房貸金額配到影音項目上的錯誤——比空白頁更糟。
        for (var i = 0; i < Math.min(h, 30); i++) {
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

      // 空白列在報表裡多半只是間隔，不是表格邊界——把同一組欄位裡的區塊全部接回來。
      // 舊寫法只從「第一個 ≥3 列的區塊」開始收，前面的整段被丟掉；
      // 現金流量表的空白列把它切成 [0-1][3][6-7][9][11...]，
      // 真正的標題列（Feb 2023 | Mar 2023 …）在第三塊，於是連同前面一起消失。
      var main = { rows: [], r0: chunks[0].r0 };
      chunks.forEach(function (ch, k) {
        if (k) main.rows.push(new Array(ch.rows[0].length).fill(''));
        main.rows = main.rows.concat(ch.rows);
      });

      var t = buildTable(main.rows, { c0: cr[0], c1: cr[1], r0: main.r0 });
      if (!(t.grid.length >= 2 && t.grid[0].length >= 2)) return;

      // 欄名重複 → 這其實是好幾張並排的表，切開才不會把數字配錯項目
      var k = headerPeriod(t.grid[0]);
      if (k) {
        for (var off = 0; off < t.grid[0].length; off += k) {
          var slice = t.grid.map(function (r) { return r.slice(off, off + k); });
          if (!slice.slice(1).some(function (r) { return r.some(function (v) { return !blank(v); }); })) continue;
          // 前言也是橫向並排的，要跟著切，否則兩張表會共用「114年度…115年度…」
          var pre = (t.preambleRows || []).map(function (r) {
            return r.slice(off, off + k).map(function (v) {
              return String(v).replace(/\s+/g, ' ').trim();
            }).filter(Boolean).join(' · ');
          }).filter(Boolean);
          var preNamed = pre.filter(function (x) {
            return !/^[$€£¥＄(]?\s*-?[\d,]+(\.\d+)?\s*[%)]?$/.test(x.trim());
          });
          tables.push({
            name: preNamed.length ? preNamed[preNamed.length - 1] : t.name,
            title: pre.length ? pre.join(' · ') : t.title,
            headerRow: t.headerRow,
            grid: slice, totals: t.totals.map(function (r) { return r.slice(off, off + k); }),
            skipped: t.skipped, notes: (t.notes || []).concat(['依重複的欄名切成並排的表格']),
            range: { c0: cr[0] + off, c1: cr[0] + off + k - 1, r0: main.r0 }
          });
        }
        return;
      }
      tables.push(t);
    });

    return tables;
  }

  /* 欄名重複的週期。並排的表格之間不一定有空白欄可切：
     孫偉勛的請假表是 月份|特休|事假|病假|勞保|月份|特休|事假|病假|勞保，
     E 欄是左邊的勞保、F 欄直接是右邊的月份，中間沒有縫。
     這時欄名本身的重複就是切點。 */
  function headerPeriod(header) {
    var h = header.map(function (x) {
      var t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
      return /^欄 \d+$/.test(t) ? '' : t;          // 自動編號視同空白
    });
    var n = h.length;
    if (!h[0]) return 0;                           // 第一欄是列標籤（月份、Category…），沒有就沒得比

    // 上限不能設 n/2：最後一塊不完整時週期會超過一半。
    // 林哲良的表是 9 欄（右半邊少一欄），週期 5 > 9/2，原本永遠試不到。
    for (var k = 2; k <= n - 2; k++) {
      // 錨點：每個週期的開頭都要等於第一欄。這條最能擋掉巧合的重複。
      var anchored = true;
      for (var c = k; c < n; c += k) if (h[c] !== h[0]) { anchored = false; break; }
      if (!anchored) continue;

      // 不要求整除也不要求完全相同：
      // 林哲良的右半邊少一欄（9 欄不能被 5 整除）；
      // 詹蕙菁三個年度並排，但每年請的假別不同（病假 vs 生理假）。
      var hit = 0, cmp = 0;
      for (var i = k; i < n; i++) { cmp++; if (h[i] === h[i % k]) hit++; }
      if (cmp < 2 || hit / cmp < 0.7) continue;   // 至少要有兩欄可比，否則沒有說服力

      var named = 0;
      for (var j = 0; j < k; j++) if (h[j]) named++;
      if (named >= 2) return k;                    // 至少兩個有名字的欄，否則是巧合
    }
    return 0;
  }

  /* 引述，不計算。
     摘要的數字必須是表上原本就寫著的——加總會跟表上的值對不起來
     （帳表實測差 1 元，是他們公式的進位），而且合計有階層，
     小計和總計混著相加會得到 4.7 倍的荒謬數字。
     兩個來源：前言裡的「標籤→數值」配對，以及合計列。 */

  // 會計負數寫成 ($341.00)：左括號和貨幣符號會連在一起，
  // 只允許一個前置字元會漏掉個人預算表的 Difference。
  var RE_IDLIKE = /(單號|編號|代號|序號|號碼|invoice\s*#|\bno\.?$|#$|\bid$)/i;
  var RE_NUMLIKE = /^\(?\s*[$€£¥＄]?\s*-?[\d,]+(\.\d+)?\s*[%)]?\s*\)?$/;

  function quotedFacts(grid, t) {
    var g = normalize(grid || []);
    var out = [], seen = {};
    var push = function (label, value, kind, at) {
      var k = label + '\u0000' + value;
      if (!label || !value || seen[k]) return;
      seen[k] = 1;
      out.push({ label: label, value: value, kind: kind, at: at });
    };
    var txt = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); };

    // 1. 前言：文字格右邊隔著幾個空格出現數字 → 這是作者自己寫的摘要
    var top = Math.min(t.headerRow || 0, g.length);
    for (var r = 0; r < top; r++) {
      var row = g[r];
      for (var c = 0; c < row.length; c++) {
        var lab = txt(row[c]);
        // 單號、編號不是數量。引述它們只會佔掉摘要的位置。
        if (!lab || lab.length > 70 || RE_NUMLIKE.test(lab) || RE_IDLIKE.test(lab)) continue;
        for (var d = 1; d <= 4 && c + d < row.length; d++) {
          var val = txt(row[c + d]);
          if (!val) continue;                       // 中間的空格跳過
          if (RE_NUMLIKE.test(val)) push(lab, val, 'preamble', 'R' + (r + 1) + 'C' + (c + d + 1));
          break;                                    // 碰到第一個有值的就停，不再往右找
        }
      }
    }

    // 2. 合計列：標籤照抄，不把小計說成總計
    (t.totals || []).forEach(function (row, i) {
      var lab = '';
      for (var c = 0; c < row.length; c++) {
        var v = txt(row[c]);
        if (v && !RE_NUMLIKE.test(v)) { lab = v; break; }
      }
      row.forEach(function (v, c) {
        var val = txt(v);
        if (!val || !RE_NUMLIKE.test(val)) return;
        var colName = txt((t.header && t.header[c]) || (t.grid && t.grid[0] ? t.grid[0][c] : ''));
        var named = colName && !/^欄 \d+$/.test(colName);
        if (!lab && !named) return;
        if (RE_IDLIKE.test(lab) || RE_IDLIKE.test(colName)) return;                 // 沒有列標籤也沒有欄名 → 這個數字說明不了什麼
        var full = lab ? (named ? lab + ' · ' + colName : lab) : colName;
        push(full, val, 'total', 'T' + (i + 1) + 'C' + (c + 1));
      });
    });

    return out;
  }

  /* 把引述壓成能放進手機一屏的摘要。
     帳表抽出 24 條但只有 12 個不重複的數字——同一個值掛在不同標籤下
     （小計與總計、不同年度的區段），全列出來等於沒有摘要。 */
  var RE_TOP  = /總計|合計|總額|餘額|balance|grand\s*total/i;
  var RE_DIFF = /差異|淨|difference|net(?!\w)/i;
  var RE_SUB2 = /小計|subtotal/i;

  function summarise(facts, limit) {
    // 只有「欄位相同」才合併同一個數值。
    // 個人預算表的 Income 1 與 Total monthly income 都是 $4,300，
    // 但那是兩件不同的事剛好相等，併起來會誤導。
    var colOf = function (l) { var i = l.lastIndexOf(' · '); return i < 0 ? '' : l.slice(i + 3); };
    var byKey = {};
    facts.forEach(function (f) {
      // 沒有欄位部分（前言的事實）就以自己的標籤為鍵，彼此不合併——
      // 只有「同一欄的同一個數字」才是真的重複。
      var k = f.value.replace(/\s/g, '') + '\u0000' + (colOf(f.label) || f.label);
      (byKey[k] = byKey[k] || { value: f.value, labels: [], kind: f.kind, at: f.at }).labels.push(f.label);
    });

    var rows = Object.keys(byKey).map(function (k) {
      var e = byKey[k], seen = {}, labels = [];
      e.labels.forEach(function (l) { if (!seen[l]) { seen[l] = 1; labels.push(l); } });
      var joined = labels.join(' / ');
      var zero = /^[^\d-]*0([.,]0+)?[^\d]*$/.test(e.value);   // 0 是最沒資訊量的數字
      var rank = RE_TOP.test(joined) ? 0
               : RE_DIFF.test(joined) ? 1
               : RE_SUB2.test(joined) ? 3
               : e.kind === 'preamble' ? 2 : 4;
      return { value: e.value, labels: labels, label: joined, kind: e.kind, at: e.at,
               rank: rank + (zero ? 3 : 0), n: labels.length };
    });

    rows.sort(function (a, b) { return a.rank - b.rank || b.n - a.n; });
    return limit ? rows.slice(0, limit) : rows;
  }

  S.summarise = summarise;
  S.quotedFacts = quotedFacts;
  S.headerPeriod = headerPeriod;
  S.findTables = findTables;

  /* 這張工作表值不值得渲染給人看？
     一個活頁簿裡有資料表，也有說明頁、下拉選單來源、圖表暫存區、公式彙總頁。
     原則是保守：藏掉一張真的資料表，比多顯示一張垃圾更糟，
     所以只有在明顯不是表格時才排除。 */
  function sheetVerdict(grid, tables) {
    var g = normalize(grid || []);
    var filled = g.filter(function (r) { return r.some(function (v) { return !blank(v); }); });
    if (!filled.length) return { show: false, why: '整張工作表空白' };

    tables = tables || [];
    if (!tables.length) return { show: false, why: '切不出任何表格區塊' };

    var main = tables.reduce(function (a, b) { return b.rows.length > a.rows.length ? b : a; });
    if (main.rows.length < 2) return { show: false, why: '只有 ' + main.rows.length + ' 列資料' };

    var live = main.cols.filter(function (c) { return c.type !== 'empty'; });
    if (!live.length) return { show: false, why: '沒有任何有值的欄位' };

    // 欄名全是數字或空的 → 圖表資料區、控制列殘骸這類東西
    var named = main.header.filter(function (h) {
      var t = String(h == null ? '' : h).trim();
      return t && !/^欄 \d+$/.test(t) &&
             !/^[$€£¥＄]?\s*-?[\d,]+(\.\d+)?\s*%?$/.test(t) && !S.parseDateish(t);
    }).length;
    if (!named) return { show: false, why: '沒有任何文字欄名，像圖表資料區或控制列' };

    var avgLen = live.reduce(function (a, c) { return a + c.avgLen; }, 0) / live.length;
    var headLen = main.header.filter(function (h) { return !blank(h); })
      .reduce(function (a, h, i, arr) { return a + String(h).trim().length / arr.length; }, 0);

    // 說明頁：欄名本身就是句子。
    // 不能只看資料長不長——待辦清單的「Done | Task」欄名很短、內容很長，
    // 那是不折不扣的資料表，而且正是手機最該讀的東西。
    if (live.length <= 2 && headLen > 20)
      return { show: false, why: '欄名本身就是句子，像說明頁' };
    if (live.length <= 1 && avgLen > 25)
      return { show: false, why: '只有一欄長文字，像說明頁' };

    // 下拉選單的來源清單：一兩欄「短文字」，沒有任何數值欄。
    // 有金額或數字就是真資料（例如 品項 | 金額 的支出清單）。
    var hasValue = live.some(function (c) {
      return ['money', 'number', 'date', 'time'].indexOf(c.type) >= 0;
    });
    if (live.length <= 2 && !hasValue && main.rows.length >= 3 && avgLen <= 12)
      return { show: 'weak', why: '只有一兩欄短文字且無數值，像下拉選單的來源清單' };

    return { show: true, why: '' };
  }

  S.sheetVerdict = sheetVerdict;

  /* 包一層：先切表，再對每一塊做原本的判型 */
  S.analyseSheet = function (grid) {
    var tables = findTables(grid);
    if (!tables.length) return { tables: [] };
    return {
      tables: tables.map(function (t) {
        var a = S.analyse(t.grid);
        if (a) {
          a.title = t.title;
          a.name = t.name;
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
