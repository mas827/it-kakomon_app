#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""計算問題（数値計算で解答する問題）を自動判定し、data/calc_ids.json を生成する。

基準を今後くり返し調整する前提のツール。questions.json には一切触れない。
判定ロジック・除外リストはすべてこのファイルの中に閉じている。

  tools/mark_calc.py            今の判定結果と、既存ファイルとの差分を表示（書き込まない）
  tools/mark_calc.py --apply    data/calc_ids.json を再生成する
  tools/mark_calc.py --check    calc_ids.json が今の判定結果と一致するか検査（validate.pyが使う）
  tools/mark_calc.py --review   「要確認」バケットだけを1行形式で一覧（判断材料）

## 選定基準

定義: 解答に至るまでに数値計算（四則演算・単位換算・確率・期待値）が必要な問題。

| 含める | 含めない |
|---|---|
| 選択肢が数値・単位つき数値 | 用語の意味や説明を問うもの（計算用語が出てきても） |
| 設問が「幾らか／何%／何秒／求めよ／期待値」で数値を算出 | 計算量のオーダー比較だけで具体的な数値計算をしないもの |
| 式を選ぶが算出過程が計算のもの（例 NO2... 平均値の式） | SQLの集計関数を含むが問うているのは構文 |

## 判定の仕組み

1. STRONG: 選択肢が4つとも「数値（単位つき可）」→ ほぼ誤判定が無いので自動的に含める
2. WEAK: 設問文が計算を示す言い回し（幾らか／何%／求めよ／期待値 等）を含む
   → STRONGに無い場合は「要確認」に回し、人がレビューしてから EXCLUDE/INCLUDE に振り分ける
   （実際にレビュー済みの判断は本ファイル内の EXCLUDE_OVERRIDE / INCLUDE_OVERRIDE に理由つきで残す）
3. 最終集合 = (STRONG ∪ WEAK ∪ INCLUDE_OVERRIDE) − EXCLUDE_OVERRIDE
   EXCLUDE_OVERRIDE は常に最優先（自動判定より人の判断を信用する）

## 基準を変えたいとき

このファイルの正規表現・EXCLUDE_OVERRIDE・INCLUDE_OVERRIDE を編集してから
`--apply` → `python3 tools/validate.py` でドリフト0を確認する。
"要確認" が新たに増えたら `--review` で1行形式のリストを出し、判断を override に追記する。
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")
OUT = os.path.join(ROOT, "data", "calc_ids.json")

# --- STRONG: 選択肢が数値（単位つき可）かどうか ------------------------------------
# SI接頭辞(k/K/M/G/T/m/μ/n)は単位の直前にスペース無しでも付くことがある
# （例 "192k", "350kビット/秒"）ので、数値とSI接頭辞の間にスペースを要求しない。
UNIT = (r"(?:[%％]|ビット(?:/秒)?|バイト(?:/秒)?|(?:ナノ|マイクロ|ミリ)?秒|分|時間|円|個|倍|"
        r"通り|件|人|回|日|年|ms|μs|ns)?")
NUM_CHOICE = re.compile(
    r"^[\s$\\]*[-+]?[\d０-９][\d０-９,，.．]*"
    r"\s*[kKMGTmμn]?\s*" + UNIT + r"\s*[$\\]*$"
)


def is_numeric_choice(c):
    s = str(c).strip()
    return bool(NUM_CHOICE.match(s))


def all_choices_numeric(q):
    return all(is_numeric_choice(c) for c in q["choices"])


# --- WEAK: 設問文が計算を示す言い回しを含むか ---------------------------------------
CALC_STEM = re.compile(
    r"(幾らか|いくらか|何[%％ビバ秒分時円個倍通件人回日年]|何ミリ|何マイクロ|何ナノ|"
    r"求めよ|算出|計算し|最小値|最大値|期待値|平均.{0,4}か|確率は)"
)


def stem_looks_calc(q):
    return bool(CALC_STEM.search(q["question"]))


# --- 人によるレビュー結果（理由つき） ------------------------------------------------
# 「要確認」バケットを実際にレビューした結果。基準を変えても消えないよう、
# ここに決定とその理由を残す。キーはid、値は理由。

EXCLUDE_OVERRIDE = {
    # WEAK（設問文に計算っぽい言い回し）に拾われたが、計算問題ではないもの
    "2011A-44": "「確認を求める」の『求め』に反応しただけ。セキュリティ対策を選ぶ知識問題",
    "NO1-26": "SQLのHAVING句の構文を問う問題。AVG()という集計関数が出るが計算はしない",
    "2012A-03": "探索アルゴリズムの計算量オーダーの組合せを選ぶ問題。具体的な数値計算はしない",
    "2015A-26": "ハッシュ関数の性質（キー値の衝突）を問う知識問題。『算出』は一般論の説明で、"
                "解答者が数値計算をするわけではない",
    "NO1-40": "ディジタル署名の検証手順として正しい説明文を選ぶ知識問題。選択肢はどれも"
              "手順の文章で、数値は算出しない",
}

