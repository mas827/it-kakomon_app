#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日本語の語の途中に紛れた半角空白（OCRの折り返し由来）を詰める。

「購買 データ」→「購買データ」のように、**日本語文字＋半角空白1つ＋日本語文字**だけを対象にする。
この条件なら「Web サイト」のような英単語との区切りは巻き込まない。

  tools/fix_spaces.py          件数と差分サンプルを表示（書き込まない）
  tools/fix_spaces.py --apply  置換を実行する

## 触らないもの

- **全角空白（`　`）** … 意図的な字下げに使われていることがある
- **数式（`$...$`）の中** … 中身はLaTeXでASCIIなので、そもそも上の条件に当たらない
- **Markdown表の行** … セル内で意図的な区切りに使われている（下記 EXCLUDE 参照）
- **真理値などの「値の並び」** … 詰めると設問が壊れる（下記 EXCLUDE 参照）
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")

# 日本語＋半角空白1つ＋日本語。後読み・先読みなので空白1文字だけを消す
# （[X] [X] の形で書くと連続した該当箇所を取りこぼす）
PAT = re.compile(r"(?<=[ぁ-んァ-ヶ一-龥]) (?=[ぁ-んァ-ヶ一-龥])")

# 選択肢そのものを「値の並び」として空白で区切っている問題があれば、ここに id を足す。
# 詰めると設問が壊れるため。
#
# 現在は空。かつて NO2-03 が choices = ['偽 偽', '偽 真', …]（QとRの真理値2つの並び）で
# 該当していたが、原本どおり解答群をMarkdown表に戻し choices を記号のみにしたため解消した
# （表の行は is_table_line() 側で除外されるので、ここに書く必要はない）。
EXCLUDE_CHOICES = {}


def is_table_line(s, pos):
    """pos が Markdown表の行（| で始まる行）の中にあるか。

    表のセル内の空白は意図的な区切りであることがある
    （2014A-77 の「B社 戦略b1」、2017A-04 の「…のとき モータL」）。
    """
    line_start = s.rfind("\n", 0, pos) + 1
    return s[line_start:].lstrip().startswith("|")


def fix_text(s, skip_tables=True):
    """置換後の文字列と、詰めた箇所数・飛ばした箇所数を返す。"""
    out = []
    last = 0
    fixed = skipped = 0
    for m in PAT.finditer(s):
        if skip_tables and is_table_line(s, m.start()):
            skipped += 1
            continue
        out.append(s[last:m.start()])
        last = m.end()
        fixed += 1
    out.append(s[last:])
    return "".join(out), fixed, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="置換を実行して保存する")
    a = ap.parse_args()

    D = json.load(open(Q))
    total_fixed = total_skipped_tbl = total_skipped_exc = 0
    touched = set()
    samples = []

    for q in D:
        qid = q["id"]
        for field in ("question", "explanation"):
            s = q.get(field)
            if not isinstance(s, str) or not s:
                continue
            new, fixed, skipped = fix_text(s)
            total_skipped_tbl += skipped
            if fixed:
                total_fixed += fixed
                touched.add(qid)
                if len(samples) < 20:
                    m = PAT.search(s)
                    samples.append((qid, field, s[max(0, m.start() - 20):m.start() + 21]))
                q[field] = new

        if qid in EXCLUDE_CHOICES:
            total_skipped_exc += sum(len(PAT.findall(str(c))) for c in q["choices"])
            continue

        for i, c in enumerate(q["choices"]):
            s = str(c)
            new, fixed, skipped = fix_text(s)
            total_skipped_tbl += skipped
            if fixed:
                total_fixed += fixed
                touched.add(qid)
                if len(samples) < 20:
                    m = PAT.search(s)
                    samples.append((qid, f"choices[{i}]", s[max(0, m.start() - 20):m.start() + 21]))
                q["choices"][i] = new

    print(f"詰める空白: {total_fixed}箇所 / {len(touched)}問")
    exc = f"値の並び {total_skipped_exc}箇所（{', '.join(EXCLUDE_CHOICES)}）" if EXCLUDE_CHOICES else "値の並び 0箇所"
    print(f"除外: Markdown表の行 {total_skipped_tbl}箇所 ／ {exc}")

    if samples:
        print("\n差分サンプル（前後20字。␣ が詰める空白）:")
        for qid, field, frag in samples:
            print(f"  {qid:<9} {field:<12} {frag}".replace("\n", " "))

    if a.apply:
        json.dump(D, open(Q, "w"), ensure_ascii=False, separators=(",", ":"))
        print(f"\n書き込み: {Q}")
    else:
        print("\n（dry-run。実行するには --apply）")


if __name__ == "__main__":
    main()
