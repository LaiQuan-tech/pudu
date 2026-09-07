/**
 * 語意層：把規則層清洗過的結構送給模型，請它做規則做不到的判斷。
 *
 * 這個檔案不碰網路，只負責組輸入、定義輸出格式、比對兩邊的差異，
 * 所以 node 和瀏覽器都能用，也方便單獨測試。
 */
(function (root) {
  'use strict';

  var SHAPES = ['schedule', 'pricelist', 'directory', 'board', 'matrix', 'ledger', 'cards'];

  var SHAPE_ZH = {
    schedule: '排程／時程表', pricelist: '品項／價目表', directory: '名冊／通訊錄',
    board: '狀態清單', matrix: '矩陣／報表', ledger: '帳務／明細表', cards: '一般表格'
  };

  var SYSTEM = [
    '你在幫一個「把試算表變成手機好讀網頁」的工具做版面判斷。',
    '',
    '你會拿到三樣東西：',
    '1. 原始工作表的前幾列（未經處理，用來檢查結構有沒有被判錯）',
    '2. 規則引擎清洗後的結果（它認為標題列在哪、每欄是什麼型別）',
    '3. 清洗後的資料樣本',
    '',
    '規則引擎擅長結構（表格在哪、標題列在哪、哪些是合計），',
    '不擅長語意（這張表在講什麼、哪一欄是人要讀的名稱、該用什麼軸組織）。',
    '你的工作是補上語意判斷，並指出規則引擎判錯的地方。',
    '',
    '判斷時請把握幾個原則：',
    '- 標題欄是「人掃過去會先讀的那個名稱」，不是流水號或單號。',
    '- 有日期不代表要按日期分組。帳表的日期只是屬性，按它分組會變成幾十組各一兩筆。',
    '- 分組欄要能把資料分成有意義的幾群，每群最好有數筆。',
    '- hide_columns 放那些對閱讀沒有幫助的欄（流水號、內部代碼、整欄重複的值）。',
    '- 如果原始資料的前幾列顯示標題列被判錯了，一定要在 structure_problem 說出來。',
    '',
    '所有理由用繁體中文，簡短具體，不要客套。'
  ].join('\n');

  var SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['shape', 'shape_reason', 'title_column', 'group_column', 'lead_column',
               'highlight_columns', 'hide_columns', 'structure_ok', 'structure_problem',
               'disagreements', 'confidence'],
    properties: {
      shape: { type: 'string', enum: SHAPES, description: '這張表最適合的版面' },
      shape_reason: { type: 'string', description: '為什麼是這個版面，一兩句' },
      title_column: { type: ['string', 'null'], description: '人會先讀的主要名稱欄，用欄名原文' },
      group_column: { type: ['string', 'null'], description: '用來分段的欄；不該分組就填 null' },
      lead_column: { type: ['string', 'null'], description: '每筆最突出的那個值（時間、金額），沒有就 null' },
      highlight_columns: { type: 'array', items: { type: 'string' }, description: '值得顯眼呈現的欄' },
      hide_columns: { type: 'array', items: { type: 'string' }, description: '對閱讀沒幫助、建議收起的欄' },
      structure_ok: { type: 'boolean', description: '規則引擎的結構判斷（標題列、欄位）是否正確' },
      structure_problem: { type: 'string', description: 'structure_ok 為 false 時說明哪裡錯；否則空字串' },
      disagreements: { type: 'array', items: { type: 'string' },
                       description: '每一條說明你和規則引擎哪裡判斷不同、為什麼你的比較好' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
    }
  };

  /* 組送給模型的輸入。刻意壓小：欄位摘要 + 少量樣本，不送整張表。 */
  function buildInput(analysis, rawGrid) {
    var L = [];
    var cell = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); };

    if (rawGrid && rawGrid.length) {
      L.push('## 原始工作表前 8 列（未經處理）');
      rawGrid.slice(0, 8).forEach(function (r, i) {
        var cells = r.slice(0, 14).map(cell);
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        L.push('[' + i + '] ' + (cells.length ? cells.join(' | ') : '（空列）'));
      });
      L.push('');
    }

    L.push('## 規則引擎的判斷');
    if (analysis.title) L.push('表格標題（取自標題列以上的文字）：' + analysis.title);
    L.push('判定標題列：第 ' + (analysis.headerRow + 1) + ' 列');
    if (analysis.notes && analysis.notes.length)
      L.push('做過的結構轉換：' + analysis.notes.join('；'));
    if (analysis.totals && analysis.totals.length)
      L.push('分離出的合計列：' + analysis.totals.length + ' 條');
    L.push('判定形狀：' + (SHAPE_ZH[analysis.shape.shape] || analysis.shape.shape) +
           '（' + analysis.shape.reason + '）');
    L.push('');

    L.push('## 各欄判斷（共 ' + analysis.rows.length + ' 列資料）');
    analysis.cols.forEach(function (c) {
      var role = (analysis.roles.assigned || {})[c.name];
      L.push('- ' + c.name + '：型別=' + c.type +
             '、角色=' + (role || '無') +
             '、填有值 ' + c.filled + '/' + c.total +
             '、相異 ' + c.distinct +
             (c.samples.length ? '、範例「' + c.samples.map(cell).join('」「') + '」' : ''));
    });
    L.push('');

    L.push('## 資料樣本（前 12 列）');
    L.push(analysis.cols.map(function (c) { return c.name; }).join(' | '));
    analysis.rows.slice(0, 12).forEach(function (r) {
      L.push(r.map(cell).join(' | '));
    });

    return L.join('\n');
  }

  /* 規則層與模型的差異 */
  function compare(analysis, verdict) {
    var roles = analysis.roles || {};
    var nameOf = function (c) { return c ? c.name : null; };
    var rows = [
      ['版面', SHAPE_ZH[analysis.shape.shape] || analysis.shape.shape,
               SHAPE_ZH[verdict.shape] || verdict.shape],
      ['標題欄', nameOf(roles.title), verdict.title_column],
      ['分組欄', nameOf(roles.group), verdict.group_column],
      ['前導欄', nameOf(roles.lead), verdict.lead_column]
    ];
    return rows.map(function (r) {
      var a = r[1] == null ? '（無）' : r[1];
      var b = r[2] == null ? '（無）' : r[2];
      return { field: r[0], rules: a, model: b, same: a === b };
    });
  }

  root.SheetSemantic = {
    SYSTEM: SYSTEM, SCHEMA: SCHEMA, SHAPES: SHAPES, SHAPE_ZH: SHAPE_ZH,
    buildInput: buildInput, compare: compare
  };
})(typeof window !== 'undefined' ? window : globalThis);
