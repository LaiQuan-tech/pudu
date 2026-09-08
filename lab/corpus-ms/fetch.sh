#!/usr/bin/env bash
# 下載微軟公開的 Excel 範本作為測試語料。
# 這些是公開範本，不含任何個人資料，所以清單可以進 repo；
# 下載下來的 .xlsx 本身仍在 .gitignore 裡。
#
#   ./fetch.sh            下載到 ./files
#   node ../audit.mjs ./files
set -euo pipefail
cd "$(dirname "$0")"
P="https://createcatalog.public.onecdn.static.microsoft/catalog-assets/en-us"
mkdir -p files
ok=0; fail=0
while read -r cat guid suf; do
  out="files/${cat}_${guid:0:8}.xlsx"
  [ -s "$out" ] && { ok=$((ok+1)); continue; }
  if curl -sfL --max-time 20 -o "$out" "$P/$guid/TF${guid}${suf}.xlsx"; then
    ok=$((ok+1))
  else rm -f "$out"; fail=$((fail+1)); fi
done < templates.txt
echo "下載成功 $ok ／ 失敗 $fail"
