#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""科目Bのデータ（kamokub.json / kamokub_programs.json）の不変条件を検査する。

問題が無ければ数行だけ出力する。データを変更したら必ず実行すること。

  tools/validate_b.py
  tools/validate_b.py --source   抽出テキストと突き合わせて転記ミスを探す
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                  # リポジトリのルート
BROOT = os.path.join(ROOT, "subject-b")       # 抽出テキスト extracted/ の置き場所（Phase 4 で見直す）
Q = os.path.join(ROOT, "data", "kamokub.json")
P = os.path.join(ROOT, "data", "kamokub_programs.json")
KEYS = os.path.join(ROOT, "data", "kamokub_answer_keys.json")
ROOT_Q = os.path.join(ROOT, "data", "questions.json")
EXTRACTED = os.path.join(BROOT, "extracted")

LABELS = "アイウエオカキクケコ"
FIELDS = {"アルゴリズム", "セキュリティ"}
TOPICS = {
    # アルゴリズム系
    "変数と代入", "条件分岐", "繰返し", "配列", "二次元配列", "文字列", "リスト",
    "スタック・キュー", "木構造", "グラフ", "探索", "整列", "再帰", "計算量",
    "オブジェクト指向", "ビット演算", "数値計算", "手続・関数呼出し",
    # セキュリティ系
    "情報セキュリティ管理", "アクセス制御・認証", "攻撃手法", "マルウェア対策",
    "暗号・電子署名", "インシデント対応", "監査",
}
CELL_TYPES = {"int", "real", "bool", "string", "array", "object", "output", "note"}

OPEN = {"if": "endif", "while": "endwhile", "for": "endfor", "do": "dowhile"}
CLOSE = {v: k for k, v in OPEN.items()}
MIDDLE = {"elseif", "else"}
KINDS = set(OPEN) | set(CLOSE) | MIDDLE | {
    "proc", "global", "decl", "assign", "call", "break", "return", "stmt", "comment", "blank"}

BLANK = re.compile(r"\[\[([^\]]*)\]\]")
FIG = re.compile(r"^fig:(.+)$")


def blanks_in(text):
    """[[a]] のような空欄名を出現順に返す。[[fig:1]] は図の差込みなので除く。"""
    return [m.group(1).strip() for m in BLANK.finditer(text or "") if not FIG.match(m.group(1).strip())]


def figs_in(text):
    out = []
    for m in BLANK.finditer(text or ""):
        fm = FIG.match(m.group(1).strip())
        if fm:
            out.append(fm.group(1))
    return out


# ===== 抽出テキストとの突き合わせ（--source） =====
SPACE_RE = re.compile(r"[\s\u3000]+")
DROP_RE = re.compile(r"\[\[[^\]]*\]\]")


def squash(t):
    """空白を落として比べられる形にする。"""
    return SPACE_RE.sub("", str(t))


def load_source(qid):
    """原本の抽出テキストを「空白を落とした行の並び」で返す。"""
    m = re.match(r"^B-([A-Z0-9]+)-(\d+)$", qid)
    if not m:
        return None
    path = os.path.join(EXTRACTED, f"{m.group(1)}-{m.group(2)}.txt")
    if not os.path.exists(path):
        return None
    return [squash(l) for l in open(path).read().split("\n") if squash(l)]


def found_in(text, lines):
    """text が原本に出てくるか。

    空欄 [[a]] はどんな字が入ってもよいものとして扱う。
    選択肢は PDF 上で折り返され、途中に他の列の文字が割り込むことがある
    （「…の正の / 平方根」のように）。そこで「行をまたぐ場合は、
    前の行の末尾＋次の行の先頭」という形に限って通す。
    こうしておけば、途中の字を書き間違えた場合はちゃんと引っ掛かる。
    """
    def rest(t, depth):
        """t を「行まるごと」で食べ進め、最後は行の先頭に一致すればよい。"""
        if depth > 6:
            return False
        if any(L.startswith(t) for L in lines):
            return True
        for L in lines:
            if L and t.startswith(L) and rest(t[len(L):], depth + 1):
                return True
        return False

    def one(t):
        if not t:
            return True
        if any(t in L for L in lines):
            return True
        # 行をまたぐ場合。切れ目は必ず行の端に来るので、
        # 「どこかの行の末尾」＋「行まるごと…」＋「どこかの行の先頭」の形に限って通す
        for cut in range(1, len(t)):
            if any(L.endswith(t[:cut]) for L in lines) and rest(t[cut:], 1):
                return True
        return False

    return all(one(squash(frag)) for frag in DROP_RE.split(str(text)))


