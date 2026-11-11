#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""科目BのPDFを問ごとのテキストに切り分ける。JSON化の下書き用。

科目BのPDFはテキスト層が生きているのでOCRは不要。
出力はあくまで下書きで、空欄 [[a]] の挿入・インデントの補正・解答群の組み立ては人手で行う。

  tools/b_extract.py                 全セットを展開
  tools/b_extract.py --set R05       1セットだけ
  tools/b_extract.py --set R05 --q 1 1問だけ標準出力に出す
"""
import argparse, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDFDIR = os.path.join(ROOT, "pdf", "SubjectB")
OUTDIR = os.path.join(ROOT, "subject-b", "extracted")

# セット名 → (問題冊子PDF, 解答例PDF, アプリ上の set 表記)
SETS = {
    "SAMPLE": ("fe_kamoku_b_set_sample_qs.pdf", "fe_kamoku_b_set_sample_ans.pdf", "サンプル問題"),
    "R05": ("2023r05_fe_kamoku_b_qs.pdf", "2023r05_fe_kamoku_b_ans.pdf", "令和5年度 公開問題"),
    "R06": ("2024r06_fe_kamoku_b_qs.pdf", "2024r06_fe_kamoku_b_ans.pdf", "令和6年度 公開問題"),
    "R07": ("2025r07_fe_kamoku_b_qs.pdf", "2025r07_fe_kamoku_b_ans.pdf", "令和7年度 公開問題"),
    "R08": ("2026r08_fe_kamoku_b_qs.pdf", "2026r08_fe_kamoku_b_ans.pdf", "令和8年度 公開問題"),
}

# 「問１」「問 10」など。全角/半角どちらもある
QHEAD = re.compile(r"^\s*問\s*([0-9０-９]+)\s{2,}\S")
ZEN = str.maketrans("０１２３４５６７８９", "0123456789")


def pdftotext(pdf):
    r = subprocess.run(["pdftotext", "-layout", pdf, "-"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"pdftotext に失敗しました: {pdf}\n{r.stderr}")
    return r.stdout


def split_questions(text):
    """(問番号, 開始ページ, 終了ページ, 本文) のリストを返す。ページは1始まり。"""
    pages = text.split("\f")
    # (行, ページ番号) の並びに直す
    flat = []
    for pno, page in enumerate(pages, start=1):
        for line in page.split("\n"):
            flat.append((line, pno))

    starts = []
    for i, (line, pno) in enumerate(flat):
        m = QHEAD.match(line)
        if not m:
            continue
        n = int(m.group(1).translate(ZEN))
        # 表紙の「問題番号  問１～問６」を拾わないよう、既出の番号より大きいものだけ採用する
        if starts and n <= starts[-1][0]:
            continue
        if not starts and n != 1:
            continue
        starts.append((n, i, pno))

    out = []
    for k, (n, i, pno) in enumerate(starts):
        j = starts[k + 1][1] if k + 1 < len(starts) else len(flat)
        body = "\n".join(l for l, _ in flat[i:j])
        end_page = flat[j - 1][1]
        out.append((n, pno, end_page, body.rstrip()))
    return out


def clean(body):
    """ページ番号のフッタ（－ 5 －）と連続する空行を落とす。"""
    lines = [l for l in body.split("\n") if not re.match(r"^\s*[－-]\s*\d+\s*[－-]\s*$", l)]
    out, blank = [], 0
    for l in lines:
        if l.strip():
            blank = 0
            out.append(l.rstrip())
        else:
            blank += 1
            if blank <= 1:
                out.append("")
    return "\n".join(out).strip()


ANS = re.compile(r"問\s*([0-9０-９]+)\s+([アイウエオカキクケコサシス])(?:\s|$)")


def build_answer_keys():
    """解答例PDFから {id: 正解の記号} を作る。validate_b.py の照合に使う。"""
    keys = {}
    for name in sorted(SETS):
        _, ans_pdf, _ = SETS[name]
        path = os.path.join(PDFDIR, ans_pdf)
        if not os.path.exists(path):
            sys.exit(f"PDFが見つかりません: {path}")
        found = {}
        for m in ANS.finditer(pdftotext(path)):
            found[int(m.group(1).translate(ZEN))] = m.group(2)
        for n, letter in sorted(found.items()):
            keys[f"B-{name}-{n:02d}"] = letter
    return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", dest="setname", choices=sorted(SETS), help="対象セット")
    ap.add_argument("--q", type=int, help="この問だけ標準出力に出す（ファイルに書かない）")
    ap.add_argument("--answers", action="store_true", help="解答例PDFから data/kamokub_answer_keys.json を作る")
    a = ap.parse_args()

    if a.answers:
        import json
        keys = build_answer_keys()
        out = os.path.join(ROOT, "data", "kamokub_answer_keys.json")
        with open(out, "w") as f:
            json.dump(keys, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write("\n")
        print(f"{len(keys)}問 → {os.path.relpath(out, ROOT)}")
        return

    targets = [a.setname] if a.setname else sorted(SETS)
    os.makedirs(OUTDIR, exist_ok=True)

    for name in targets:
        qs_pdf, _, label = SETS[name]
        path = os.path.join(PDFDIR, qs_pdf)
        if not os.path.exists(path):
            sys.exit(f"PDFが見つかりません: {path}")
        items = split_questions(pdftotext(path))
        if a.q:
            for n, p1, p2, body in items:
                if n == a.q:
                    print(f"# {label} 問{n}  (p.{p1}-{p2})\n")
                    print(clean(body))
                    return
            sys.exit(f"問{a.q} が見つかりません")
        for n, p1, p2, body in items:
            out = os.path.join(OUTDIR, f"{name}-{n:02d}.txt")
            with open(out, "w") as f:
                f.write(f"# {label} 問{n}  (p.{p1}-{p2})\n\n")
                f.write(clean(body) + "\n")
        print(f"{name}: {len(items)}問 → {os.path.relpath(OUTDIR, ROOT)}/")


if __name__ == "__main__":
    main()
