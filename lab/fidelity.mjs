#!/usr/bin/env node
/**
 * 內容忠實度檢查：渲染出來的東西，真的是原始資料嗎？
 *
 *   node fidelity.mjs [資料夾或檔案或網址]
 *
 * 結構指標（有沒有切出表、標題列對不對）抓不到「數字配錯項目」這類錯誤。
 * 個人預算表曾經把 Housing 的房貸金額配到 Entertainment 的影音項目上，
 * 所有結構指標都是綠的，只有實際看畫面才發現。
 *
 * 這裡查三件事：
 *   1. 欄名重複 —— 並排區塊被併成一張表的鐵證
 *   2. 欄名中間有空欄且兩側都有資料 —— 同上，未切開的跡象
 *   3. 值被憑空造出來 —— 抽出的值必須在原始工作表的同一欄裡找得到
 *      （向下填補會搬動值，但只在同一欄內；不該出現原本不存在的值）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const g = {};
new Function('window', fs.readFileSync(path.join(here, 'detect.js'), 'utf8'))(g);
const { SheetShape } = g;
let XLSX = null;
try { XLSX = (await import('xlsx')).default; } catch {}

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
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`);
    return [{ name: src.slice(0, 50), grid: parseCSV(await r.text()) }];
  }
  const ext = path.extname(src).toLowerCase();
  if (ext === '.csv' || ext === '.tsv')
    return [{ name: path.basename(src), grid: parseCSV(fs.readFileSync(src, 'utf8')) }];
  const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer' });
  return wb.SheetNames.map(n => ({
    name: `${path.basename(src)} › ${n}`,
    grid: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false })
  }));
}

function expand(args) {
  const out = [];
  for (const a of args) {
    if (/^https?:/.test(a)) { out.push(a); continue; }
    if (fs.existsSync(a) && fs.statSync(a).isDirectory())
      fs.readdirSync(a).filter(f => /\.(csv|tsv|xlsx|xls)$/i.test(f)).forEach(f => out.push(path.join(a, f)));
    else out.push(a);
  }
  return out;
}

const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function check(a, grid) {
  const bad = [];

  // 1. 欄名重複 → 並排區塊被併成一張表
  const seen = {}, dup = [];
  a.header.forEach(h => {
    const k = norm(h);
    if (!k || /^欄 \d+$/.test(k)) return;
    if (seen[k]) { if (!dup.includes(k)) dup.push(k); } else seen[k] = 1;
  });
  if (dup.length)
    bad.push(`欄名重複（${dup.slice(0,3).join('、')}）→ 並排區塊可能被併成一張表，數字會配錯項目`);

  // 2. 欄名中間有空欄、兩側都有資料
  const named = a.header.map(h => !!norm(h) && !/^欄 \d+$/.test(norm(h)));
  const first = named.indexOf(true), last = named.lastIndexOf(true);
  if (first >= 0) {
    for (let i = first + 1; i < last; i++) {
      if (named[i]) continue;
      const hasData = a.rows.some(r => norm(r[i]));
      if (!hasData) { bad.push(`欄名中間有空欄（第 ${i+1} 欄）→ 兩組表格可能沒切開`); break; }
    }
  }

  // 3. 值被憑空造出來：抽出的值要能在原始工作表的同一欄找得到
  const src = {};
  grid.forEach(r => (r || []).forEach((v, c) => { const t = norm(v); if (t) (src[t] = src[t] || new Set()).add(c); }));
  let ghosts = 0, sample = null;
  a.rows.forEach(r => r.forEach(v => {
    const t = norm(v);
    if (t && !src[t]) { ghosts++; if (!sample) sample = t.slice(0, 20); }
  }));
  if (ghosts) bad.push(`${ghosts} 個值在原始資料裡找不到（例如「${sample}」）→ 可能被填補或轉換造出來`);

  return bad;
}

const args = expand(process.argv.slice(2).length ? process.argv.slice(2) : ['corpus-ms/files']);
const C = { d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
            g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m` };
let ok = 0, bad = 0; const tally = {};

for (const src of args) {
  let sheets; try { sheets = await load(src); } catch { continue; }
  for (const sh of sheets) {
    let tables; try { tables = SheetShape.analyseSheet(sh.grid).tables; } catch { continue; }
    if (SheetShape.sheetVerdict(sh.grid, tables).show !== true) continue;
    for (const a of tables) {
      if (a.rows.length < 3) continue;
      const problems = check(a, sh.grid);
      if (!problems.length) { ok++; continue; }
      bad++;
      console.log(`\n${C.r('✗')} ${C.b(sh.name)} ${C.d(a.shape.label + ' · ' + a.rows.length + ' 列')}`);
      problems.forEach(p => { console.log(C.r('  · ' + p)); tally[p.split('（')[0].split('→')[0].trim()] = (tally[p.split('（')[0].split('→')[0].trim()] || 0) + 1; });
    }
  }
}
console.log('\n' + '='.repeat(66));
console.log(C.b(`${ok} 忠實 · ${bad} 有疑慮`));
Object.entries(tally).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(C.d(`  ${v}×  ${k}`)));
