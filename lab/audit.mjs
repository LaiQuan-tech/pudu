#!/usr/bin/env node
/**
 * 批次體檢：把一堆試算表跑過引擎，自動指出哪些判壞了。
 *
 *   node audit.mjs <檔案或資料夾或網址> [更多...]
 *   node audit.mjs ./corpus            # 整個資料夾的 csv / xlsx
 *
 * 不需要 API 金鑰。重點不是「跑得完」，是把可疑的結果標出來——
 * 今天最痛的問題是「修 A 弄壞 B」，有一組固定的表每次跑過就有解。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const g = {};
new Function('window', fs.readFileSync(path.join(here, 'detect.js'), 'utf8'))(g);
const { SheetShape } = g;

let XLSX = null;
try { XLSX = (await import('xlsx')).default; } catch { /* 沒裝就只跑 csv */ }

/* ── 讀 ── */
function parseCSV(t) {
  const R = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
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
    if (!m) throw new Error('不是 Google 試算表網址');
    const gid = (src.match(/[#&?]gid=(\d+)/) || [])[1];
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` +
                          (gid ? `&gid=${gid}` : ''));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return [{ name: src.slice(0, 60), grid: parseCSV(await r.text()) }];
  }
  const ext = path.extname(src).toLowerCase();
  if (ext === '.csv' || ext === '.tsv')
    return [{ name: path.basename(src), grid: parseCSV(fs.readFileSync(src, 'utf8')) }];
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    if (!XLSX) throw new Error('要讀 Excel 請先 npm install xlsx');
    const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer' });
    // 一個活頁簿的每張工作表都各自體檢
    return wb.SheetNames.map(n => ({
      name: `${path.basename(src)} › ${n}`,
      grid: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false })
    }));
  }
  throw new Error(`不支援的副檔名 ${ext}`);
}

function expand(args) {
  const out = [];
  for (const a of args) {
    if (/^https?:/.test(a)) { out.push(a); continue; }
    if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
      fs.readdirSync(a).filter(f => /\.(csv|tsv|xlsx|xls|xlsm)$/i.test(f))
        .forEach(f => out.push(path.join(a, f)));
    } else out.push(a);
  }
  return out;
}

/* ── 體檢：哪些結果值得懷疑 ── */
function checkup(a, srcRows) {
  const flags = [];
  const rows = a.rows.length;
  const live = a.cols.filter(c => c.type !== 'empty');

  const auto = a.header.filter(h => /^欄 \d+$/.test(String(h).trim())).length;
  if (auto > a.header.length * 0.4)
    flags.push(`標題列可能判錯：${auto}/${a.header.length} 欄沒有欄名`);

  if (!a.roles.title) flags.push('找不到主標題欄，卡片會沒有名字');
  else {
    const i = a.header.indexOf(a.roles.title.name);
    const blank = a.rows.filter(r => !String(r[i] ?? '').trim()).length;
    if (blank > rows * 0.3)
      flags.push(`${blank}/${rows} 列沒有標題，會被整列略過`);
  }

  const textish = live.filter(c => c.type === 'text').length;
  if (live.length >= 3 && textish === live.length)
    flags.push('所有欄位都只判成一般文字，型別偵測沒抓到東西');

  if (a.shape.shape === 'cards' && live.length >= 4)
    flags.push('落到一般表格：沒有辨識出任何主軸');

  if (a.roles.group) {
    const gi = a.header.indexOf(a.roles.group.name);
    const keys = new Set(a.rows.map(r => String(r[gi] ?? '').trim()).filter(Boolean));
    if (keys.size === 1) flags.push(`分組欄「${a.roles.group.name}」只有一種值，等於沒分組`);
    if (keys.size > rows * 0.8 && rows > 8)
      flags.push(`分組欄「${a.roles.group.name}」幾乎每列都不同，會碎成一堆單筆段落`);
  }

  if (rows === 0) flags.push('沒有任何資料列');
  if (rows === 1) flags.push('只有一列資料，判斷幾乎沒有依據');

  // 從 40 列的工作表只抽出 2 列，多半是結構判壞了而不是資料真的只有兩列
  if (srcRows && rows > 0 && rows < srcRows * 0.2 && srcRows >= 10)
    flags.push(`原始工作表有 ${srcRows} 列，只抽出 ${rows} 列，結構可能判壞`);

  // 大半欄位是空的，通常是欄位邊界抓錯。
  // 但矩陣報表例外：請假表整年沒請假時「事假／病假」本來就整欄空白，
  // 那是正常資料，而且引擎刻意保留這些欄以維持形狀穩定。
  const empties = a.cols.length - live.length;
  if (a.shape.shape !== 'matrix' && a.cols.length >= 4 && empties > a.cols.length * 0.5)
    flags.push(`${empties}/${a.cols.length} 欄整欄空白，欄位邊界可能抓錯`);

  // 判成排程但日期幾乎每列都不同、又有金額欄 → 多半是明細帳不是行程
  if (a.shape.shape === 'schedule' && a.roles.group && a.roles.group.type === 'date') {
    const uniq = a.roles.group.distinct / Math.max(a.roles.group.filled, 1);
    const hasMoney = live.some(c => c.type === 'money');
    if (uniq > 0.8 && hasMoney)
      flags.push('判成排程，但日期幾乎每列都不同且有金額欄，可能其實是明細帳');
  }

  return flags;
}

/* ── 跑 ── */
const C = { d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
            g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m` };

const args = expand(process.argv.slice(2));
if (!args.length) {
  console.error('用法：node audit.mjs <檔案 / 資料夾 / 試算表網址> [更多...]');
  process.exit(1);
}

let clean = 0, flagged = 0, broken = 0, skipped = 0;
const shapes = {}, allFlags = {};

for (const src of args) {
  let sheets;
  try { sheets = await load(src); }
  catch (e) { broken++; console.log(`\n${C.r('✗')} ${src}\n  ${C.r(e.message)}`); continue; }

  for (const sh of sheets) {
    let tables;
    try { tables = SheetShape.analyseSheet(sh.grid).tables; }
    catch (e) { broken++; console.log(`\n${C.r('✗')} ${sh.name}\n  ${C.r('引擎爆掉：' + e.message)}`); continue; }

    // 說明頁、下拉選單來源、圖表暫存區不是「壞掉」，是本來就不該渲染
    const v = SheetShape.sheetVerdict(sh.grid, tables);
    if (v.show !== true) {
      skipped++;
      console.log(`${C.d('–')} ${C.d(sh.name)} ${C.d(v.why)}`);
      continue;
    }

    tables.forEach((a, i) => {
      const flags = checkup(a, sh.grid.length);
      const tag = tables.length > 1 ? ` [表${i + 1}/${tables.length}]` : '';
      shapes[a.shape.label] = (shapes[a.shape.label] || 0) + 1;
      if (flags.length) {
        flagged++;
        console.log(`\n${C.y('!')} ${C.b(sh.name + tag)}`);
        console.log(C.d(`  ${a.shape.label} · ${a.rows.length} 列 · 標題列第 ${a.headerRow + 1} 列` +
                        `${a.title ? ' · ' + a.title.slice(0, 40) : ''}`));
        flags.forEach(f => { console.log(C.y(`  · ${f}`)); allFlags[f.split('：')[0]] = (allFlags[f.split('：')[0]] || 0) + 1; });
      } else {
        clean++;
        console.log(`${C.g('✓')} ${sh.name + tag} ${C.d(a.shape.label + ' · ' + a.rows.length + ' 列')}`);
      }
    });
  }
}

console.log('\n' + '='.repeat(66));
console.log(C.b(`${clean} 乾淨 · ${flagged} 可疑 · ${skipped} 非資料頁（略過） · ${broken} 讀不進來`));
console.log(C.d('形狀分佈：' + Object.entries(shapes).map(([k, v]) => `${k} ${v}`).join('、')));
if (Object.keys(allFlags).length) {
  console.log(C.d('最常見的問題：'));
  Object.entries(allFlags).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([k, v]) => console.log(C.d(`  ${v}×  ${k}`)));
}