INCLUDE_OVERRIDE = {
    # STRONG/WEAKどちらにも拾われないが計算問題のもの
    # --- 解説に計算の痕跡がある49問を精査して追加（2026-10-31）。
    #     選択肢が数値でないため STRONG に掛からないものが大半 ---
    "NO1-52": "アローダイアグラムの各経路の所要日数を合計して最長経路を求める",
    "2012A-52": "アローダイアグラムの日数計算（短縮できる作業の特定）",
    "2014A-52": "アローダイアグラムの各経路の所要日数を合計してクリティカルパスを求める",
    "2017A-53": "同上。選択肢が経路（A→B→E…）なので数値の正規表現では拾えない",
    "2018H-51": "アローダイアグラムの日数計算。2012A-52と同一問題",
    "NO2-10": "ヒット率とアクセス時間から実効アクセス時間を計算して順に並べる",
    "2011A-11": "同上（NO2-10と同一問題）",
    "2014A-11": "同上",
    "NO3-01": "16進小数を10進分数に変換する計算",
    "2010A-01": "同上（16進小数3A.5C）",
    "NO3-69": "購入者数×乗換率で人数を計算して選択肢の記述を検証する",
    "2011A-70": "同上（NO3-69と同一問題）",
    "2009A-39": "サブネットマスクからネットワークアドレスを計算する",
    "2011A-06": "剰余計算で配列の格納位置を求める",
    "2013A-07": "同上（2011A-06と同種）",
    "2012A-06": "2分探索の中間位置 (x+y)/2 を求める計算",
    "2012A-07": "再帰関数の乗算回数を漸化式から数え上げる",
    "2012A-15": "多重化システムの稼働率を計算する。選択肢が式なので数値では拾えない",
    "2015H-15": "並列・直列構成の稼働率を計算して最も高い構成を選ぶ",
    "2012A-64": "5年間のROIを計算して比較する。選択肢が案の記号なので数値では拾えない",
    "2015A-65": "同上（2012A-64と同種）",
    "2016A-62": "耐用年数と投資回収期間から年間利益を計算して比較する",
    "2016A-64": "重み付け総合評価法で評価点×重みを合計して比較する",
    "2013A-22": "D/A変換器の分解能から出力電圧を計算する",
    "2014A-74": "各工程の能力から必要な設備数・生産量を計算する",
    "2016A-16": "到着率×実行時間(0.2×20=4)と多重度3を比較する待ち行列の計算",
    "2016A-34": "NTPの往復時間からサーバとの時刻差をマイクロ秒で計算する",
    "2015H-21": "印刷時間を積み上げて3台のプリンタの所要時間を計算し順に並べる",
    "2017A-01": "シフトと加算で10倍を作る計算（2ビット左シフト＝4倍 等）",
    "2017A-66": "人月コスト＋購入費＋委託費を計算して最安の開発方法を選ぶ",
    "2009A-01": "平均値の算出式（KaTeXの数式）を選ぶ問題。選択肢が数値でないため正規表現では"
                "拾えないが、算出過程そのものが計算",
    "2015A-66": "入札価格と技術点から総合評価値を計算して落札社を選ぶ問題。選択肢は『A社』などの"
                "社名だが、そこに至る過程が計算",
    "NO3-37": "ブルートフォース攻撃に必要な試行回数（鍵空間の大きさ）を求める組合せ計算の問題。"
              "選択肢に$2^{128}$等のKaTeX指数表記が混じり数値のみの正規表現では拾えない",
}


def classify(D):
    strong, weak = set(), set()
    for q in D:
        i = q["id"]
        if all_choices_numeric(q):
            strong.add(i)
        elif stem_looks_calc(q):
            weak.add(i)

    review = {i for i in weak if i not in EXCLUDE_OVERRIDE and i not in INCLUDE_OVERRIDE}
    final = (strong | weak | set(INCLUDE_OVERRIDE)) - set(EXCLUDE_OVERRIDE)
    return {
        "final": final,
        "strong": strong,
        "weak": weak,
        "review": review,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="data/calc_ids.json を再生成する")
    ap.add_argument("--check", action="store_true", help="既存ファイルとの一致だけ検査(終了コード)")
    ap.add_argument("--review", action="store_true", help="要確認バケットを1行形式で一覧")
    a = ap.parse_args()

    D = json.load(open(Q))
    byid = {q["id"]: q for q in D}
    result = classify(D)
    final = result["final"]

    if a.review:
        if not result["review"]:
            print("要確認: 0件")
            return
        print(f"要確認: {len(result['review'])}件")
        for i in sorted(result["review"]):
            q = byid[i]
            print(f"  {i}  {q['question'][:50].strip()}  | {q['choices'][0]}".replace("\n", " "))
        return

    prev_ids = set()
    if os.path.exists(OUT):
        prev_ids = set(json.load(open(OUT))["ids"])

    if a.check:
        if prev_ids != final:
            added = sorted(final - prev_ids)
            removed = sorted(prev_ids - final)
            print(f"calc_ids.jsonが判定結果とズレている (+{len(added)} / -{len(removed)})")
            sys.exit(1)
        print(f"OK: calc_ids.json は判定結果と一致（{len(final)}件）")
        return

    added = sorted(final - prev_ids)
    removed = sorted(prev_ids - final)
    print(f"判定結果: {len(final)}件（strong={len(result['strong'])} weak={len(result['weak'])} "
          f"要確認={len(result['review'])} override: +{len(INCLUDE_OVERRIDE)}/-{len(EXCLUDE_OVERRIDE)}）")
    if prev_ids:
        print(f"既存ファイルとの差分: +{len(added)} / -{len(removed)}")
        if added:
            print("  追加:", ", ".join(added[:20]), ("..." if len(added) > 20 else ""))
        if removed:
            print("  削除:", ", ".join(removed[:20]), ("..." if len(removed) > 20 else ""))
    if result["review"]:
        print(f"要確認が{len(result['review'])}件あります → --review で一覧")

    if a.apply:
        json.dump({"ids": sorted(final)}, open(OUT, "w"), ensure_ascii=False, indent=0)
        print(f"書き込み: {OUT}（{len(final)}件）")


if __name__ == "__main__":
    main()