def check_source(q, prog, warns):
    """choices と プログラムの各行が、原本の抽出テキストに出てくるかを見る。

    出てこなければ転記ミスの疑い。数式（$…$）を含むものは形が変わるので飛ばす。
    """
    lines = load_source(q["id"])
    if lines is None:
        warns.append(f"{q['id']}: 抽出テキストが無いので突き合わせできない")
        return
    targets = []
    for i, c in enumerate(q.get("choices") or []):
        for part in (c if isinstance(c, list) else [c]):
            targets.append((f"choices[{i}]", part))
    for l in (prog or {}).get("lines", []):
        if l["kind"] != "blank":
            targets.append((f"program n={l['n']}", l["text"]))
    # 問題文のうち、配列リテラルのような「書き写したもの」も突き合わせる。
    # 本文の言い回しは折り返しで形が変わるので対象にしないが、{…} は原本のままのはず。
    q_text = re.sub(r"\$[^$]*\$", "", q.get("question", ""))          # 数式は除く
    q_text = re.sub(r"^\|.*$", "", q_text, flags=re.M)                # Markdown表の行は除く
    for lit in re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", q_text):
        if len(squash(lit)) >= 6:
            targets.append(("question の配列リテラル", lit))
    for where, text in targets:
        if "$" in str(text):
            continue
        if squash(DROP_RE.sub("", str(text))) and not found_in(text, lines):
            warns.append(f"{q['id']}: {where} が原本に見当たらない → 転記ミスの疑い「{str(text)[:40]}」")


