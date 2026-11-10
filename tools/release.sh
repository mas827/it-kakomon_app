#!/bin/bash
# 検証 → ビルド → sw.js のキャッシュ版を +1 → 「今回アップロードすべきファイル」を出力
#   bash tools/release.sh
set -e
cd "$(dirname "$0")/.."

# origin/main の最新を先に取得しておく。この fetch を後段まで遅らせると、
# 下の sw.js 二重バンプ防止チェックが古いキャッシュ済み参照を見てしまい、
# 実際にはまだアップロード済みなのに「未アップロード」と誤判定する
# （逆に、本当は上げ直しが必要なのに素通りする向きの誤判定も起こり得る）。
git fetch -q origin 2>/dev/null || true

# GitHubに上げるファイルは「許可したものだけ」を並べる。
# 除外リスト方式だと、新しく作った内部メモや作業ファイルが黙って混ざるため、
# 許可リスト方式にしてある。公開するファイルが増えたら publishable() に足すこと。
# 公開：ブラウザが実際に読むもの。これが変わったときだけ sw.js の版を上げる
runtime_files() {
  echo index.html app.js manifest.json sw.js .nojekyll icon-192.png icon-512.png | tr ' ' '\n'
  ls images/*.png 2>/dev/null
  find katex -type f ! -name '.DS_Store' 2>/dev/null
}

# 復元用：アプリは読まないが、これが無いと作り直せないもの。
# data/*.json はビルド時に app.js へ取り込まれるので実行時には不要。
# それでも上げるのは、GitHubが手元以外で唯一のバックアップだから。
backup_files() {
  echo fe-study-app.jsx package.json package-lock.json | tr ' ' '\n'
  echo data/questions.json data/abbr.json data/calc_ids.json data/answer_keys.json | tr ' ' '\n'
  # 保守スクリプト。失うと検証・リリースの仕組みを作り直すことになる。
  # tools/ocr は ocr.swift からビルドする成果物（arm64バイナリ）なので含めない
  #   → swiftc -O tools/ocr.swift -o tools/ocr
  ls tools/*.py tools/*.sh tools/*.mjs tools/*.swift 2>/dev/null
}

publishable() { runtime_files; backup_files; }

# GitHub上(origin/main)の中身と1ファイルずつ照合する。
# git status は手元の古いコミットとの比較なので、すでに上げてあるファイルまで
# 「未追跡」として挙がってしまう。中身のハッシュで直に比べればその誤検出が無くなる。
differs_from_github() {
  remote=$(git rev-parse -q --verify "origin/main:$1" 2>/dev/null) || return 0  # GitHubに無い → 上げる
  [ "$remote" != "$(git hash-object "$1")" ]
}

# GitHub と中身が違うものだけを並べる（パスのみ・1行1件）
# 引数に関数名を渡すと、その範囲だけを見る
list_changed() {
  git rev-parse --verify -q origin/main >/dev/null || return 1
  "${1:-publishable}" | sort -u | while read -r f; do
    [ -f "$f" ] || continue
    differs_from_github "$f" || continue
    echo "$f"
  done
}

sw_matches_github() {
  r=$(git rev-parse -q --verify "origin/main:sw.js" 2>/dev/null) || return 1
  [ "$r" = "$(git hash-object sw.js)" ]
}

echo "== sw.js の画像リストを同期 =="
python3 tools/sync_sw_images.py

echo
echo "== 検証 =="
python3 tools/validate.py || { echo "検証NG。修正してから再実行してください。"; exit 1; }

echo
echo "== ビルド =="
npm run build 2>&1 | tail -3

# sw.js の版は「ブラウザが読むファイルが変わったとき」だけ上げる。
#  - バンプより後に調べると、何も変わっていないのに実行するたび版が上がり続ける
#  - 保守スクリプトや data/*.json を直しただけで上げると、
#    配信物は同じなのに全利用者のキャッシュを捨てさせることになる
changed=$(list_changed runtime_files | grep -v '^sw\.js$' || true)

echo
echo "== sw.js キャッシュ版 =="
cur=$(grep -oE "fe-exam-v[0-9]+" sw.js | head -1)
if [ -z "$changed" ]; then
  echo "  ${cur} のまま（ブラウザが読むファイルに変更なし）"
elif ! sw_matches_github; then
  echo "  ${cur} のまま（前回のぶんが未アップロードなので据え置き）"
else
  n=${cur#fe-exam-v}
  new="fe-exam-v$((n + 1))"
  sed -i '' "s/${cur}/${new}/" sw.js
  echo "  ${cur} → ${new}"
fi

echo
echo "=============================================="
echo " 今回アップロードするファイル"
echo "=============================================="
if out=$(list_changed); then
  if [ -z "$out" ]; then
    echo "  （なし。GitHub上と同じです）"
  else
    echo "$out" | sed 's/^/  /'
  fi
else
  echo "  (gitで比較できませんでした。下の一式をアップロードしてください)"
  echo "  index.html app.js manifest.json sw.js icon-192.png icon-512.png .nojekyll"
  echo "  images/ katex/ fe-study-app.jsx data/ tools/ package.json package-lock.json"
fi

cat <<'EOF'

ヒント
  - app.js は必ず含めること（GitHub Pagesはビルドしない）
  - sw.js も一緒に上げること（上げないと更新が反映されない）
  - .nojekyll が未アップロードなら必ず上げる（無いとPagesのビルドが失敗）
  - 学習履歴はブラウザのlocalStorageなので、再アップロードしても消えません
EOF
