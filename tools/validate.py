#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""questions.json / abbr.json の不変条件をまとめて検査する。

問題が無ければ数行だけ出力する。データを変更したら必ず実行すること。

  tools/validate.py          通常検査（高速）
  tools/validate.py --deep   画像もOCRして「ア〜エの選択肢表が焼き込まれた図」を検出（低速）
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="画像もOCRして検査(低速)")
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
    # 科目Bの図（data/kamokub.json の figures）も同じ images/ に置く。中身の検査は validate_b.py
    kb = os.path.join(ROOT, "data", "kamokub.json")
    if os.path.exists(kb):
        refs |= {f["file"].split("/")[-1] for q in json.load(open(kb, encoding="utf-8")) for f in q.get("figures", [])}
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
        known = {q["id"] for q in D} | {f"A-{x['id']}" for x in AB}
        for ln in open(LOG):
            if not ln.startswith("### "):
                continue
            head = re.split(r"[—(（]", ln[4:])[0]
            for i in re.findall(r"A-\d+|[0-9A-Z]+-\d+", head):
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

    print(f"問題数 {len(D)} / 画像 {sum(1 for q in D if q.get('image'))} / "
          f"英略語 {len(AB)} / 解答照合 {key_checked}問 / 修正ログ {log_ids}件")
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
