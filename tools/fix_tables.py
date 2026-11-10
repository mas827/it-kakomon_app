#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""questions.json の壊れたMarkdown表を、アプリが描画できる形に整形する。

アプリの表描画には「ヘッダ行 + |---|区切り行」が必須（fe-study-app.jsx の
parseTableBlock / isTableSep）。素データは本文にあるのに区切り行や先頭の | が
無いために、プレーンテキストとして化けている問題を一括で直す。

  tools/fix_tables.py            対象を一覧表示するだけ（既定・安全）
  tools/fix_tables.py --apply    実際に書き換える
  tools/fix_tables.py --id X     特定の問題だけ

BNF（<式> ::= A | B）は表ではないので対象外。
"""
import argparse, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")


def renderable(t):
    ls = t.split("\n")
    return any(re.match(r"^\s*\|.*\|\s*$", ls[i]) and
               re.match(r"^\s*\|(\s*:?-+:?\s*\|)+\s*$", ls[i + 1])
               for i in range(len(ls) - 1))


def is_bnf(t):
    return "::=" in t or "BNF" in t or "<" in t


def cells(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def reformat(text):
    """連続する「|を含む行」のかたまりを、正しいMarkdown表に整形する。"""
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if "|" in lines[i]:
            j = i
            while j < len(lines) and "|" in lines[j]:
                j += 1
            rows = [cells(l) for l in lines[i:j]]
            n = max(len(r) for r in rows)
            rows = [r + [""] * (n - len(r)) for r in rows]
            fmt = lambda r: "| " + " | ".join(r) + " |"
            out.append(fmt(rows[0]))
            out.append("| " + " | ".join(["---"] * n) + " |")
            out += [fmt(r) for r in rows[1:]]
            i = j
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="実際に書き換える")
    ap.add_argument("--id", help="特定の問題IDだけ")
    a = ap.parse_args()

    D = json.load(open(Q))
    targets = []
    for q in D:
        if a.id and q["id"] != a.id:
            continue
        t = q["question"]
        if t.count("|") >= 3 and not renderable(t) and not is_bnf(t):
            targets.append(q)

    if not targets:
        print("整形が必要な表はありません")
        return

    print(f"対象 {len(targets)}件")
    for q in targets:
        print(f"  {q['id']} [{q['set']}] {q['question'][:40].replace(chr(10), ' ')}")
        if a.apply:
            q["question"] = reformat(q["question"])

    if a.apply:
        json.dump(D, open(Q, "w"), ensure_ascii=False, separators=(",", ":"))
        bad = [q["id"] for q in targets if not renderable(q["question"])]
        print("書き換えました" if not bad else f"整形できなかった: {bad}")
        print("→ tools/validate.py で確認してください")
    else:
        print("（--apply を付けると書き換えます）")


if __name__ == "__main__":
    main()
