#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""科目BのPDFから図を切り出して images/{id}.png に保存する。

科目BのPDFはテキスト層が生きているので、OCR（ルートの tools/figcrop.py）は使わない。
切り出す範囲はキャプション（図1 など）から自動で求める。座標を目視で試行錯誤しないこと。

  # キャプションを指定するだけ。上端は本文の左マージンを手掛かりに自動で求める
  tools/b_figcrop.py --id B-R08-04-1 --set R08 --bottom 図1

  # 自動で合わないときだけ上端の目印を足す／保存せず範囲だけ見る
  tools/b_figcrop.py --id X --set R08 --bottom 図2 --top 要素番号 --dry-run
"""
import argparse, os, re, subprocess, sys, tempfile
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDFDIR = os.path.join(ROOT, "pdf", "SubjectB")
IMGDIR = os.path.join(ROOT, "images")
DPI = 300
OUT_MAX_W = 1000

SETS = {
    "SAMPLE": "fe_kamoku_b_set_sample_qs.pdf",
    "R05": "2023r05_fe_kamoku_b_qs.pdf",
    "R06": "2024r06_fe_kamoku_b_qs.pdf",
    "R07": "2025r07_fe_kamoku_b_qs.pdf",
    "R08": "2026r08_fe_kamoku_b_qs.pdf",
}

PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
LINE = re.compile(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>', re.S)
WORD = re.compile(r"<word[^>]*>(.*?)</word>", re.S)


def pages_with_lines(pdf):
    """[(幅, 高さ, [(xMin, yMin, xMax, yMax, 行のテキスト), …]), …] をページ順に返す。"""
    r = subprocess.run(["pdftotext", "-bbox-layout", pdf, "-"], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"pdftotext に失敗しました: {pdf}\n{r.stderr}")
    out = []
    chunks = PAGE.split(r.stdout)
    # split の結果は [先頭, 幅, 高さ, 中身, 幅, 高さ, 中身, …]
    for i in range(1, len(chunks), 3):
        w, h, body = float(chunks[i]), float(chunks[i + 1]), chunks[i + 2]
        lines = []
        for m in LINE.finditer(body):
            text = "".join(WORD.findall(m.group(5)))
            lines.append((float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), text))
        lines.sort(key=lambda l: (l[1], l[0]))
        # 同じ高さに並ぶ断片（「図1」と「グラフの例」など）は1行にまとめる。
        # そうしないとキャプションを丸ごとの文字列で探せない
        merged = []
        for ln in lines:
            if merged and ln[1] < merged[-1][3] - 1:
                a = merged[-1]
                merged[-1] = (min(a[0], ln[0]), min(a[1], ln[1]),
                              max(a[2], ln[2]), max(a[3], ln[3]), a[4] + ln[4])
            else:
                merged.append(ln)
        out.append((w, h, merged))
    return out


def norm(s):
    """全角スペースや空白を落として比較する（PDFの語は途切れやすい）。"""
    return re.sub(r"\s|　", "", s)


def find_range(pages, bottom, top=None, page_hint=None):
    """図の範囲 (ページ番号, y上端, y下端, x左, x右) を返す。ページは1始まり。

    下端はキャプション（例 "図1"）で指定する。上端は指定が無ければ自動で求める:
    キャプションから上に遡り、本文の左マージンまで戻った行の手前で止める。
    図の中身は本文より深くインデントされているので、これで図のブロックだけが取れる。
    """
    bottom_n = norm(bottom)
    top_n = norm(top) if top else None
    for pno, (w, h, lines) in enumerate(pages, start=1):
        if page_hint and pno != page_hint:
            continue
        # 本文中の「図1に示すグラフの…」ではなくキャプション行を取りたい。
        # キャプションは行頭が図/表で、短く、本文より右に寄っている（中央寄せ）
        margin0 = min(l[0] for l in lines) if lines else 0
        bi = next((i for i, l in enumerate(lines)
                   if norm(l[4]).startswith(bottom_n) and len(norm(l[4])) <= 30 and l[0] > margin0 + 8), None)
        if bi is None:
            continue
        # キャプションが複数の語に割れている場合、同じ行（y帯）の続きも含める
        cap_bottom = lines[bi][3]
        while bi + 1 < len(lines) and lines[bi + 1][1] < cap_bottom:
            bi += 1
            cap_bottom = max(cap_bottom, lines[bi][3])

        if top_n:
            ti = next((i for i in range(bi, -1, -1) if top_n in norm(lines[i][4])), None)
            if ti is None:
                continue
        else:
            # 本文の左マージン＝最も多くの行が揃っている x。図の中身はこれより深く字下げされる
            counts = {}
            for l in lines:
                counts[round(l[0])] = counts.get(round(l[0]), 0) + 1
            margin = max(counts, key=lambda k: (counts[k], -k))
            limit = margin + 12                        # 段落先頭の字下げぶんを許容する
            ti = bi
            while ti - 1 >= 0 and lines[ti - 1][0] > limit and bi - ti < 40:
                ti -= 1

        seg = lines[ti:bi + 1]
        return pno, min(l[1] for l in seg), max(l[3] for l in seg), min(l[0] for l in seg), max(l[2] for l in seg)
    sys.exit(f"キャプションが見つかりません: {bottom!r}")


def render(pdf, page, outdir):
    prefix = os.path.join(outdir, "pg")
    subprocess.run(["pdftoppm", "-png", "-r", str(DPI), "-f", str(page), "-l", str(page), pdf, prefix],
                   check=True, capture_output=True)
    for f in sorted(os.listdir(outdir)):
        if f.startswith("pg") and f.endswith(".png"):
            return os.path.join(outdir, f)
    sys.exit("ページのPNG化に失敗しました")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True, help="保存名。images/{id}.png になる")
    ap.add_argument("--set", required=True, choices=sorted(SETS))
    ap.add_argument("--bottom", required=True, help="図のキャプション（例 図1）。これが下端になる")
    ap.add_argument("--top", help="上端の目印。省略すると自動で求める")
    ap.add_argument("--page", type=int, help="ページを限定する")
    ap.add_argument("--pad", type=float, default=6, help="上下の余白(pt)")
    ap.add_argument("--padx", type=float, default=30,
                    help="左右の余白(pt)。範囲は文字の位置から求めるので、罫線や網掛けが欠けないよう広めに取る")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    pdf = os.path.join(PDFDIR, SETS[a.set])
    if not os.path.exists(pdf):
        sys.exit(f"PDFが見つかりません: {pdf}")

    pages = pages_with_lines(pdf)
    pno, y0, y1, x0, x1 = find_range(pages, a.bottom, a.top, a.page)
    print(f"p.{pno}  y {y0:.1f}–{y1:.1f}  x {x0:.1f}–{x1:.1f} (pt)")
    if a.dry_run:
        return

    scale = DPI / 72.0
    with tempfile.TemporaryDirectory() as td:
        img = Image.open(render(pdf, pno, td))
        box = (max(0, int((x0 - a.padx) * scale)), max(0, int((y0 - a.pad) * scale)),
               min(img.width, int((x1 + a.padx) * scale)), min(img.height, int((y1 + a.pad) * scale)))
        crop = img.crop(box).convert("RGB")
        if crop.width > OUT_MAX_W:
            crop = crop.resize((OUT_MAX_W, round(crop.height * OUT_MAX_W / crop.width)), Image.LANCZOS)
        os.makedirs(IMGDIR, exist_ok=True)
        out = os.path.join(IMGDIR, f"{a.id}.png")
        crop.save(out, optimize=True)
    print(f"{crop.width}x{crop.height} → {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
