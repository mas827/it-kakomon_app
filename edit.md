日常的な編集サイクル
1. Claude Codeで編集を依頼
# Claude Codeを起動
claude

# 例えばこう依頼する
> fe-study-app.jsxに問題を10問追加して
> セキュリティ分野の問題だけ別色にして
> セッション終了後にもう一度解けるボタンを追加して
2. ビルド
bashnpm run build
app.js が新しく生成されます。
3. GitHubに反映
bash# GitHubにログイン済みであれば
git add app.js
git commit -m "問題を追加"
git push
または GitHub のWeb画面から app.js を手動でアップロードしても同じです。
4. スマホで確認
数分後にGitHub PagesのURLをリロードすると反映されます。
反映されない場合(キャッシュが残っている):
- 対象タブを全部閉じてから開き直す(Service Workerが更新されやすい)
- それでも反映されない場合、PCのChromeのDevToolsで Application → Service Workers → Unregister、
  Cache Storage → 古いバージョン(fe-exam-vN)を削除してリロード
注意: 「サイトの設定 → ストレージを消去」は学習履歴(localStorage)も消えてしまうので避けること。