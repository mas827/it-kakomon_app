#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""questions.json / abbr.json / kamokub*.json の不変条件をまとめて検査する。

問題が無ければ数行だけ出力する。データを変更したら必ず実行すること。

  tools/validate.py          通常検査（高速）
  tools/validate.py --deep   画像もOCRして「ア〜エの選択肢表が焼き込まれた図」を検出（低速）
  tools/validate.py --source 科目Bを原本テキスト（kamokub_work/extracted）と突き合わせて転記ミスを探す

科目B（data/kamokub*.json）も同じ実行で検査する（下の「科目B」節）。
"""
import argparse, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_categories import find_mismatches  # 重複問題のcategory不一致検出を共用する

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(ROOT, "data", "questions.json")
A = os.path.join(ROOT, "data", "abbr.json")
KEYS = os.path.join(ROOT, "data", "answer_keys.json")
CALC_IDS = os.path.join(ROOT, "data", "calc_ids.json")
LOG = os.path.join(ROOT, "fix_log.md")
IMGDIR = os.path.join(ROOT, "images")
OCR = os.path.join(ROOT, "tools", "ocr")

CATS = {"アルゴリズム", "データベース", "セキュリティ", "基礎理論", "マネジメント",
        "ネットワーク", "ストラテジ", "コンピュータ構成", "ソフトウェア"}
ABBR_CATS = {"基礎理論", "コンピュータシステム", "開発技術", "プロジェクトマネジメント",
             "サービスマネジメント", "システム戦略", "経営戦略", "企業と法務",
             "ネットワーク", "セキュリティ"}
LET = "アイウエ"
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
FOREIGN = re.compile(r"[Ѐ-ӿ가-힯]")


def renderable_table(t):
    """アプリが表として描画できるか（ヘッダ行＋|---|区切りが必須）。"""
    ls = t.split("\n")
    return any(re.match(r"^\s*\|.*\|\s*$", ls[i]) and
               re.match(r"^\s*\|(\s*:?-+:?\s*\|)+\s*$", ls[i + 1])
               for i in range(len(ls) - 1))


def is_placeholder(q):
    return all(str(c).strip() == LET[i] for i, c in enumerate(q["choices"]))


def has_letter_row_table(t):
    """問題文の表の行ラベルが ア/イ/ウ/エ になっているか（3行以上）。"""
    return len({m.group(1) for m in re.finditer(r"^\s*\|\s*([アイウエ])\s*\|", t, re.M)}) >= 3


CHOICE_BLOCK = re.compile(r"^([アイウエ])(?:[．.、，]|は|が|の|に|について)")
LETTER_REF = re.compile(r"(?<![0-9A-Za-z])([a-d])(?![0-9A-Za-z])")


def letter_mapping_blocks(q):
    """「表(図)のa〜dのどれに該当するか」型の解説なら (lead, [(letter, block), ...]) を返す。

    判定は fe-study-app.jsx の isLetterMapping と同じ条件にしてある
    （記号つきブロックが3つ以上／どれも a〜d をちょうど1つずつ重複なく参照する）。
    ズレるとアプリの並べ替えとデータの並びが食い違うので、両方を同じ規則で見ること。
    """
    blocks = q["explanation"].split("\n")
    labeled = [(k, b) for k, b in enumerate(blocks) if CHOICE_BLOCK.match(b)]
    if len(labeled) < 3:
        return None
    first = labeled[0][0]
    if any(k < first for k, _ in labeled):
        return None
    refs = []
    for _, b in labeled:
        m = LETTER_REF.search(b)
        if not m:
            return None
        refs.append(m.group(1))
    if len(set(refs)) != len(refs):
        return None
    return blocks[:first], list(zip(refs, [b for _, b in labeled]))


def _dup_norm(s):
    # 本文と選択肢で区切り記号の書式が違う（`:` と `( )` 等）ので、約物ごと落として比べる
    return re.sub(r"[\s　()（）。、,，:：]", "", str(s))


def duplicated_choices(q):
    """選択肢と同じ内容が問題文中にも並んでいる件数。"""
    body = _dup_norm(q["question"])
    if not body:
        return 0
    return sum(1 for c in q["choices"]
               if len(_dup_norm(c)) >= 6 and _dup_norm(c) in body)


# ===== 科目B（data/kamokub.json / kamokub_programs.json） =====
# 旧 tools/validate_b.py の検査をそのまま移した（2026-11 科目B統合 Phase 4）。
# --source は kamokub_work/extracted の原本テキストと突き合わせて転記ミスを探す。
KB_Q = os.path.join(ROOT, "data", "kamokub.json")
KB_P = os.path.join(ROOT, "data", "kamokub_programs.json")
KB_KEYS = os.path.join(ROOT, "data", "kamokub_answer_keys.json")
EXTRACTED = os.path.join(ROOT, "kamokub_work", "extracted")

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


def check_kamokub(errs, warns, source=False):
    """科目Bを検査して errs / warns に積む。(問題数, プログラム数) を返す。"""
    D = json.load(open(KB_Q))
    PR = json.load(open(KB_P))
    keys = json.load(open(KB_KEYS)) if os.path.exists(KB_KEYS) else {}
    root_ids = {q["id"] for q in json.load(open(Q))} if os.path.exists(Q) else set()

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

        if source:
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

    return len(D), len(PR)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="画像もOCRして検査(低速)")
    ap.add_argument("--source", action="store_true",
                    help="科目Bを kamokub_work/extracted の原本テキストと突き合わせて転記ミスを探す")
    a = ap.parse_args()

    D = json.load(open(Q))
    errs = []
    warns = []

    for q in D:
        i = q["id"]
        if len(q["choices"]) != 4:
            errs.append(f"{i}: choicesが4件でない")
        if not (isinstance(q["answer"], int) and 0 <= q["answer"] <= 3):
            errs.append(f"{i}: answerが0-3でない")
        if q["category"] not in CATS:
            errs.append(f"{i}: 未知のcategory {q['category']}")
        if q.get("image") and not os.path.exists(os.path.join(ROOT, q["image"])):
            errs.append(f"{i}: 画像が無い {q['image']}")
        if not str(q.get("question", "")).strip():
            errs.append(f"{i}: 問題文が空")

        blob = q["question"] + q.get("explanation", "") + "".join(map(str, q["choices"]))
        if CTRL.search(blob):
            errs.append(f"{i}: 制御文字が混入")
        if FOREIGN.search(blob):
            errs.append(f"{i}: キリル文字/ハングルが混入")

        # 選択肢がア/イ/ウ/エだけなのに、内容が画像にも本文の表にも無い → 解答不能
        # (問題文の表に既にア〜エのラベルで内容が書かれているケースは表がその役目を果たす)
        t = q["question"]
        if is_placeholder(q) and not q.get("image") and not renderable_table(t):
            errs.append(f"{i}: 選択肢が記号のみで画像も表も無い(解答不能)")

        # 表が壊れている（|はあるが描画されない）。BNFの | は除外
        if t.count("|") >= 3 and not renderable_table(t) \
                and "::=" not in t and "BNF" not in t and "<" not in t:
            errs.append(f"{i}: Markdown表が壊れている(|---|区切りが無い)")

        # 表に言及しているのに表も画像も無い
        if (not q.get("image") and not renderable_table(t)
                and re.search(r"表(に示す|のとおり|の条件|に示した|のよう)", t)):
            warns.append(f"{i}: 表に言及しているが表も画像も無い")

        # 表の行ラベルがア〜エなのに選択肢が文章 → シャッフルで表とずれる
        if has_letter_row_table(t) and not is_placeholder(q):
            errs.append(f"{i}: 表の行ラベルがア〜エなのにchoicesが記号のみでない"
                        f"(シャッフルで表とずれる) → choicesを[\"ア\",\"イ\",\"ウ\",\"エ\"]にする")

        # 選択肢と同じ内容が問題文中にも並んでいる → シャッフルで本文のラベルとずれる
        if not is_placeholder(q) and duplicated_choices(q) >= 3:
            warns.append(f"{i}: 選択肢が問題文中にも二重掲載されている(本文側の重複リストを削除する)")

        # 「表(図)のa〜dのどれに該当するか」型の解説。アプリは a→b→c→d の昇順に
        # 並べ替えて出題する（正解を先頭に持ち上げない）ので、次の2点を保つ必要がある。
        m = letter_mapping_blocks(q)
        if m:
            lead, pairs = m
            refs = [r for r, _ in pairs]
            # (1) データ側も昇順にしておく。QuestionDetail(問題一覧・模試の見直し)は
            #     シャッフルしないので素の順で表示され、揃っていないと画面間で食い違う
            if refs != sorted(refs):
                warns.append(f"{i}: a〜d対応の解説がデータ上で昇順でない({','.join(refs)}) "
                             f"→ 出題画面とQuestionDetailで読み順が食い違う")
            # (2) 正解の解説は本文(lead)に置く。記号つきブロックに入れると昇順の
            #     途中や末尾に埋もれて「正解が一番上」が崩れる
            ans_label = LET[q["answer"]]
            if any(CHOICE_BLOCK.match(b).group(1) == ans_label for _, b in pairs):
                warns.append(f"{i}: a〜d対応の解説で正解({ans_label})の説明が選択肢ブロック側にある "
                             f"→ 昇順に並べると埋もれるので本文(先頭ブロック)に移す")

    # 重複問題(IPAの再出題)どうしでcategoryが食い違っていないか
    # (キーワードによる一次判定は tools/check_categories.py 側にのみ持たせる。ここでは検出のみ)
    for dup_a, dup_b in find_mismatches(D):
        warns.append(f"{dup_a['id']}({dup_a['category']}) <-> {dup_b['id']}({dup_b['category']}): "
                     f"重複問題のcategoryが不一致 → tools/check_categories.py で確認")

    # 孤児画像
    refs = {q["image"].split("/")[-1] for q in D if q.get("image")}
    # 科目Bの図（data/kamokub.json の figures）も同じ images/ に置く。中身の検査は下の check_kamokub
    KB = json.load(open(KB_Q, encoding="utf-8")) if os.path.exists(KB_Q) else []
    refs |= {f["file"].split("/")[-1] for q in KB for f in q.get("figures", [])}
    orphans = sorted(f for f in os.listdir(IMGDIR)
                     if f.endswith(".png") and f not in refs)
    if orphans:
        warns.append(f"参照されていない画像: {', '.join(orphans)}")

    # 解答キーとの照合
    key_checked = 0
    if os.path.exists(KEYS):
        K = json.load(open(KEYS))["keys"]
        byid = {q["id"]: q for q in D}
        for pref, info in K.items():
            for n, real in enumerate(info["answers"], 1):
                q = byid.get(f"{pref}-{n:02d}")
                if not q:
                    continue
                key_checked += 1
                if LET[q["answer"]] != real:
                    errs.append(f"{q['id']}: 解答が公式と不一致 "
                                f"(現在={LET[q['answer']]} 公式={real})")

    # 英略語
    AB = json.load(open(A))
    if len({x["id"] for x in AB}) != len(AB):
        errs.append("abbr.json: idが重複")
    if len({x["abbr"] for x in AB}) != len(AB):
        errs.append("abbr.json: 略語が重複")
    for x in AB:
        for f in ("id", "abbr", "kana", "freq", "category", "full", "meaning"):
            if x.get(f) in (None, ""):
                errs.append(f"abbr {x.get('id', x.get('abbr', '?'))}: {f} が空")
        if x.get("category") not in ABBR_CATS:
            errs.append(f"abbr {x.get('id')}: 未知のcategory {x.get('category')}")
        if x.get("freq") not in (1, 2, 3):
            errs.append(f"abbr {x.get('id')}: freqが1-3でない ({x.get('freq')})")

    # sw.js の画像リストが images/ の実体とズレていないか（ズレたらオフラインで図が出ない）
    sync = os.path.join(ROOT, "tools", "sync_sw_images.py")
    if os.path.exists(sync):
        r = subprocess.run([sys.executable, sync, "--check"], capture_output=True, text=True)
        if r.returncode != 0:
            warns.append("sw.jsの画像リストがimages/とズレている → python3 tools/sync_sw_images.py")

    # 計算問題フィルタ（data/calc_ids.json）が mark_calc.py の判定結果とズレていないか
    mark_calc = os.path.join(ROOT, "tools", "mark_calc.py")
    if os.path.exists(mark_calc) and os.path.exists(CALC_IDS):
        r = subprocess.run([sys.executable, mark_calc, "--check"], capture_output=True, text=True)
        if r.returncode != 0:
            warns.append("data/calc_ids.jsonがmark_calc.pyの判定結果とズレている "
                        "→ python3 tools/mark_calc.py --apply")

    # 修正ログ（fix_log.md）が実データとずれていないか
    # 見出し「### 2013A-18（...）— ...」から、/ 区切りの複数IDも含めて拾う
    log_ids = 0
    if os.path.exists(LOG):
        known = {q["id"] for q in D} | {f"A-{x['id']}" for x in AB} | {q["id"] for q in KB}
        for ln in open(LOG):
            if not ln.startswith("### "):
                continue
            head = re.split(r"[—(（]", ln[4:])[0]
            # 科目B（B-R05-01 / B-SAMPLE-09）は先に丸ごと拾う。でないと R05-01 だけが拾われる
            for i in re.findall(r"B-(?:R\d+|SAMPLE)-\d+|A-\d+|[0-9A-Z]+-\d+", head):
                log_ids += 1
                if i not in known:
                    errs.append(f"fix_log.md: 存在しないID {i}")

    # --deep: ア〜エの選択肢表が焼き込まれた画像の検出
    if a.deep:
        if not os.path.exists(OCR):
            warns.append("tools/ocr が未ビルド(swiftc -O tools/ocr.swift -o tools/ocr)")
        else:
            for q in D:
                if not q.get("image") or is_placeholder(q):
                    continue  # 選択肢が図の問題は焼き込みが正しい
                p = os.path.join(ROOT, q["image"])
                out = subprocess.run([OCR, p], capture_output=True, text=True).stdout
                heads = set()
                for ln in out.splitlines():
                    m = re.match(r"^\s*([アイウエ])(\s|$|[．.、])", ln)
                    if m:
                        heads.add(m.group(1))
                if len(heads) >= 3:
                    errs.append(f"{q['id']}: 図にア〜エの選択肢表が焼き込まれている"
                                f"(選択肢はテキスト) → figcrop --exclude-choices で再抽出")

    kb_q, kb_p = check_kamokub(errs, warns, a.source)

    print(f"問題数 {len(D)} / 画像 {sum(1 for q in D if q.get('image'))} / "
          f"英略語 {len(AB)} / 解答照合 {key_checked}問 / 修正ログ {log_ids}件 / "
          f"科目B {kb_q}問・プログラム{kb_p}件" + ("（原本照合あり）" if a.source else ""))
    for w in warns:
        print("  [warn]", w)
    if errs:
        print(f"NG: {len(errs)}件")
        for e in errs:
            print("  -", e)
        sys.exit(1)
    print("OK: エラーなし")


if __name__ == "__main__":
    main()