def check_program(pid, prog, errs):
    lines = prog.get("lines") or []
    if not lines:
        errs.append(f"{pid}: lines が空")
        return
    ns = [l["n"] for l in lines]
    if ns != list(range(1, len(ns) + 1)):
        errs.append(f"{pid}: lines の n が 1 からの連番になっていない")
    for l in lines:
        if l["kind"] not in KINDS:
            errs.append(f"{pid}: 未知の kind {l['kind']}（n={l['n']}）")
        if l["indent"] < 0:
            errs.append(f"{pid}: indent が負（n={l['n']}）")

    body = [l for l in lines if l["kind"] != "blank"]
    if body and body[0]["indent"] != 0:
        errs.append(f"{pid}: 最初の行の indent が 0 でない")

    stack = []        # [(kind, indent, n)]
    loops = 0
    for l in body:
        k, ind, n = l["kind"], l["indent"], l["n"]
        if k in CLOSE:
            want = CLOSE[k]
            if not stack or stack[-1][0] != want:
                errs.append(f"{pid}: {k} に対応する {want} が無い（n={n}）")
            else:
                _, oind, on = stack.pop()
                if ind != oind:
                    errs.append(f"{pid}: {k}(n={n}) の indent が開始行(n={on})と揃っていない")
                if want in ("while", "for", "do"):
                    loops -= 1
            continue
        if k in MIDDLE:
            if not stack or stack[-1][0] != "if":
                errs.append(f"{pid}: {k} が if の中にない（n={n}）")
            elif ind != stack[-1][1]:
                errs.append(f"{pid}: {k}(n={n}) の indent が if と揃っていない")
            continue
        if k == "break" and loops == 0:
            errs.append(f"{pid}: 繰返しの外に break がある（n={n}）")
        if stack and ind < stack[-1][1] + 1:
            errs.append(f"{pid}: n={n} の indent がブロックの内側になっていない")
        if k in OPEN:
            stack.append((k, ind, n))
            if k in ("while", "for", "do"):
                loops += 1
    for k, _, n in stack:
        errs.append(f"{pid}: {k}(n={n}) が {OPEN[k]} で閉じられていない")

    tr = prog.get("trace")
    if tr is None:
        return
    cols = tr.get("columns") or []
    if not cols:
        errs.append(f"{pid}: trace.columns が空")
    keys = [c["key"] for c in cols]
    if len(keys) != len(set(keys)):
        errs.append(f"{pid}: trace.columns の key が重複している")
    for c in cols:
        if c.get("type") not in CELL_TYPES:
            errs.append(f"{pid}: 未知の列の型 {c.get('type')}（{c.get('key')}）")
        if c.get("type") == "array" and "size" not in c:
            errs.append(f"{pid}: array 列 {c['key']} に size が無い")

    valid = set()
    for c in cols:
        if c.get("type") == "array" and c.get("size", 0) <= 8:
            base = c.get("base", 1)
            valid.update(f"{c['key']}[{base + i}]" for i in range(c["size"]))
        else:
            valid.add(c["key"])

    def check_values(where, values):
        for k in values:
            if k not in valid:
                errs.append(f"{pid}: {where} の列 {k} が columns に無い")

    init = tr.get("initial")
    if init:
        if init.get("step") not in ns:
            errs.append(f"{pid}: trace.initial の step {init.get('step')} が行番号に無い")
        check_values("trace.initial", init.get("values") or {})
    for i, row in enumerate(tr.get("expected") or []):
        if row.get("ellipsis"):
            continue
        if row.get("step") not in ns:
            errs.append(f"{pid}: expected[{i}] の step {row.get('step')} が行番号に無い")
        check_values(f"expected[{i}]", row.get("values") or {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", action="store_true",
                    help="subject-b/extracted の原本テキストと突き合わせて転記ミスを探す")
    args = ap.parse_args()

    D = json.load(open(Q))
    PR = json.load(open(P))
    keys = json.load(open(KEYS)) if os.path.exists(KEYS) else {}
    root_ids = {q["id"] for q in json.load(open(ROOT_Q))} if os.path.exists(ROOT_Q) else set()

    errs, warns = [], []
    seen = set()

    for q in D:
        i = q["id"]
        if i in seen:
            errs.append(f"{i}: id が重複している")
        seen.add(i)
        if i in root_ids:
            errs.append(f"{i}: 科目Aの id と衝突している")
        if q.get("field") not in FIELDS:
            errs.append(f"{i}: 未知の field {q.get('field')}")
        for t in q.get("topics") or []:
            if t not in TOPICS:
                errs.append(f"{i}: 未知の topic {t}")
        if not q.get("topics"):
            errs.append(f"{i}: topics が空")
        if not q.get("source"):
            errs.append(f"{i}: source が無い")
        if not q.get("explanation"):
            errs.append(f"{i}: explanation が無い")

        ch = q.get("choices") or []
        if not (4 <= len(ch) <= len(LABELS)):
            errs.append(f"{i}: choices が {len(ch)} 件（4〜{len(LABELS)} のはず）")
        a = q.get("answer")
        if not (isinstance(a, int) and 0 <= a < len(ch)):
            errs.append(f"{i}: answer が choices の範囲外")
        cols = q.get("choiceCols")
        if cols:
            for k, c in enumerate(ch):
                if not isinstance(c, list):
                    errs.append(f"{i}: choices[{k}] が配列でない（choiceCols があるとき）")
                elif len(c) != len(cols):
                    errs.append(f"{i}: choices[{k}] の列数が choiceCols と合わない")
        else:
            for k, c in enumerate(ch):
                if not isinstance(c, str):
                    errs.append(f"{i}: choices[{k}] が文字列でない（choiceCols が無いとき）")

        prog = None
        pid = q.get("programId")
        if pid:
            prog = PR.get(pid)
            if prog is None:
                errs.append(f"{i}: programId {pid} が programs に無い")
        elif q.get("field") == "アルゴリズム" and "プログラム" in q.get("question", ""):
            # 擬似言語を伴わないアルゴリズム問題（木の評価など）もあるので、
            # 問題文がプログラムに言及しているときだけ知らせる
            warns.append(f"{i}: アルゴリズム問題だが programId が無い")

        # 空欄と choiceCols の整合（空欄は問題文とプログラムの両方に現れ得る）
        text = q.get("question", "")
        if prog:
            text += "\n" + "\n".join(l["text"] for l in prog["lines"])
        bl = sorted(set(blanks_in(text)))
        if cols:
            # 空欄が名前付きで置かれているときだけ、列名と対応しているか見る。
            # 図の項番など、空欄ではないものを列の見出しにしている問題もある
            named = [b for b in bl if b]
            if named and named != sorted(cols):
                errs.append(f"{i}: 空欄 {named} と choiceCols {sorted(cols)} が一致しない")
        else:
            if len(bl) > 1:
                errs.append(f"{i}: 空欄が複数 {bl} あるのに choiceCols が無い")

        # 図
        figs = {f["key"]: f for f in q.get("figures") or []}
        used = figs_in(q.get("question", ""))
        for k in used:
            if k not in figs:
                errs.append(f"{i}: [[fig:{k}]] に対応する figures が無い")
        for k, f in figs.items():
            if k not in used:
                warns.append(f"{i}: figures の {k} が問題文から参照されていない")
            if not os.path.exists(os.path.join(ROOT, f["file"])):
                errs.append(f"{i}: 画像が無い {f['file']}")

        if args.source:
            check_source(q, prog, warns)

        # 解答例との突き合わせ
        if i in keys:
            want = LABELS.index(keys[i])
            if a != want:
                errs.append(f"{i}: answer が解答例と違う（解答例 {keys[i]} = {want}, データ {a}）")
        else:
            warns.append(f"{i}: 解答例に無い id")

    used_pids = {q.get("programId") for q in D}
    for pid, prog in PR.items():
        if pid not in used_pids:
            warns.append(f"{pid}: どの問題からも参照されていない")
        check_program(pid, prog, errs)

    for w in warns:
        print("警告:", w)
    for e in errs:
        print("エラー:", e)
    print(f"\n問題 {len(D)}件 / プログラム {len(PR)}件 — エラー {len(errs)}件, 警告 {len(warns)}件")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
