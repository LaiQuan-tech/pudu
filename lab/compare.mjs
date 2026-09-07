#!/usr/bin/env node
/**
 * 規則層 vs 語意層：量測模型比規則好多少。
 *
 *   npm install
 *   export ANTHROPIC_API_KEY=...
 *   node compare.mjs <試算表網址或本機 csv> [更多...]
 *
 * 金鑰只從環境變數讀，不會寫進任何檔案，也不會出現在網頁上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const g = {};
for (const f of ['detect.js', 'semantic.js'])
  new Function('window', fs.readFileSync(path.join(here, f), 'utf8'))(g);
const { SheetShape, SheetSemantic } = g;

const MODEL = 'claude-opus-5';

/* ── 讀資料 ── */
function parseCSV(t) {
  const R = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); R.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); R.push(row); }
  return R;
}

async function load(src) {
  if (/^https?:/.test(src)) {
    const m = src.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('看不出這是 Google 試算表網址');
    const gid = (src.match(/[#&?]gid=(\d+)/) || [])[1];
    const url = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` +
                (gid ? `&gid=${gid}` : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}（共用設定要是「知道連結的任何人」）`);
    return parseCSV(await r.text());
  }
  return parseCSV(fs.readFileSync(src, 'utf8'));
}

/* ── 問模型 ── */
const client = new Anthropic();

async function ask(analysis, rawGrid) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SheetSemantic.SYSTEM,
    messages: [{ role: 'user', content: SheetSemantic.buildInput(analysis, rawGrid) }],
    output_config: { format: { type: 'json_schema', schema: SheetSemantic.SCHEMA } }
  });
  if (res.stop_reason === 'refusal')
    throw new Error(`模型拒答：${res.stop_details?.category ?? '未知'}`);
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { verdict: JSON.parse(text), usage: res.usage };
}

/* ── 輸出 ── */
const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
            g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
            r: s => `\x1b[31m${s}\x1b[0m` };

function pad(s, n) {                       // 中文字寬度算 2
  const w = [...String(s)].reduce((a, ch) => a + (/[⺀-￿]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

async function run(src) {
  const grid = await load(src);
  const tables = SheetShape.analyseSheet(grid).tables;
  console.log('\n' + '='.repeat(72));
  console.log(C.b(src.length > 66 ? src.slice(0, 63) + '...' : src));
  console.log('='.repeat(72));
  if (!tables.length) return console.log(C.r('  找不到任何表格區塊'));

  let agree = 0, total = 0, cost = { i: 0, o: 0 };

  for (const [i, a] of tables.entries()) {
    console.log(`\n${C.b(`表 ${i + 1}`)}${a.title ? C.dim('  ' + a.title) : ''}`);
    let out;
    try { out = await ask(a, grid); }
    catch (e) { console.log(C.r('  模型呼叫失敗：' + e.message)); continue; }
    const { verdict: v, usage } = out;
    cost.i += usage.input_tokens; cost.o += usage.output_tokens;

    console.log(C.dim('  ' + pad('項目', 10) + pad('規則層', 22) + '模型'));
    for (const row of SheetSemantic.compare(a, v)) {
      total++; if (row.same) agree++;
      const mark = row.same ? C.g('=') : C.y('≠');
      console.log(`  ${mark} ${pad(row.field, 8)}${pad(row.rules, 22)}${row.same ? C.dim(row.model) : C.y(row.model)}`);
    }
    console.log(C.dim(`    理由：${v.shape_reason}`));
    if (!v.structure_ok) console.log(C.r(`    ⚠ 結構問題：${v.structure_problem}`));
    if (v.hide_columns?.length) console.log(C.dim(`    建議收起：${v.hide_columns.join('、')}`));
    v.disagreements?.forEach(d => console.log(C.y(`    · ${d}`)));
    console.log(C.dim(`    信心：${v.confidence}`));
  }
  return { agree, total, cost };
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node compare.mjs <試算表網址或 csv 檔> [更多...]');
  process.exit(1);
}
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('請先設定 ANTHROPIC_API_KEY');
  process.exit(1);
}
// HTTP header 只能放 Latin-1。金鑰若含中文，SDK 會丟出看不懂的 ByteString 錯誤，
// 幾乎都是佔位符忘了換掉，在這裡先擋下來講清楚。
if (!/^[\x20-\x7E]+$/.test(KEY)) {
  console.error('ANTHROPIC_API_KEY 含有非 ASCII 字元，看起來是佔位符沒換成真的金鑰。');
  console.error('目前的值開頭是：' + KEY.slice(0, 7) + '…（長度 ' + KEY.length + '）');
  process.exit(1);
}
if (!/^sk-ant-\S{20,}$/.test(KEY)) {
  console.error('ANTHROPIC_API_KEY 格式不像真的金鑰（應為 sk-ant- 開頭的長字串）。');
  console.error('目前長度 ' + KEY.length + ' 字元。');
  process.exit(1);
}

let A = 0, T = 0, IN = 0, OUT = 0;
for (const s of args) {
  try {
    const r = await run(s);
    if (r) { A += r.agree; T += r.total; IN += r.cost.i; OUT += r.cost.o; }
  } catch (e) { console.log(C.r(`\n${s}\n  ${e.message}`)); }
}
// Opus 5：輸入 $5/MTok、輸出 $25/MTok
const usd = IN / 1e6 * 5 + OUT / 1e6 * 25;
console.log('\n' + '='.repeat(72));
console.log(C.b(`規則層與模型一致：${A}/${T}` + (T ? `（${Math.round(A / T * 100)}%）` : '')));
console.log(C.dim(`輸入 ${IN} tokens、輸出 ${OUT} tokens，約 US$${usd.toFixed(4)}`));
console.log(C.dim('不一致的項目才是重點：那是規則層追不到、模型補得上的部分。'));
