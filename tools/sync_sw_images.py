#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""images/*.png から sw.js の IMAGES 配列を生成して書き換える。

画像を手書きで足し引きしない。新しい図を追加したら必ず実行すること
（`tools/release.sh` がビルド前に自動実行する）。

  tools/sync_sw_images.py          書き換える
  tools/sync_sw_images.py --check  書き換えず、ズレがあれば終了コード1（validate.pyが使う）
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, "sw.js")
IMGDIR = os.path.join(ROOT, "images")

START = "// IMAGES:START（tools/sync_sw_images.py が生成。手で編集しない）"
END = "// IMAGES:END"


def current_images():
    return sorted(f for f in os.listdir(IMGDIR) if f.endswith(".png"))


def render_block(images):
    lines = [START, "const IMAGES = ["]
    for f in images:
        lines.append(f"  './images/{f}',")
    lines.append("];")
    lines.append(END)
    return "\n".join(lines)


def existing_block(src):
    m = re.search(re.escape(START) + r".*?" + re.escape(END), src, re.S)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="書き換えず、ズレを検査するのみ")
    a = ap.parse_args()

    src = open(SW, encoding="utf-8").read()
    images = current_images()
    block = render_block(images)
    m = existing_block(src)

    if a.check:
        if not m:
            print("sw.js に IMAGES ブロックが無い（sync_sw_images.py を一度実行すること）")
            sys.exit(1)
        if m.group(0) != block:
            print("sw.js の IMAGES が images/ の実体とズレている → tools/sync_sw_images.py を実行")
            sys.exit(1)
        print(f"OK: sw.js の IMAGES は images/ と一致（{len(images)}件）")
        return

    if m:
        new_src = src[:m.start()] + block + src[m.end():]
    else:
        # 初回: ASSETS の定義直後に挿入
        marker = "];\n"
        i = src.index(marker) + len(marker)
        new_src = src[:i] + "\n" + block + "\n" + src[i:]

    if new_src != src:
        open(SW, "w", encoding="utf-8").write(new_src)
        print(f"sw.js を更新: IMAGES {len(images)}件")
    else:
        print(f"変更なし: IMAGES {len(images)}件のまま")


if __name__ == "__main__":
    main()
