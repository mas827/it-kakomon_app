#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""科目BのPDFから問題JSONの下書きを起こす。

pdftotext -bbox-layout の「語＋座標」を使う。座標があると次のことが機械的に分かる。

  - 上付き・下付き … 周りの語より背が低く、上下にずれている（x2 が本当は x² だと分かる）
  - 空欄の位置   … 語と語の間の大きな隙間。ラベル(a,b,c)は本文と別の y に置かれている
  - 組合せの列   … 解答群の見出し a / b / c の x 位置と、各行の語間の隙間で列に割れる

出力は subject-b/drafts/{SET}-{NN}.json（作業用の下書き）。
topics / figures / trace / explanation / traceExplanation は空なので、人が埋める。
下書きの "_review" に「原本を見て確かめるべき箇所」が並ぶので、そこだけ確認する。

  tools/b_scaffold.py --set R06           セット全問
  tools/b_scaffold.py --set R06 --q 1     1問だけ（標準出力にも出す）
"""
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BROOT = os.path.join(ROOT, "subject-b")   # 作業用の drafts/ の置き場所（Phase 4 で見直す）
PDFDIR = os.path.join(ROOT, "pdf", "SubjectB")
OUTDIR = os.path.join(BROOT, "drafts")
KEYS = os.path.join(ROOT, "data", "kamokub_answer_keys.json")

# セット名 → (問題冊子PDF, アプリ上の set 表記, 出典の言い方)
SETS = {
    "SAMPLE": ("fe_kamoku_b_set_sample_qs.pdf", "サンプル問題", "IPA 基本情報技術者試験 科目B サンプル問題"),
    "R05": ("2023r05_fe_kamoku_b_qs.pdf", "令和5年度 公開問題", "IPA 令和5年度 基本情報技術者試験 科目B 公開問題"),
    "R06": ("2024r06_fe_kamoku_b_qs.pdf", "令和6年度 公開問題", "IPA 令和6年度 基本情報技術者試験 科目B 公開問題"),
    "R07": ("2025r07_fe_kamoku_b_qs.pdf", "令和7年度 公開問題", "IPA 令和7年度 基本情報技術者試験 科目B 公開問題"),
    "R08": ("2026r08_fe_kamoku_b_qs.pdf", "令和8年度 公開問題", "IPA 令和8年度 基本情報技術者試験 科目B 公開問題"),
}

LABELS = "アイウエオカキクケコ"
ZEN = str.maketrans("０１２３４５６７８９", "0123456789")

PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
WORD_RE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', re.S)

SPACE_GAP = 2.5     # これより広い隙間は空白1つとみなす
# 空欄の隙間は実測で 25〜29pt。本文中にふつうに出てくる 1文字の変数（pow(a, b) の a など）は
# 前後 5pt 以下しか空かないので、18pt を境にすれば取り違えない。
BLANK_GAP = 18.0
LINE_TOL = 7.0      # 行の中心がこの範囲にあれば同じ行

ENT = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'"}


def unescape(s):
    for k, v in ENT.items():
        s = s.replace(k, v)
    return s


class Word:
    __slots__ = ("x0", "y0", "x1", "y1", "t", "page")

    def __init__(self, x0, y0, x1, y1, t, page):
        self.x0, self.y0, self.x1, self.y1, self.t, self.page = x0, y0, x1, y1, t, page

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    def __repr__(self):
        return f"<{self.t!r} p{self.page} x{self.x0:.0f} y{self.y0:.0f}>"


def read_words(pdf):
    r = subprocess.run(["pdftotext", "-bbox-layout", pdf, "-"], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"pdftotext に失敗しました: {pdf}\n{r.stderr}")
    out = []
    chunks = PAGE_RE.split(r.stdout)
    for i in range(1, len(chunks), 3):
        page = (i - 1) // 3 + 1
        for m in WORD_RE.finditer(chunks[i + 2]):
            t = unescape(m.group(5))
            if not t.strip():
                continue
            out.append(Word(float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), t, page))
    return out


def group_lines(words):
    """語を行にまとめる。上付き・下付きも同じ行に入るよう中心のずれで判定する。"""
    lines = []
    for w in sorted(words, key=lambda w: (w.page, w.cy, w.x0)):
        if lines and lines[-1][0].page == w.page and abs(lines[-1][0].cy - w.cy) <= LINE_TOL:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ln in lines:
        ln.sort(key=lambda w: w.x0)
    return lines


def base_height(line):
    return max(w.h for w in line)


def script_kind(w, line):
    """上付きなら 'sup'、下付きなら 'sub'、ふつうの文字なら None。"""
    bh = base_height(line)
    if w.h > bh - 1.0:
        return None
    ys = sorted(x.y1 for x in line if x.h > bh - 1.0)
    if not ys:
        return None
    base_y1 = ys[len(ys) // 2]
    if w.y1 < base_y1 - 0.5:
        return "sup"
    if w.y0 > sorted(x.y0 for x in line if x.h > bh - 1.0)[len(ys) // 2] + 0.5:
        return "sub"
    return None


LABEL_RE = re.compile(r"[a-e]\d?")


def is_blank_label(line, idx):
    """line[idx] が空欄のラベル（a, b, c…）かどうか。

    ラベルは本文の一部ではなく、語と語の広い隙間に浮いている。
    その語を取り除いたとき、前後の語の間に空欄ぶんの隙間が残るかどうかで見分ける。
    （pow(a, b) の a のような、ふつうに本文に出てくる1文字と区別するため）
    """
    w = line[idx]
    if not LABEL_RE.fullmatch(w.t):
        return False
    prev = next((line[i] for i in range(idx - 1, -1, -1) if not LABEL_RE.fullmatch(line[i].t)), None)
    nxt = next((line[i] for i in range(idx + 1, len(line)) if not LABEL_RE.fullmatch(line[i].t)), None)
    if prev is None and nxt is None:
        # 行にラベルしか無い（例 〔プログラム〕の中の「      a      」）。行まるごとが空欄
        return True
    # 行頭・行中・行末のどこに来てもよい。隣り合う語との間が空欄ぶん空いていればラベル
    left_ok = prev is None or (w.x0 - prev.x1) >= BLANK_GAP
    right_ok = nxt is None or (nxt.x0 - w.x1) >= BLANK_GAP
    return left_ok and right_ok


def line_text(line, use_blanks=False, notes=None):
    """1行の語を連結して文字列にする。

    use_blanks=True なら、語間の大きな隙間を空欄 [[a]] に置き換える。
    上付き・下付きは $x^{2}$ の形にして、notes に「目視で確かめる」印を残す。
    """
    labels = {}
    content = []
    for i, w in enumerate(line):
        if use_blanks and is_blank_label(line, i):
            labels[(w.x0 + w.x1) / 2] = w.t
        else:
            content.append(w)

    def blank_at(x_from, x_to):
        for x, name in labels.items():
            if x_from - 2 <= x <= x_to + 2:
                return name
        return ""

    if not content and labels:
        # 行にラベルしか無い＝その行まるごとが空欄
        return " ".join(f"[[{n}]]" for _, n in sorted(labels.items()))

    parts = []
    prev = None
    # 行頭に置かれた空欄（例 「　a　の値を1増やす」）
    if content and labels:
        for x, name in sorted(labels.items()):
            if x < content[0].x0:
                parts.append(f"[[{name}]] ")
    for w in content:
        sk = script_kind(w, line)
        if sk and parts:
            base = parts[-1]
            head, tail = base[:-1], base[-1:]
            op = "^" if sk == "sup" else "_"
            parts[-1] = f"{head}${tail}{op}{{{w.t}}}$"
            if notes is not None:
                notes.append(f"上付き/下付きを検出: …{head[-8:]}{tail}{op}{w.t}… → 原本で確かめて $…$ に整えること")
            prev = w
            continue
        if prev is not None:
            gap = w.x0 - prev.x1
            if use_blanks and gap >= BLANK_GAP:
                parts.append(f" [[{blank_at(prev.x1, w.x0)}]] ")
            elif gap > SPACE_GAP:
                parts.append(" ")
        parts.append(w.t)
        prev = w
    # 行末に置かれた空欄（前の語より右にラベルがある場合）
    if prev is not None:
        for x, name in labels.items():
            if x > prev.x1:
                parts.append(f" [[{name}]]")
    return re.sub(r"\s+", " ", "".join(parts)).strip()


TAIL_RE = re.compile(r"^(〔メモ用紙〕|〔\s*メ\s*モ|試験問題に記載されている|©\s*\d{4}|なお，試験問題では)")


def find_problems(lines):
    """[(問番号, その問の行リスト)] を返す。"""
    starts = []
    for i, ln in enumerate(lines):
        m = re.match(r"^問\s*([0-9０-９]+)$", ln[0].t)
        if not m:
            continue
        n = int(m.group(1).translate(ZEN))
        if starts and n <= starts[-1][0]:
            continue
        if not starts and n != 1:
            continue
        starts.append((n, i))
    out = []
    for k, (n, i) in enumerate(starts):
        j = starts[k + 1][1] if k + 1 < len(starts) else len(lines)
        # 巻末の「メモ用紙」「商標について」「©…」は問題ではないので落とす
        for x in range(i, j):
            t = "".join(w.t for w in lines[x])
            if TAIL_RE.match(t):
                j = x
                break
        out.append((n, lines[i:j]))
    return out


def is_footer(line):
    t = "".join(w.t for w in line)
    return bool(re.match(r"^[－-]\s*\d+\s*[－-]$", t))


def split_columns(line, ncol):
    """1行の語を、隙間の広い順に ncol 個へ割る。組合せ問題の a / b / c に使う。"""
    if ncol <= 1 or len(line) < ncol:
        return [line]
    gaps = sorted(range(1, len(line)), key=lambda i: line[i].x0 - line[i - 1].x1, reverse=True)
    cuts = sorted(gaps[: ncol - 1])
    out, prev = [], 0
    for c in cuts:
        out.append(line[prev:c])
        prev = c
    out.append(line[prev:])
    return out


KIND_RULES = [
    (re.compile(r"^○"), "proc"),
    (re.compile(r"^大域\s*[:：]"), "global"),
    (re.compile(r"^/\*|^//"), "comment"),
    (re.compile(r"^if\s*\("), "if"),
    (re.compile(r"^elseif\s*\("), "elseif"),
    (re.compile(r"^else$"), "else"),
    (re.compile(r"^endif$"), "endif"),
    (re.compile(r"^while\s*\("), "while"),
    (re.compile(r"^endwhile$"), "endwhile"),
    (re.compile(r"^for\s*\("), "for"),
    (re.compile(r"^endfor$"), "endfor"),
    (re.compile(r"^do$"), "do"),
    (re.compile(r"^return\b"), "return"),
    (re.compile(r"繰返し処理を終了する$"), "break"),
]

OPENERS = {"if": "endif", "while": "endwhile", "for": "endfor", "do": "dowhile"}
CLOSERS = {v: k for k, v in OPENERS.items()}


def guess_kind(text, stack):
    t = text.strip()
    for rx, kind in KIND_RULES:
        if rx.search(t):
            # do ブロックを閉じる while (条件式) は dowhile
            if kind == "while" and stack and stack[-1][0] == "do":
                return "dowhile"
            return kind
    if not t:
        return "blank"
    if "←" in t:
        # 「型名: 変数 ← 初期値」は宣言
        return "decl" if re.match(r"^[^\s:：]+\s*[:：]\s*\S", t.split("←")[0]) else "assign"
    if re.match(r"^[^\s:：]*型[^\s:：]*\s*[:：]\s*\S", t) or re.match(r"^[A-Z]\w*\s*[:：]\s*\S", t):
        return "decl"
    if re.match(r"^[A-Za-z_][\w.]*\s*\(.*\)$", t):
        return "call"
    return "stmt"


def build_program(prog_lines, notes):
    """プログラムの行を作る。indent は空白数ではなくブロック構造から決める。"""
    out, stack, indent = [], [], 0
    n = 0
    for ln in prog_lines:
        if is_footer(ln):
            continue
        text = line_text(ln, use_blanks=True, notes=notes)
        if not text:
            continue
        # 行末に置かれた空欄はラベルが無いと座標から分からない。
        # 「← で終わる」「( で終わる」のように文が途切れていたら空欄とみなす
        if re.search(r"(←|＋|－|×|÷|,|，|\(|かつ|または|^return)$", text) or text.strip() == "return":
            text += " [[]]"
        n += 1
        kind = guess_kind(text, stack)

        if kind in CLOSERS or kind == "dowhile":
            want = "do" if kind == "dowhile" else CLOSERS[kind]
            if stack and stack[-1][0] == want:
                indent = stack.pop()[1]
            else:
                notes.append(f"{kind} に対応する開始行が見つからない（{n}行目）")
        elif kind in ("elseif", "else"):
            if stack and stack[-1][0] == "if":
                indent = stack[-1][1]
            else:
                notes.append(f"{kind} が if の中にない（{n}行目）")

        if kind in ("proc", "global"):
            # 手続の宣言と大域宣言は必ず最上位。2つ目以降の手続で字下げが残らないようにする
            indent = 0
            stack = []

        out.append({"n": n, "indent": indent, "kind": kind, "text": text})

        if kind == "proc":
            indent = 1
        elif kind in OPENERS:
            stack.append((kind, indent))
            indent += 1
        elif kind in ("elseif", "else"):
            indent += 1
    for k, _ in stack:
        notes.append(f"{k} が閉じられていない")
    return out


CAP_RE = re.compile(r"^(図|表)\s*(\d*)\s*\S")


def modal_left(lines):
    """本文の左マージン。いちばん多くの行が揃っている x。"""
    c = {}
    for ln in lines:
        c[round(ln[0].x0)] = c.get(round(ln[0].x0), 0) + 1
    return max(c, key=lambda k: (c[k], -k)) if c else 0


def find_figure_spans(usable, margin, right):
    """図表のブロック（中身＋キャプション）を見つけて [(開始, 終了, 番号, キャプション)] を返す。

    キャプション行（図1 …／表 …）から上へ遡り、本文らしい行
    （左マージンに揃っていて右端まで届く行）に当たったら止める。
    """
    spans, used = [], set()
    for i, ln in enumerate(usable):
        t = "".join(w.t for w in ln)
        # 本文中の「図1に示すグラフの…」ではなくキャプション行だけを拾う。
        # キャプションは短く、本文より右に寄っている（中央寄せ）
        if not CAP_RE.match(t) or i in used:
            continue
        if len(t) > 30 or ln[0].x0 <= margin + 8:
            continue
        j = i
        while j - 1 >= 0 and (j - 1) not in used and i - j < 40:
            prev = usable[j - 1]
            narrative = abs(prev[0].x0 - margin) <= 3 and max(w.x1 for w in prev) > right - 25
            if narrative:
                break
            j -= 1
        if j == i:      # 中身が見つからない＝本文中の「図1に示す」など
            continue
        spans.append((j, i, None, t))
        used.update(range(j, i + 1))
    # 番号を振り直す（キャプションに番号が無いものもあるため）
    return [(a, b, str(k + 1), cap) for k, (a, b, _, cap) in enumerate(spans)]


def build_question(body_lines, notes):
    """問題文。PDFの折り返しをつないで段落にし、図表は [[fig:N]] に置き換える。"""
    usable = [ln for ln in body_lines if not is_footer(ln) and any(w.t.strip() for w in ln)]
    if not usable:
        return ""
    margin = modal_left(usable)
    right = max(max(w.x1 for w in ln) for ln in usable)
    spans = find_figure_spans(usable, margin, right)
    skip = {}
    for a, b, key, cap in spans:
        skip[a] = (key, cap)
        for i in range(a, b + 1):
            skip.setdefault(i, None)
        skip[a] = (key, cap)
        notes.append(f"図表「{cap}」を [[fig:{key}]] に置いた → 画像にするか Markdown表・箇条書きにするか決める")

    paras, cur, prev = [], [], None
    for i, ln in enumerate(usable):
        if i in skip:
            if skip[i]:
                key, _ = skip[i]
                if cur:
                    paras.append("".join(cur))
                    cur = []
                paras.append(f"[[fig:{key}]]")
                prev = None
            continue
        text = line_text(ln, use_blanks=True, notes=notes)
        if not text:
            continue
        indented = ln[0].x0 > margin + 3
        short_prev = prev is not None and max(w.x1 for w in prev) < right - 25
        if cur and (indented or short_prev):
            paras.append("".join(cur))
            cur = []
        cur.append(text)
        prev = ln
    if cur:
        paras.append("".join(cur))

    out = "\n\n".join(p.strip() for p in paras if p.strip())
    for ln_text in out.split("\n"):
        if ln_text.count("[[]]") >= 2:
            notes.append(f"空欄が並ぶ行がある（数式か表かもしれない）: 「{ln_text[:60]}」→ 原本で確かめる")
    return out


def build_choices(choice_lines, notes):
    """解答群。1段組み・2段組み・組合せ（a/b/c の列）に対応する。"""
    rows, cols, header = [], None, None

    # 見出し行（a / b / c だけの行）があれば組合せ問題
    for ln in choice_lines:
        ts = [w.t for w in ln]
        if 2 <= len(ts) <= 4 and all(re.fullmatch(r"[a-e]\d?", t) for t in ts):
            cols = ts
            header = ln
            break

    # ラベル(ア/イ/…)の位置で選択肢を切り出す
    items = []   # [(ラベル, [語…])]
    for ln in choice_lines:
        if is_footer(ln) or ln is header:
            continue
        marks = [i for i, w in enumerate(ln) if w.t in LABELS and len(w.t) == 1]
        if not marks:
            if items:
                items[-1][1].extend(ln)     # 折り返しの続き
            continue
        for k, i in enumerate(marks):
            j = marks[k + 1] if k + 1 < len(marks) else len(ln)
            items.append((ln[i].t, ln[i + 1:j]))

    if not items:
        return None, []

    # ラベルの並びが ア イ ウ … になっているか
    order = [LABELS.index(lab) for lab, _ in items if lab in LABELS]
    if order != list(range(len(order))):
        notes.append(f"解答群のラベルの並びが不自然: {[l for l, _ in items]}")

    for lab, ws in items:
        if not ws:
            rows.append("")
            continue
        if cols:
            parts = split_columns(ws, len(cols))
            rows.append([line_text(p) for p in parts])
        else:
            rows.append(line_text(ws))
    return cols, rows


def scaffold(setname, qno, lines_by_problem, keys):
    pdf_name, set_label, source_head = SETS[setname]
    n, lines = lines_by_problem
    qid = f"B-{setname}-{n:02d}"
    notes = []

    # 〔プログラム〕 と 解答群 の位置を探す
    def find(pred):
        for i, ln in enumerate(lines):
            if pred("".join(w.t for w in ln)):
                return i
        return None

    i_prog = find(lambda t: t.startswith("〔プログラム〕"))
    # 「解答群」のほか「a に関する解答群」のような見出しもある（本文の「解答群の中から選べ。」は拾わない）
    i_ans = find(lambda t: len(t.strip()) <= 20 and re.search(r"解答群[：:]?$", t.strip()))
    i_setsumon = find(lambda t: t.startswith("設問"))

    end_body = i_prog if i_prog is not None else (i_setsumon if i_setsumon is not None else i_ans)
    body = lines[1:end_body] if end_body else lines[1:]
    # 「問N」と同じ行にある書き出しも本文に入れる
    head_line = lines[0][1:] if len(lines[0]) > 1 else []
    if head_line:
        body = [head_line] + body

    question = build_question(body, notes)
    if i_setsumon is not None and i_ans is not None and i_setsumon < i_ans:
        setsumon = build_question(lines[i_setsumon:i_ans], notes)
        question = question + "\n\n【設問】" + re.sub(r"^設問\s*", "", setsumon)

    program = None
    if i_prog is not None:
        stop = i_setsumon if (i_setsumon is not None and i_setsumon > i_prog) else i_ans
        program = build_program(lines[i_prog + 1: stop], notes)

    cols, choices = build_choices(lines[i_ans + 1:], notes) if i_ans is not None else (None, [])

    letter = keys.get(qid)
    answer = LABELS.index(letter) if letter and letter in LABELS else None
    if answer is None:
        notes.append("解答例に見つからない。answer を手で入れること")
    elif answer >= len(choices):
        notes.append(f"解答例は {letter} だが選択肢が {len(choices)} 件しかない。解答群の取り出しを確認すること")

    # 図表のキャプションは目視の対象
    for ln in lines:
        t = "".join(w.t for w in ln)
        if re.match(r"^(図|表)\s*\d*\s*\S", t) and len(t) < 40:
            notes.append(f"図表がある: 「{t}」→ 画像にするか Markdown表にするか決める")

    is_sec = (setname != "SAMPLE" and n == 6) or (setname == "SAMPLE" and n >= 17)

    rec = {
        "id": qid,
        "set": set_label,
        "source": f"{source_head} 問{n}",
        "field": "セキュリティ" if is_sec else "アルゴリズム",
        "topics": [],
        "question": question,
        "choices": choices,
        "answer": answer,
        "estMinutes": 5,
        "explanation": "",
    }
    if cols:
        rec["choiceCols"] = cols
    if not is_sec:
        rec["traceExplanation"] = ""
    if program:
        rec["programId"] = f"P-{setname}-{n:02d}"

    draft = {"_review": notes, "question": rec}
    if program:
        draft["program"] = {
            "id": f"P-{setname}-{n:02d}",
            "caption": "〔プログラム〕",
            "lines": program,
            "trace": {"columns": [], "initial": None, "expected": []},
        }
    return draft


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="setname", required=True, choices=sorted(SETS))
    ap.add_argument("--q", type=int, help="この問だけ（標準出力にも出す）")
    a = ap.parse_args()

    pdf = os.path.join(PDFDIR, SETS[a.setname][0])
    if not os.path.exists(pdf):
        sys.exit(f"PDFが見つかりません: {pdf}")
    keys = json.load(open(KEYS)) if os.path.exists(KEYS) else {}

    problems = find_problems(group_lines(read_words(pdf)))
    os.makedirs(OUTDIR, exist_ok=True)

    made = 0
    for item in problems:
        if a.q and item[0] != a.q:
            continue
        draft = scaffold(a.setname, item[0], item, keys)
        out = os.path.join(OUTDIR, f"{a.setname}-{item[0]:02d}.json")
        with open(out, "w") as f:
            json.dump(draft, f, ensure_ascii=False, indent=1)
            f.write("\n")
        made += 1
        if a.q:
            print(json.dumps(draft, ensure_ascii=False, indent=1))
    print(f"\n{made}問 → {os.path.relpath(OUTDIR, ROOT)}/")


if __name__ == "__main__":
    main()
