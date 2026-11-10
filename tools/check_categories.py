#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重複問題どうしで category が食い違っていないか調べる。

同じ問題がIPAにより複数年度で再出題される（このデータセットでは正当に残している）ため、
本文の書き起こしゆれで別問題として扱われた際に category が別々に付いてしまうことがある。

  tools/check_categories.py

出力は3段階:
  - 片方を支持: キーワード判定が現在の2値のどちらかを支持している(参考程度。鵜呑みにしない)
  - 要確認: キーワードがどちらも支持しない、または無反応
自動修正はしない。questions.json の直接編集で対応すること。
"""
import json
import os
import re
import difflib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")

# 9分野の代表キーワード。あくまで「重複ペアの既存2値のどちらを支持するか」の一次判定用。
KEYWORDS = {
    "基礎理論": ["2進数", "16進数", "論理式", "ブール", "確率", "統計", "標本化", "符号化",
               "誤り検出", "ハミング", "浮動小数点", "集合", "真理値表", "逆ポーランド",
               "BNF", "構文", "サンプリング", "標本", "量子化"],
    "アルゴリズム": ["流れ図", "アルゴリズム", "再帰", "整列", "探索", "スタック", "キュー",
                  "木構造", "計算量", "クイックソート", "2分探索", "ハッシュ表", "連結リスト"],
    "コンピュータ構成": ["CPU", "クロック", "レジスタ", "キャッシュメモリ", "主記憶", "補助記憶",
                     "パイプライン", "A/D変換", "D/A変換", "センサ", "USB", "PCM", "ディスプレイ",
                     "液晶", "IoT", "組込み", "MIPS", "命令実行", "半導体"],
    "ソフトウェア": ["OS", "スケジューリング", "仮想記憶", "ページング", "デバイスドライバ",
                  "スプーリング", "リンカ", "ミドルウェア", "オープンソース", "ファイルシステム",
                  "マルチタスク", "ジョブ管理", "プロセス", "タスク", "割込み"],
    "データベース": ["SQL", "テーブル", "正規化", "トランザクション", "インデックス", "関係代数",
                  "ER図", "主キー", "外部キー", "ロック", "コミット", "ロールバック",
                  "関係データベース", "結合", "スキーマ"],
    "ネットワーク": ["LAN", "IPアドレス", "TCP", "UDP", "ルータ", "スイッチ", "DNS", "DHCP",
                  "伝送", "帯域", "OSI基本参照モデル", "FTTH", "Ethernet", "無線LAN", "SDN",
                  "IPv4", "IPv6", "MACアドレス", "ファイアウォール", "DMZ", "伝送時間", "伝送速度"],
    "セキュリティ": ["暗号", "認証", "ファイアウォール", "マルウェア", "ウイルス", "不正アクセス",
                  "脆弱性", "インジェクション", "フィッシング", "盗聴", "改ざん", "DoS攻撃",
                  "公開鍵", "秘密鍵", "電子署名", "アクセス制御", "セキュリティ"],
    "マネジメント": ["プロジェクト", "WBS", "EVM", "工程管理", "品質管理", "構成管理", "ITIL",
                  "サービスデスク", "監査", "インシデント管理", "SLA", "マネージャ", "進捗管理",
                  "レビュー"],
    "ストラテジ": ["経営", "マーケティング", "SWOT", "ROI", "CRM", "SCM", "ERP", "ビジネスモデル",
                "知的財産", "親和図法", "プロダクトライフサイクル", "BYOD", "特許", "商標",
                "委託契約", "経営戦略", "調達"],
}


def norm(s):
    return re.sub(r"[\s,、，．.もの]", "", s)


def score(q):
    text = q["question"] + q.get("explanation", "")
    return {cat: sum(text.count(k) for k in kws) for cat, kws in KEYWORDS.items()}


def suggest(a, b):
    """a, b のどちらかの category をキーワードが支持するか返す(参考情報。鵜呑みにしない)。"""
    s = score(a)
    best = max(s, key=lambda c: s[c])
    if s[best] == 0:
        return None
    top = [c for c, v in s.items() if v == s[best]]
    if len(top) > 1:
        # 同点なら a/b どちらかの現在値が含まれていればそれを採用
        for c in (a["category"], b["category"]):
            if c in top:
                return c
        return None
    return best


def find_mismatches(D):
    """近似重複ペア(語幹90%以上・正解の中身60%以上一致)のうち category が違うものを返す。"""
    M = {q["id"]: q for q in D}
    qs = sorted([(norm(q["question"]), q["id"]) for q in D])
    seen = set()
    out = []
    for i in range(len(qs)):
        for j in range(i + 1, min(i + 6, len(qs))):
            if difflib.SequenceMatcher(None, qs[i][0], qs[j][0]).ratio() < 0.90:
                continue
            a, b = M[qs[i][1]], M[qs[j][1]]
            k = (a["id"], b["id"])
            if k in seen:
                continue
            seen.add(k)
            if a["category"] == b["category"]:
                continue
            ka = norm(a["choices"][a["answer"]])
            kb = norm(b["choices"][b["answer"]])
            if difflib.SequenceMatcher(None, ka, kb).ratio() < 0.6:
                continue  # 語幹が似ているだけの別問題(誤検出)
            out.append((a, b))
    return out


def main():
    D = json.load(open(Q))
    mismatches = find_mismatches(D)
    if not mismatches:
        print("OK: 重複問題の分類不一致なし")
        return

    print(f"分類(category)が食い違っている重複問題: {len(mismatches)}組\n")
    for a, b in mismatches:
        sug = suggest(a, b)
        if sug in (a["category"], b["category"]):
            tag = f"→ 片方を支持: {sug}（鵜呑みにせず前例で裏取りすること）"
        else:
            tag = "→ 要確認（キーワードが無反応、またはどちらも支持しない）"
        print(f"{a['id']}({a['category']}) <-> {b['id']}({b['category']})  {tag}")
        print(f"   {a['question'][:70]}".replace("\n", " "))


if __name__ == "__main__":
    main()
