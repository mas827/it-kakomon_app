#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解説を選択肢ごとのブロックに分ける（文頭の ア/イ/ウ/エ の前で改行を入れる）。

解説が一塊の長文だと読みにくいので、「アは〜」「イ．〜」のように
**文頭に来る選択肢記号の前**で改行する。アプリの RichText は
`whiteSpace: pre-wrap` で描画するので、データに \\n を入れればそのまま改行になる。

  tools/fix_explanations.py          件数と差分サンプルを表示（書き込まない）
  tools/fix_explanations.py --apply  改行を入れる

## なぜ「文頭だけ」なのか

解説には**複数の選択肢をまとめて述べる文**がある。

  「ア、イ、ウの値は、dpiとポイントの単位換算を正しく適用していない場合の値である。」
  「アの管理表の作成、ウの管理方針の制定、エの運用管理は、いずれも監査対象部門の業務である。」

文中の記号でも切るとこれらが途中でぶつ切りになる。文頭（文字列の先頭、または「。」の直後）に
限定すれば、こうした文は**1ブロックのまま**残り、意味が壊れない。
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")

# 「。」の直後に来る選択肢記号の前。直前がすでに改行なら入れない（冪等）
PAT = re.compile(r'(?<=。)(?!\n)(?=[アイウエ](?:[．.、，]|は|が|の|に|について))')


def fix(text):
    return PAT.sub("\n", text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="改行を入れて保存する")
    a = ap.parse_args()

    D = json.load(open(Q))
    n_q = n_br = 0
    samples = []

    for q in D:
        e = q.get("explanation")
        if not isinstance(e, str) or not e:
            continue
        k = len(PAT.findall(e))
        if not k:
            continue
        n_q += 1
        n_br += k
        if len(samples) < 20:
            m = PAT.search(e)
            samples.append((q["id"], e[max(0, m.start() - 24):m.start()] + " ⏎ " + e[m.start():m.start() + 24]))
        q["explanation"] = fix(e)

    print(f"改行を入れる: {n_br}箇所 / {n_q}問")
    if samples:
        print("\n差分サンプル（⏎ が入る位置。前後24字）:")
        for qid, frag in samples:
            print(f"  {qid:<9} {frag}".replace("\n", "⏎"))

    if a.apply:
        json.dump(D, open(Q, "w"), ensure_ascii=False, separators=(",", ":"))
        print(f"\n書き込み: {Q}")
    else:
        print("\n（dry-run。実行するには --apply）")


if __name__ == "__main__":
    main()
