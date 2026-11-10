#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDFから指定問題の図を自動で切り出して images/{id}.png に保存する。

目視での試行錯誤を無くすのが目的。OCRで「問N」「問N+1」の位置を特定し、
その間にある図（＝文字行を除いたインクの塊）の外接矩形を自動で求める。

例:
  # 2019秋 問1 の図。選択肢のア〜エ表は含めない（選択肢はアプリ側にテキストで持つ）
  tools/figcrop.py --id 2019A-01 --pdf 2019r01a --q 1 --exclude-choices

  # 選択肢自体が図の問題。ア〜エも1枚に含める
  tools/figcrop.py --id 2016A-03 --pdf 2016h28h --q 3 --include-choices

  # 保存せず範囲だけ見たいとき
  tools/figcrop.py --id X --pdf 2017h29h --q 22 --exclude-choices --dry-run
"""
import argparse, os, re, subprocess, sys, tempfile
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OCR = os.path.join(ROOT, "tools", "ocr")
DPI = 300
OUT_MAX_W = 1000

CHOICE_HEAD = re.compile(r'^\s*[アイウエ](\s|$|[．.、]|\s*[A-Za-z0-9(（])')


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def render(pdf_tag, page, outdir):
    """指定ページを300dpiでPNG化してパスを返す。"""
    pdf = os.path.join(ROOT, "pdf", f"{pdf_tag}_fe_am_qs.pdf")
    if not os.path.exists(pdf):
        sys.exit(f"PDFが見つかりません: {pdf}")
    prefix = os.path.join(outdir, "pg")
    sh(f'pdftoppm -png -r {DPI} -f {page} -l {page} "{pdf}" "{prefix}"')
    for f in sorted(os.listdir(outdir)):
        if f.startswith("pg") and f.endswith(".png"):
            return os.path.join(outdir, f)
    return None


def ocr_lines(png):
    """[(text, x0, y0, x1, y1), ...] を返す。"""
    out = sh(f'"{OCR}" --bbox "{png}"')
    rows = []
    for ln in out.splitlines():
        if ln.startswith("====="):
            continue
        parts = ln.split("\t")
        if len(parts) != 5:
            continue
        t, *nums = parts
        try:
            x0, y0, x1, y1 = map(int, nums)
        except ValueError:
            continue
        rows.append((t, x0, y0, x1, y1))
    return rows


def find_page(pdf_tag, qno, hint, workdir):
    """問Nが載っているページを探す。hint付近から外側へ探索する。"""
    pat = re.compile(rf'^問\s*{qno}(?!\d)')
    tried = []
    for p in [hint] + [hint + d for d in (1, -1, 2, -2, 3, -3, 4, -4)]:
        if p < 1 or p in tried:
            continue
        tried.append(p)
        with tempfile.TemporaryDirectory() as td:
            png = render(pdf_tag, p, td)
            if not png:
                continue
            if any(pat.match(t) for t, *_ in ocr_lines(png)):
                return p
    return None


def ink_bbox(im, box):
    """box内で「白でない画素」の外接矩形を返す(画像全体の座標)。"""
    x0, y0, x1, y1 = box
    g = im.convert("L").crop((x0, y0, x1, y1))
    bw = g.point(lambda v: 0 if v < 200 else 255)  # 200未満をインクとみなす
    bb = bw.point(lambda v: 255 - v).getbbox()      # インクを白にして外接矩形
    if not bb:
        return None
    return (x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3])


def row_has_ink(im, y0, y1):
    """[y0,y1) の各行にインクがあるかの真偽リストを返す。"""
    g = im.convert("L").crop((0, y0, im.width, y1))
    bw = g.point(lambda v: 255 if v < 200 else 0)
    return [bw.crop((0, r, bw.width, r + 1)).getbbox() is not None
            for r in range(bw.height)]


def widest_gap(im, y0, y1):
    """[y0,y1) の中で最も広い「完全な空白帯」の(開始y, 終了y)を返す。"""
    if y1 - y0 < 4:
        return None
    rows = row_has_ink(im, y0, y1)
    best = None
    run = None
    for i, has in enumerate(rows + [True]):
        if not has:
            if run is None:
                run = i
        else:
            if run is not None:
                if best is None or (i - run) > (best[1] - best[0]):
                    best = (run, i)
                run = None
    if best is None:
        return None
    return (y0 + best[0], y0 + best[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True, help="問題ID (例 2019A-01)")
    ap.add_argument("--pdf", required=True, help="PDFタグ (例 2019r01a, 2017h29h)")
    ap.add_argument("--q", type=int, required=True, help="問番号")
    ap.add_argument("--page", type=int, help="ページを直接指定(省略時は自動探索)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--exclude-choices", action="store_true",
                   help="末尾のア〜エ選択肢ブロックを除外(既定)")
    g.add_argument("--include-choices", action="store_true",
                   help="選択肢自体が図の問題。ア〜エも含める")
    ap.add_argument("--pad", type=int, default=18, help="余白px (既定18)")
    ap.add_argument("--dry-run", action="store_true", help="保存せず範囲だけ表示")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        page = a.page
        if page is None:
            # 問番号からページを推定(1ページ約2〜3問, 本文はp.3以降)
            page = find_page(a.pdf, a.q, max(3, round(a.q / 2.2) + 2), td)
            if page is None:
                sys.exit(f"問{a.q} が見つかりません。--page で指定してください。")

        png = render(a.pdf, page, td)
        im = Image.open(png)
        W, H = im.size
        lines = ocr_lines(png)

        # 問N の行 → 次の問 までを対象帯にする
        pat = re.compile(rf'^問\s*{a.q}(?!\d)')
        nxt = re.compile(r'^問\s*(\d{1,2})(?!\d)')
        top = None
        bottom = H
        for t, x0, y0, x1, y1 in lines:
            if top is None and pat.match(t):
                top = y1            # 問題文1行目の下端から下を対象にする
                continue
            if top is not None:
                m = nxt.match(t)
                if m and int(m.group(1)) != a.q:
                    bottom = y0
                    break
        if top is None:
            sys.exit(f"p.{page} に問{a.q} が見つかりません。--page を確認してください。")

        # 帯の中の行を分類する
        band = [(t, x0, y0, x1, y1) for (t, x0, y0, x1, y1) in lines
                if y0 >= top and y1 <= bottom]

        # 問題文の続き = 帯の先頭から連続する「左端から始まる行」。図はその下。
        band.sort(key=lambda r: r[2])
        left_min = min([x0 for _, x0, *_ in band], default=0)
        indent_max = left_min + int(0.06 * W)
        text_bottom = top
        for t, x0, y0, x1, y1 in band:
            if CHOICE_HEAD.match(t):
                break
            if x0 <= indent_max:
                text_bottom = max(text_bottom, y1)
            else:
                break  # 左端から外れたら図が始まっている

        # 選択肢ブロックの開始位置
        choice_top = None
        for t, x0, y0, x1, y1 in band:
            if y0 > text_bottom and CHOICE_HEAD.match(t):
                choice_top = y0
                break

        # 本文と図の間の空白を飛ばし、図が実際に始まる行を fig_top にする
        fig_top = text_bottom
        rows = row_has_ink(im, text_bottom, min(bottom, H))
        for i, has in enumerate(rows):
            if has:
                fig_top = text_bottom + i
                break

        fig_bottom = bottom
        if not a.include_choices and choice_top is not None:
            # 選択肢の直上は表の枠線やヘッダ行のことがあるので、
            # 図の開始以降で最も広い空白帯を境にして切る
            gap = widest_gap(im, fig_top + 1, choice_top)
            fig_bottom = gap[0] if gap else choice_top

        box = (0, fig_top, W, fig_bottom)
        bb = ink_bbox(im, box)
        if not bb:
            sys.exit("図が見つかりません(この帯にインクがありません)")
        x0, y0, x1, y1 = bb
        p = a.pad
        crop = (max(0, x0 - p), max(0, y0 - p), min(W, x1 + p), min(H, y1 + p))

        out = im.crop(crop).convert("L")
        if out.width > OUT_MAX_W:
            h = int(out.height * OUT_MAX_W / out.width)
            out = out.resize((OUT_MAX_W, h), Image.LANCZOS)

        mode = "選択肢を含む" if a.include_choices else "選択肢を除外"
        print(f"page={page}  {mode}  crop={crop}  size={out.size}")
        if a.dry_run:
            prev = os.path.join(tempfile.gettempdir(), f"figcrop_{a.id}.png")
            out.save(prev)
            print(f"preview: {prev}")
        else:
            dest = os.path.join(ROOT, "images", f"{a.id}.png")
            out.save(dest, optimize=True)
            print(f"saved: images/{a.id}.png  ← これを1回だけ目視すること")


if __name__ == "__main__":
    main()
