#!/usr/bin/env node
/**
 * 回歸測試：確認引擎對已知的表仍給出正確形狀。
 *
 *   node test.mjs        （不需要 API 金鑰；離線案例 + 四份真實表）
 *
 * 每次改規則都跑一次。今天最痛的問題是「修 A 弄壞 B」，
 * 這個檔案就是為了讓那件事被抓到而存在。
 */
import fs from 'node:fs';
const g={}; new Function('window', fs.readFileSync('detect.js','utf8'))(g);
const S=g.SheetShape;
function csv(t){const R=[];let row=[],f='',q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){ if(c==='"'){ if(t[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
  else if(c==='"')q=true; else if(c===','){row.push(f);f='';}
  else if(c==='\n'){row.push(f);R.push(row);row=[];f='';}
  else if(c!=='\r')f+=c;}
 if(f!==''||row.length){row.push(f);R.push(row);} return R;}
const cases={
 '價目表':['pricelist','品項,分類,單價,備註\n光明燈,點燈,600,一年\n太歲燈,點燈,800,一年\n平安米,結緣品,100,\n環保金紙,金紙,250,一份三支\n祈福蠟燭,結緣品,50,'],
 '通訊錄':['directory','姓名,職稱,電話,Email,組別\n林雅玲,活動組長,0912345678,ya@ex.com,活動組\n陳瑟君,總務,0923456789,se@ex.com,行政組\n王藝鐘,護駕,0934567890,yi@ex.com,護駕組'],
 '狀態清單':['board','工作項目,狀態,負責人,備註\n訂購金紙,已完成,活動組,共五箱\n場地佈置,進行中,全體人員,\n印製手冊,未開始,行政組,等文稿\n聯絡外燴,進行中,蓴姐,120份'],
 '無結構':['cards','編號,說明,數量\nA001,不鏽鋼供桌,3\nA002,紅色板凳,120\nA003,遮陽帳篷,8'],
};
let ok=0,bad=0;
for(const [n,[want,t]] of Object.entries(cases)){
  const a=S.analyseSheet(csv(t)).tables[0];
  const pass=a.shape.shape===want;
  console.log(`${pass?'✓':'✗'} ${n.padEnd(6)} 期望=${want.padEnd(10)} 實際=${a.shape.shape}`);
  pass?ok++:bad++;
}
const urls={普渡:['schedule','1b72qwLM_0xUdisA2uKxqUa98-EJwC-UJPyXsEaLJoiI'],
  甘特圖:['schedule','1DJIy4I7vbVgk9lBcnMCGq9z2wo-J8hR-hZzKHxwHSZs'],
  帳表:['ledger','1BsOykBCciRxZDDFe1-S957ONmf5chqt9']};
for(const [n,[want,id]] of Object.entries(urls)){
  const r=await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
  const a=S.analyseSheet(csv(await r.text())).tables[0];
  const pass=a.shape.shape===want;
  console.log(`${pass?'✓':'✗'} ${n.padEnd(6)} 期望=${want.padEnd(10)} 實際=${a.shape.shape}`);
  pass?ok++:bad++;
}
console.log(`\n${ok} 通過 · ${bad} 失敗`);
process.exit(bad?1:0);
