#!/usr/bin/env node
// fe-study-app.jsx の任意のコンポーネントをNode上でサーバーレンダリングして確認する。
// ブラウザを開かず、画像の目視と同じ「保存後に1回だけ見る」を会話の中で素早く行うためのツール。
//
//   node tools/render_check.mjs 2012A-03 NO3-69          過去問を詳細画面で描画（解答は開いた状態）
//   node tools/render_check.mjs --abbr 1 2               英略語を回答済み状態で描画
//   node tools/render_check.mjs --session 2017A-70 [3,2,1,0]
//        出題画面を「回答済み・解説を展開」した状態で描画する。
//        第2引数は選択肢の表示順（元index の並び）。省略時は 3,2,1,0（逆順）。
//        解説の並べ替えを確かめるために、シャッフルを固定できるようにしてある。
//   node tools/render_check.mjs --behavior               描画では見えない「性質」を検査する（模試の
//        あとで解く・復習への登録・理解度の選び直し）。hookを差し替えたミニランタイムで
//        コンポーネント関数を直接呼び、props の onXxx を叩く。失敗があれば exit 1
//   node tools/render_check.mjs --snapshot <out.json>    全件のスナップショットを採る（リファクタの前後比較用）
//        過去問1,252問の詳細画面と出題画面、英略語の出題画面、主要画面をHTMLのSHA-256で、
//        純関数（SRS・解説の並べ替え・時間表示など）を値そのもので記録する。乱数・時計・localStorage を
//        固定するので、同じコードなら何度採っても1バイトも変わらない
//   node tools/render_check.mjs --snapshot-diff <a.json> <b.json>
//        2つのスナップショットを比べ、差のあった項目を一覧する。差があれば exit 1
//   node tools/render_check.mjs --b-session <科目Bのid> [ok|ng]  科目Bの出題画面を解答済み・解説を展開して描く
//        （--snapshot-b で差が出たときに、どこが違うかを生のHTMLで見るため）
//   node tools/render_check.mjs --snapshot-b <out.json>  科目B（44問）の全件スナップショット
//        詳細画面・出題画面（未回答の問題文／プログラム／解答欄、正解・不正解で解説を開いた状態）・
//        主要画面と、トレース表の状態遷移などの純関数を記録する。比較は --snapshot-diff で行う
//   node tools/render_check.mjs --list                   使える主要コンポーネント名を表示
//
// 出力は生のHTML（stdout）。grepや文字列includesで確認する。例:
//   node tools/render_check.mjs 2012A-03 | grep -c '<table'
//
// 内部で esbuild を都度呼ぶ（react/react-dom は external 化してNode側のreactと共有する。
// 同梱すると2つのReactインスタンスが混在し "Invalid hook call" になるので外さないこと）。

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, "fe-study-app.jsx");

// document.getElementById("root") で createRoot するトップレベル呼び出しは
// Node上では壊れるので、バンドル後に該当行だけ取り除く。
function stripMount(code) {
  return code
    .split("\n")
    .filter((l) => !l.includes('document.getElementById("root")'))
    .join("\n");
}

async function loadApp(entry = ENTRY, exportsList = null) {
  const EXPORTS = [
    "QuestionDetail", "QuestionList", "ResultScreen", "HomeScreen", "QuizApp",
    "AbbrQuizScreen", "AbbrHome", "AbbrList", "buildAbbrChoices",
    "SessionScreen", "orderExplanation",
    "MockApp", "MockExamScreen", "MockScore",
    // --snapshot 用（画面）
    "App", "SetupScreen", "StatsScreen", "AbbrSetup", "AbbrStats",
    "MockHome", "MockDetail", "MockHistoryScreen",
    // --snapshot 用（純関数）
    "initCard", "reviewCard", "loadData", "saveData", "histCorrect", "fmtMs",
    "makeChoiceOrder", "isSymbolOnlyChoices", "getExplanationSummary", "remapLabels", "plainPreview",
    "abbrSimilarity", "mockNormKey", "mockPool", "newMockProgress", "gradeMock",
    // --behavior 用（バックアップ）
    "BackupRestore", "buildBackup",
  ];
  if (exportsList) EXPORTS.splice(0, EXPORTS.length, ...exportsList);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["react", "react-dom", "react-dom/client"],
    // 「?名前」は無くてもよい名前。バンドルに無ければ undefined を入れる
    footer: { js: `module.exports.__rc = {${EXPORTS.map((n) => n.startsWith("?")
      ? `${n.slice(1)}: typeof ${n.slice(1)} === "undefined" ? undefined : ${n.slice(1)}` : n).join(",")}};` },
  });
  const code = stripMount(result.outputFiles[0].text);
  const mod = { exports: {} };
  const fn = new Function("module", "exports", "require", "__dirname", code);
  global.document = global.document || { getElementById: () => null };
  try {
    fn(mod, mod.exports, require, ROOT);
  } catch (e) {
    // フッタが参照する名前がバンドルに無いと ReferenceError になる（ファイル分割で名前が変わった等）
    throw new Error(`render_check: バンドルの読み込みに失敗: ${e.message}`);
  }
  const rc = mod.exports.__rc;
  // 黙って undefined のまま進まないよう、全部そろっているかを先に確かめる
  const missing = EXPORTS.filter((n) => !n.startsWith("?") && rc[n] === undefined);
  if (missing.length) throw new Error(`render_check: 見つからない名前: ${missing.join(", ")}`);
  return rc;
}

function render(el) {
  return renderToStaticMarkup(el);
}

// AbbrQuizScreen は内部 useState（idx, selected, answered, log の順）を持ち、
// QuestionDetail と違って「回答済みで開始する」propを持たない。
// フックの呼び出し順は固定なので、呼び出しインデックスで強制上書きして
// 「選んで回答した直後」の状態を再現する。
function withForcedHooks(React, overrides, fn) {
  const real = React.useState;
  let i = 0;
  React.useState = function (init) {
    const idx = i++;
    if (overrides.has(idx)) return [overrides.get(idx), () => {}];
    return real.call(React, init);
  };
  try {
    return fn();
  } finally {
    React.useState = real;
  }
}

// ===== --behavior: hook を差し替えたミニランタイム =====
// 1コンポーネントを「マウント」し、state を保持したまま何度でも再レンダーできる。
// 子コンポーネントは展開しない（要素の props を取り出して onXxx を直接呼ぶ）。
function mount(React, Comp, props) {
  const real = { useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback, useMemo: React.useMemo };
  const slots = [];
  let i = 0;
  let tree = null;
  const run = () => {
    i = 0;
    React.useState = (init) => {
      const k = i++;
      if (!(k in slots)) slots[k] = typeof init === "function" ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === "function" ? v(slots[k]) : v; }];
    };
    React.useRef = (init) => { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; };
    React.useEffect = () => {};
    React.useCallback = (f) => f;
    React.useMemo = (f) => f();
    try { tree = Comp(props); } finally { Object.assign(React, real); }
    return tree;
  };
  run();
  return {
    get tree() { return tree; },
    rerender(next) { if (next) props = { ...props, ...next }; return run(); },
    slots,
  };
}

function walk(node, fn) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
  fn(node);
  if (node.props) walk(node.props.children, fn);
}
const textOf = (node) => {
  let t = "";
  const go = (n) => { if (n == null || n === false) return; if (typeof n !== "object") { t += String(n); return; } if (Array.isArray(n)) { n.forEach(go); return; } if (n.props) go(n.props.children); };
  go(node);
  return t;
};
const findEl = (tree, pred) => { let hit = null; walk(tree, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const byType = (name) => (n) => typeof n.type === "function" && n.type.name === name;
const buttonWith = (txt) => (n) => n.type === "button" && textOf(n).includes(txt);

async function behavior(app) {
  const store = {};
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  global.window = { confirm: () => true, alert: () => {}, scrollTo: () => {}, addEventListener() {}, removeEventListener() {} };
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) fails++; };

  // --- MockApp: 採点で復習に登録・理解度の選び直し ---
  let cards = {};
  const setCardsCalls = [];
  const setCards = (m) => { setCardsCalls.push(m); cards = { ...cards, ...m }; };
  const appM = mount(React, app.MockApp, { onBusyChange() {}, cardStates: cards, setCards });
  findEl(appM.tree, byType("MockHome")).props.onStart();
  appM.rerender();
  const exam = findEl(appM.tree, byType("MockExamScreen"));
  check(!!exam, "模試を開始すると実施画面になる");
  const init = exam.props.init;
  check(Array.isArray(init.flags) && init.flags.length === init.ids.length && init.flags.every((f) => f === false), "新しい模試の flags は全問 false");
  // 先頭は正解、2問目は不正解、残りは未回答で採点。既存カードを1枚持たせておく
  const answers = init.qs.map((q, i) => (i === 0 ? q.answer : i === 1 ? (q.answer + 1) % 4 : null));
  const pre = { interval: 4, easeFactor: 2.6, dueDate: "2099-01-01", reps: 1, lapses: 0, history: [{ date: "2026-01-01", ts: 1, quality: 2, correct: true }], lastResult: "correct" };
  cards = { [init.ids[0]]: pre };
  appM.rerender({ cardStates: cards });
  findEl(appM.tree, byType("MockExamScreen")).props.onSubmit({ answers, elapsedMs: 1000 });
  appM.rerender({ cardStates: cards });
  check(setCardsCalls.length === 1, "採点で setCards が1回だけ呼ばれる");
  const reg = setCardsCalls[0];
  check(Object.keys(reg).length === init.ids.length, `全${init.ids.length}問が復習に登録される`);
  check(reg[init.ids[0]].history.length === 2 && reg[init.ids[0]].history[1].quality === 2 && reg[init.ids[0]].history[1].correct === true, "正解 → わかった(2)・既存の履歴に1件追加");
  check(reg[init.ids[1]].history.length === 1 && reg[init.ids[1]].history[0].quality === 0 && reg[init.ids[1]].history[0].correct === false, "不正解 → わからない(0)");
  check(reg[init.ids[2]].history[0].quality === 0 && reg[init.ids[2]].history[0].correct === false, "未回答 → わからない(0)・不正解扱い");
  const score = findEl(appM.tree, byType("MockScore"));
  check(score && typeof score.props.onRate === "function", "採点直後の結果画面では理解度を選び直せる");
  check(score.props.run.ratings.startsWith("200"), "run.ratings に既定の理解度を保存");

  // 選び直し: 1問目を 迷った(1) に → 2回目、さらに わからない(0) に
  await new Promise((r) => setTimeout(r, 2));   // ts が採点時と同じミリ秒にならないように
  score.props.onRate(0, 1);
  appM.rerender({ cardStates: cards });
  findEl(appM.tree, byType("MockScore")).props.onRate(0, 0);
  appM.rerender({ cardStates: cards });
  const c0 = cards[init.ids[0]];
  check(c0.history.length === 2 && c0.history[1].quality === 0, "選び直しは解答前のカードから作り直す（履歴は1件しか増えない）");
  check(c0.reps === 0 && c0.lapses === 1, "選び直した理解度で SRS が計算される");
  const saved = JSON.parse(store["fe-exam-mock-v1"]).runs[0];
  check(saved.ratings[0] === "0", "選び直しが模試の履歴にも保存される");

  // 模試の後に過去問モードで同じ問題を解いた → 上書きしない
  cards = { ...cards, [init.ids[1]]: { ...cards[init.ids[1]], history: [...cards[init.ids[1]].history, { date: "2026-11-10", ts: Date.now() + 99, quality: 2, correct: true }] } };
  appM.rerender({ cardStates: cards });
  const before = setCardsCalls.length;
  findEl(appM.tree, byType("MockScore")).props.onRate(1, 2);
  check(setCardsCalls.length === before, "過去問モードで解き直した問題は選び直しで上書きしない");

  // 履歴から開いた過去の模試は選び直せない（メモリ上の snapshot が無い＝再起動後と同じ）
  const appH = mount(React, app.MockApp, { onBusyChange() {}, cardStates: cards, setCards });
  findEl(appH.tree, byType("MockHome")).props.onHistory();
  appH.rerender();
  findEl(appH.tree, byType("MockHistoryScreen")).props.onOpen(saved);
  appH.rerender();
  check(findEl(appH.tree, byType("MockScore")).props.onRate === null, "履歴から開いた模試では理解度は表示のみ");

  // 描画できること（実行時エラーの検出）。直後は3択、履歴は選択中の1つだけ
  const htmlFresh = render(React.createElement(app.MockScore, { run: saved, isFresh: true, histFailed: false, onRate() {}, onOpen() {}, onBack() {} }));
  const htmlHist = render(React.createElement(app.MockScore, { run: saved, isFresh: false, histFailed: false, onRate: null, onOpen() {}, onBack() {} }));
  const cnt = (h, t) => h.split(t).length - 1;
  check(cnt(htmlFresh, "迷った") === saved.ids.length, "結果画面（直後）: 全問に理解度3択が出る");
  check(cnt(htmlHist, "迷った") === 0 && cnt(htmlHist, "わからない") > 0, "結果画面（履歴）: 選択中の理解度だけ出る");

  // 詳細画面の前後移動
  findEl(appH.tree, byType("MockScore")).props.onOpen(3);
  appH.rerender();
  let det = findEl(appH.tree, byType("MockDetail"));
  check(det && det.props.i === 3, "詳細を開く");
  det.props.onStep(1); appH.rerender();
  check(findEl(appH.tree, byType("MockDetail")).props.i === 4, "次の問題へ");
  findEl(appH.tree, byType("MockDetail")).props.onStep(-1); appH.rerender();
  check(findEl(appH.tree, byType("MockDetail")).props.i === 3, "前の問題へ");

  // --- MockExamScreen: あとで解く ---
  const QUESTIONS = require(path.join(ROOT, "data", "questions.json"));
  const qs = QUESTIONS.slice(0, 5);
  const persisted = [];
  const ex = mount(React, app.MockExamScreen, {
    init: { qs, ids: qs.map((q) => q.id), orders: qs.map(() => [0, 1, 2, 3]), answers: qs.map(() => null), flags: qs.map(() => false), idx: 0, elapsedMs: 0, startedAt: 1, repaired: 0 },
    saveFailed: false, onPersist: (x) => persisted.push(x), onSuspend() {}, onSubmit() {},
  });
  findEl(ex.tree, buttonWith("あとで")).props.onClick();
  ex.rerender();
  let last = persisted[persisted.length - 1];
  check(last.flags[0] === true && last.idx === 1, "「あとで」で印が付き、次の問題へ進む（保存も flags 付き）");
  findEl(ex.tree, buttonWith("前へ")).props.onClick(); ex.rerender();
  findEl(ex.tree, buttonWith("印を外す")).props.onClick(); ex.rerender();
  last = persisted[persisted.length - 1];
  check(last.flags[0] === false && last.idx === 0, "「印を外す」は移動しない");
  findEl(ex.tree, buttonWith("あとで")).props.onClick(); ex.rerender();
  findEl(ex.tree, buttonWith("次へ")).props.onClick(); ex.rerender();
  findEl(ex.tree, buttonWith("次へ")).props.onClick(); ex.rerender();
  findEl(ex.tree, buttonWith("次へ")).props.onClick(); ex.rerender();   // 印で idx=1 → 最終問 idx=4
  findEl(ex.tree, buttonWith("あとで")).props.onClick(); ex.rerender();
  last = persisted[persisted.length - 1];
  check(last.flags[4] === true && last.idx === 4, "最終問では印だけ付けて留まる");
  findEl(ex.tree, buttonWith("採点する")).props.onClick(); ex.rerender();
  const lists = [];
  walk(ex.tree, (n) => { if (byType("MockJumpList")(n)) lists.push(n.props); });
  const flaggedList = lists.find((l) => l.title.includes("あとで"));
  check(flaggedList && flaggedList.items.join(",") === "0,4", "採点前の一覧に「あとで解く」の問題が並ぶ");
  check(lists.find((l) => l.title === "未回答").items.length === 5, "採点前の一覧に未回答の問題が並ぶ");
  flaggedList.onJump(0); ex.rerender();
  check(persisted[persisted.length - 1].idx === 0, "一覧をタップするとその問題へ移動する");

  // --- バックアップ：科目Bの3キーが入る／v1（科目B統合前）のファイルも読める ---
  // キー名は文字列で書く（アプリ側の定数を使うと、キー名を書き換えても検査が素通りする）
  const A_KEYS = ["fe-exam-srs-v1", "it-abbr-srs-v1", "fe-exam-mock-v1"];
  const B_KEYS = ["fe-exam-b-srs-v1", "fe-exam-b-trace-v1", "fe-exam-b-prefs-v1"];
  const card = { history: [], interval: 1, easeFactor: 2.5, dueDate: "2026-01-15", reps: 1, lapses: 0 };
  const fill = (tag) => ({
    "fe-exam-srs-v1": { [`2013A-0${tag}`]: card }, "it-abbr-srs-v1": { [`A-${tag}`]: card, [`A-${tag}0`]: card },
    "fe-exam-mock-v1": { v: 1, runs: [{ tag }] },
    "fe-exam-b-srs-v1": { [`B-R05-0${tag}`]: card, [`B-R06-0${tag}`]: card, [`B-R07-0${tag}`]: card },
    "fe-exam-b-trace-v1": { [`B-R05-0${tag}`]: { ms: Number(tag) } }, "fe-exam-b-prefs-v1": { timer: false, split: 0.5 },
  });
  const setAll = (o) => { for (const k of Object.keys(store)) delete store[k]; for (const [k, v] of Object.entries(o)) store[k] = JSON.stringify(v); };
  const snapAll = () => JSON.stringify(Object.fromEntries([...A_KEYS, ...B_KEYS].map((k) => [k, store[k] ?? null])));
  setAll(fill("1"));
  const bk = app.buildBackup();
  check(bk.version === 2, "バックアップの version は 2");
  check([...A_KEYS, ...B_KEYS].every((k) => JSON.stringify(bk.stores[k]) === store[k]), "バックアップに科目Bの3キー（学習カード・記録・設定）と既存3キーが入る");
  const confirms = [];
  global.window.confirm = (m) => { confirms.push(m); return true; };
  global.window.location = { reload() {} };
  const restore = async (data) => {
    const br = mount(React, app.BackupRestore, {});
    let input = null;
    walk(br.tree, (n) => { if (n.type === "input" && n.props.type === "file") input = n; });
    await input.props.onChange({ target: { value: "x", files: [{ text: async () => JSON.stringify(data) }] } });
  };
  setAll({}); await restore(bk);
  check(snapAll() === JSON.stringify(Object.fromEntries([...A_KEYS, ...B_KEYS].map((k) => [k, JSON.stringify(bk.stores[k])]))), "v2 の復元で6キーすべてが戻る");
  check(confirms[confirms.length - 1].includes("6件の学習履歴と模試1回分"), "復元の確認に科目Bのカードも件数に入る（過去問1＋英略語2＋科目B3）");
  const v1 = { app: bk.app, version: 1, exportedAt: "2026-01-01T00:00:00.000Z", stores: Object.fromEntries(A_KEYS.map((k) => [k, fill("2")[k]])) };
  setAll(fill("3")); await restore(v1);
  check(A_KEYS.every((k) => store[k] === JSON.stringify(fill("2")[k])), "v1（科目B統合前）のファイルを復元すると既存3キーが戻る");
  check(B_KEYS.every((k) => store[k] === JSON.stringify(fill("3")[k])), "v1 のファイルを復元しても科目Bの学習データは消えない");

  console.log(fails ? `\n${fails}件失敗` : "\nすべてOK");
  if (fails) process.exit(1);
}

// ===== --snapshot: リファクタの前後で出力が1バイトも変わらないことを全件で確かめる =====
// 描画（HTML）は SHA-256、純関数は値そのもの（差が出たときに何が変わったか読めるように）を記録する。
// 乱数・時計・localStorage を固定し、項目ごとに乱数の種をキーから作り直すので、
// 同じコードなら何度採っても同じ。項目を足し引きしても他の項目の結果はずれない。

const SNAP_NOW = Date.parse("2026-01-15T12:00:00Z");   // todayStr() は UTC で "2026-01-15"

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function installDeterminism() {
  const real = { random: Math.random, Date: globalThis.Date, localStorage: global.localStorage, window: global.window };
  const RealDate = real.Date;
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(SNAP_NOW); else super(...a); }
    static now() { return SNAP_NOW; }
  }
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;
  let store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
  global.window = { confirm: () => true, alert() {}, scrollTo() {}, addEventListener() {}, removeEventListener() {}, localStorage: global.localStorage };
  return {
    // 項目ごとに乱数の種と保存領域を作り直す
    reset(key, storage) { Math.random = mulberry32(fnv1a(key)); store = { ...(storage || {}) }; },
    restore() {
      Math.random = real.random; globalThis.Date = real.Date;
      global.localStorage = real.localStorage; global.window = real.window;
    },
  };
}

// 学習状態の見本。約1/7ずつ「今日が期日」「定着」「学習中」、残りは未学習にしてばらつかせる
function srsFixture(items, keyOf) {
  const states = {};
  items.forEach((it, i) => {
    const k = i % 7;
    if (k > 2) return;
    const history = [{ date: `2026-01-0${1 + (i % 9)}`, ts: SNAP_NOW - (i + 1) * 3600e3, quality: i % 3, correct: i % 3 !== 0 }];
    const base = { history, lapses: k === 0 ? 1 : 0 };
    if (k === 0) states[keyOf(it)] = { ...base, interval: 1, easeFactor: 2.3, dueDate: "2026-01-15", reps: 1, lastResult: "incorrect" };
    if (k === 1) states[keyOf(it)] = { ...base, interval: 30, easeFactor: 2.7, dueDate: "2026-02-14", reps: 4, lastResult: "correct" };
    if (k === 2) states[keyOf(it)] = { ...base, interval: 3, easeFactor: 2.5, dueDate: "2026-01-18", reps: 2, lastResult: "correct" };
  });
  return states;
}

async function snapshot(app, outPath) {
  const QUESTIONS = require(path.join(ROOT, "data", "questions.json"));
  const ABBRS = require(path.join(ROOT, "data", "abbr.json"));
  const det = installDeterminism();
  const items = {};
  const errors = [];
  const noop = () => {};
  const sha = (str) => createHash("sha256").update(str).digest("hex");
  const guard = (key, f) => {
    try { items[key] = f(); }
    catch (e) { items[key] = `!error: ${e.message}`; errors.push(`${key}: ${e.message}`); }
  };
  const html = (key, el, storage) => guard(key, () => { det.reset(key, storage); return sha(render(el)); });
  const val = (key, f, storage) => guard(key, () => { det.reset(key, storage); return f(); });
  const h = React.createElement;
  // KaTeX の strict 警告や loadData の失敗ログで出力が埋もれないよう、実行中の警告は件数だけ数える
  const realConsole = { warn: console.warn, error: console.error };
  const warns = new Map();
  const tally = (...a) => { const m = String(a[0]).split("\n")[0].replace(/"[^"]*"/g, '"…"').slice(0, 90); warns.set(m, (warns.get(m) || 0) + 1); };
  console.warn = tally;
  console.error = tally;

  try {
    // ① 過去問の詳細画面（全件・解答を開いた状態）
    for (const q of QUESTIONS) {
      html(`QD:${q.id}`, h(app.QuestionDetail, { q, selected: null, revealStart: true, onBack: noop }));
    }

    // ② 出題画面（全件・回答済み・解説を展開）。表示順は makeChoiceOrder がキー固定の乱数で決める
    for (const q of QUESTIONS) {
      const key = `SS:${q.id}`;
      guard(key, () => {
        det.reset(key);
        const order = app.makeChoiceOrder(q);
        items[`fn:makeChoiceOrder:${q.id}`] = order;
        det.reset(key);
        // SessionScreen の useState 呼び出し順: idx, selected, answered, log, shuffledOrder, showFull
        return sha(withForcedHooks(
          React,
          new Map([[0, 0], [1, order.indexOf(q.answer)], [2, true], [3, []], [4, order], [5, true]]),
          () => render(h(app.SessionScreen, { questions: [q], onFinish: noop, onQuit: noop, updateCard: noop }))
        ));
      });
    }

    // ③ 英略語の出題画面（全件・回答済み）。画面内の useMemo が同じ選択肢を作るよう、描画の直前にも種を戻す
    for (const card of ABBRS) {
      const key = `AB:${card.id}`;
      guard(key, () => {
        det.reset(key);
        const quiz = app.buildAbbrChoices(card);
        items[`fn:buildAbbrChoices:${card.id}`] = { ids: quiz.choices.map((c) => c.id), answer: quiz.answer };
        det.reset(key);
        return sha(withForcedHooks(
          React,
          new Map([[0, 0], [1, quiz.answer], [2, true], [3, []]]),
          () => render(h(app.AbbrQuizScreen, { cards: [card], onFinish: noop, onQuit: noop, updateCard: noop }))
        ));
      });
    }

    // ④ 主要画面。学習状態の見本を与える
    const qStates = srsFixture(QUESTIONS, (q) => q.id);
    const aStates = srsFixture(ABBRS, (a) => a.id);
    const storage = { "fe-exam-srs-v1": JSON.stringify(qStates), "it-abbr-srs-v1": JSON.stringify(aStates) };
    html("SC:App", h(app.App), storage);
    html("SC:App-empty", h(app.App));
    html("SC:QuestionList", h(app.QuestionList, { states: qStates, onOpen: noop, onBack: noop }));
    html("SC:SetupScreen", h(app.SetupScreen, { states: qStates, newQuestions: QUESTIONS.filter((q) => !qStates[q.id]), onStart: noop, onBack: noop }));
    html("SC:StatsScreen", h(app.StatsScreen, { states: qStates, onBack: noop, onReset: noop }));
    html("SC:StatsScreen-empty", h(app.StatsScreen, { states: {}, onBack: noop, onReset: noop }));
    const log = QUESTIONS.slice(0, 12).map((q, i) => ({
      q, selected: i % 3 === 0 ? q.answer : (q.answer + 1) % 4, correct: i % 3 === 0, quality: i % 3,
    }));
    html("SC:ResultScreen", h(app.ResultScreen, { log, onHome: noop, onOpen: noop }));
    html("SC:AbbrList", h(app.AbbrList, { states: aStates, onBack: noop }));
    html("SC:AbbrSetup", h(app.AbbrSetup, { states: aStates, newAbbrs: ABBRS.filter((a) => !aStates[a.id]), onStart: noop, onBack: noop }));
    html("SC:AbbrStats", h(app.AbbrStats, { states: aStates, onBack: noop, onReset: noop }));

    // 模試：出題・採点は乱数と時計を固定したうえでアプリ自身の関数で作る
    let p = null, run = null;
    val("fn:newMockProgress", () => (p = app.newMockProgress([])));
    if (p) {
      const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
      const answers = p.ids.map((id, i) => (i % 3 === 0 ? byId.get(id).answer : i % 3 === 1 ? (byId.get(id).answer + 1) % 4 : null));
      val("fn:gradeMock", () => (run = app.gradeMock(p, answers, 1234567)));
    }
    if (p && run) {
      html("SC:MockHome", h(app.MockHome, { progress: p, runs: [run], notice: null, saveFailed: false, onStart: noop, onResume: noop, onDiscard: noop, onHistory: noop }));
      html("SC:MockHome-empty", h(app.MockHome, { progress: null, runs: [], notice: null, saveFailed: false, onStart: noop, onResume: noop, onDiscard: noop, onHistory: noop }));
      html("SC:MockScore-fresh", h(app.MockScore, { run, isFresh: true, histFailed: false, onRate: noop, onOpen: noop, onBack: noop }));
      html("SC:MockScore-history", h(app.MockScore, { run, isFresh: false, histFailed: false, onRate: null, onOpen: noop, onBack: noop }));
      html("SC:MockHistoryScreen", h(app.MockHistoryScreen, { runs: [run], onOpen: noop, onBack: noop }));
      const q0 = QUESTIONS.find((q) => q.id === run.ids[0]);
      html("SC:MockDetail", h(app.MockDetail, { i: 0, total: run.ids.length, rating: 2, onRate: noop, onStep: noop },
        h(app.QuestionDetail, { q: q0, selected: run.answers[0], revealStart: true, onBack: noop })));
    }
    const qs5 = QUESTIONS.slice(0, 5);
    html("SC:MockExamScreen", h(app.MockExamScreen, {
      init: { qs: qs5, ids: qs5.map((q) => q.id), orders: qs5.map(() => [0, 1, 2, 3]), answers: [0, null, 2, null, 1],
        flags: [false, true, false, false, true], idx: 1, elapsedMs: 3754000, startedAt: SNAP_NOW, repaired: 0 },
      saveFailed: false, onPersist: noop, onSuspend: noop, onSubmit: noop,
    }));

    // ⑤ 純関数（値そのもの）
    val("fn:initCard", () => app.initCard());
    const bases = [
      app.initCard(),
      { interval: 1, easeFactor: 2.5, dueDate: "2026-01-15", reps: 1, lapses: 0, history: [], lastResult: "correct" },
      { interval: 4, easeFactor: 2.6, dueDate: "2026-01-15", reps: 2, lapses: 0, history: [], lastResult: "correct" },
      { interval: 10, easeFactor: 1.3, dueDate: "2026-01-15", reps: 3, lapses: 4, history: [], lastResult: "incorrect" },
      { interval: 60, easeFactor: 3.0, dueDate: "2026-01-15", reps: 5, lapses: 1, history: [], lastResult: "correct" },
      { interval: 170, easeFactor: 2.8, dueDate: "2026-01-15", reps: 8, lapses: 0, history: [], lastResult: "correct" },
    ];
    val("fn:reviewCard", () => bases.flatMap((b) => [0, 1, 2].flatMap((qual) =>
      [true, false, undefined].map((c) => app.reviewCard(b, qual, c)))));
    val("fn:fmtMs", () => [0, 999, 1000, 59000, 59999, 60000, 599000, 3599000, 3600000, 3661000, 36000000].map(app.fmtMs));
    val("fn:histCorrect", () => [{ quality: 0 }, { quality: 1 }, { quality: 2 }, { quality: 2, correct: false }, { quality: 0, correct: true }].map(app.histCorrect));
    val("fn:isSymbolOnlyChoices", () => QUESTIONS.filter(app.isSymbolOnlyChoices).map((q) => q.id));
    val("fn:getExplanationSummary", () => Object.fromEntries(QUESTIONS.map((q) => [q.id, app.getExplanationSummary(q.explanation || "")])));
    const rev = { "ア": "エ", "イ": "ウ", "ウ": "イ", "エ": "ア" };
    val("fn:remapLabels", () => Object.fromEntries(QUESTIONS.map((q) => [q.id, sha(app.remapLabels(q.explanation || "", rev))])));
    val("fn:plainPreview", () => Object.fromEntries(QUESTIONS.map((q) => [q.id, sha(app.plainPreview(q.question))])));
    val("fn:mockNormKey", () => Object.fromEntries(QUESTIONS.map((q) => [q.id, app.mockNormKey(q)])));
    val("fn:mockPool", () => JSON.parse(JSON.stringify(app.mockPool(), (k, v) => (v && typeof v === "object" && v.id && v.choices ? v.id : v))));
    val("fn:abbrSimilarity", () => {
      const s = ABBRS.slice(0, 25);
      return s.flatMap((a) => s.map((b) => Math.round(app.abbrSimilarity(a, b) * 1e9) / 1e9));
    });
    val("fn:loadData-saveData", () => {
      app.saveData("k", { a: 1 });
      localStorage.setItem("broken", "{");
      return [app.loadData("k"), app.loadData("broken"), app.loadData("none")];
    });
  } finally {
    det.restore();
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  }

  const keys = Object.keys(items).sort();
  const counts = {};
  keys.forEach((k) => { const pfx = k.split(":")[0]; counts[pfx] = (counts[pfx] || 0) + 1; });
  const out = { counts, errors: errors.length, items: Object.fromEntries(keys.map((k) => [k, items[k]])) };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
  console.log(`スナップショット ${keys.length}項目 → ${outPath}`);
  console.log("  内訳:", Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / "));
  if (warns.size) {
    console.log("  実行中の警告（件数。スナップショットの比較には影響しない）:");
    [...warns].sort((a, b) => b[1] - a[1]).forEach(([m, n]) => console.log(`   ${String(n).padStart(4)}  ${m}`));
  }
  if (errors.length) {
    console.log(`  描画・実行エラー ${errors.length}件:`);
    errors.slice(0, 20).forEach((e) => console.log("   - " + e));
  }
}

function snapshotDiff(aPath, bPath) {
  const A = JSON.parse(fs.readFileSync(aPath, "utf8")).items;
  const B = JSON.parse(fs.readFileSync(bPath, "utf8")).items;
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const added = [], removed = [], changed = [];
  for (const k of keys) {
    if (!(k in A)) added.push(k);
    else if (!(k in B)) removed.push(k);
    else if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) changed.push(k);
  }
  // 値で記録した項目は、どこが違うかを1か所だけ示す
  const where = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      const i = a.findIndex((x, j) => JSON.stringify(x) !== JSON.stringify(b[j]));
      return i < 0 ? `長さ ${a.length}→${b.length}` : `[${i}] ${JSON.stringify(a[i]).slice(0, 80)} → ${JSON.stringify(b[i]).slice(0, 80)}`;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const k = [...new Set([...Object.keys(a), ...Object.keys(b)])].find((x) => JSON.stringify(a[x]) !== JSON.stringify(b[x]));
      return `.${k}: ${JSON.stringify(a[k]).slice(0, 80)} → ${JSON.stringify(b[k]).slice(0, 80)}`;
    }
    return typeof a === "string" && a.length === 64 ? "描画が変わった" : `${JSON.stringify(a).slice(0, 80)} → ${JSON.stringify(b).slice(0, 80)}`;
  };
  const total = added.length + removed.length + changed.length;
  console.log(`比較 ${keys.length}項目: 変更 ${changed.length} / 追加 ${added.length} / 削除 ${removed.length}`);
  if (changed.length) {
    const by = {};
    changed.forEach((k) => { const p = k.split(":")[0]; by[p] = (by[p] || 0) + 1; });
    console.log("  変更の内訳:", Object.entries(by).map(([k, v]) => `${k} ${v}`).join(" / "));
    changed.slice(0, 40).forEach((k) => console.log(`   ~ ${k}  ${where(A[k], B[k])}`));
    if (changed.length > 40) console.log(`   …ほか ${changed.length - 40}件`);
  }
  added.slice(0, 20).forEach((k) => console.log(`   + ${k}`));
  removed.slice(0, 20).forEach((k) => console.log(`   - ${k}`));
  console.log(total ? `\n差分あり（${total}件）` : "\n差分なし");
  if (total) process.exit(1);
}

// ===== --snapshot-b: 科目B（subject-b）の全件スナップショット =====
// 入口は subject-b/app.jsx（Phase 2 以降は kamokub.jsx を取り込む薄い入口）。名前はバンドルの中から拾う。
const KAMOKUB_ENTRY = path.join(ROOT, "subject-b", "app.jsx");
const KAMOKUB_EXPORTS = [
  "App", "BSession", "BDetail", "BList", "BStats", "BSetup", "BResult", "BHome", "Modal", "TraceTable",
  // 科目Bの RichText は表を横スクロールで描く。載せ替え後は ui-common の RichText を包んだ BRichText。
  // 載せ替え前のファイルには BRichText が無く、ファイル内の RichText がそれに当たる
  "?BRichText", "RichText", "REF_TEXT", "plainPreview", "buildFilled", "expandColumns", "expectedRows",
  "initTrace", "traceReducer", "countCorrections", "fmtMs", "statusOf",
];

async function snapshotB(app, outPath) {
  const QS = require(path.join(ROOT, "data", "kamokub.json"));
  const PG = require(path.join(ROOT, "data", "kamokub_programs.json"));
  const det = installDeterminism();
  const items = {}, errors = [];
  const noop = () => {};
  const sha = (str) => createHash("sha256").update(str).digest("hex");
  const h = React.createElement;
  const realConsole = { warn: console.warn, error: console.error };
  const warns = new Map();
  const tally = (...a) => { const m = String(a[0]).split("\n")[0].replace(/"[^"]*"/g, '"…"').slice(0, 90); warns.set(m, (warns.get(m) || 0) + 1); };
  console.warn = tally; console.error = tally;
  const guard = (key, f) => {
    try { items[key] = f(); } catch (e) { items[key] = `!error: ${e.message}`; errors.push(`${key}: ${e.message}`); }
  };
  const html = (key, el, storage) => guard(key, () => { det.reset(key, storage); return sha(render(el)); });
  const val = (key, f) => guard(key, () => { det.reset(key); return f(); });
  const prefs = { timer: true, split: 0.58 };

  try {
    for (const q of QS) {
      html(`BD:${q.id}`, h(app.BDetail, { q, onBack: noop }));
      // BSession の useState 呼び出し順:
      // idx, selected, answered, log, topTab, bottomTab, expTab, showFull, showRef, viewer, toast, draft
      const wrong = (q.answer + 1) % q.choices.length;
      const states = {
        "q-trace":   [0, null, false, [], "q", "trace", "model", false, false, null, null, ""],
        "prog-trace":[0, null, false, [], "p", "trace", "model", false, false, null, null, ""],
        "choices":   [0, null, false, [], "q", "choices", "model", false, false, null, null, ""],
        "ok-model":  [0, q.answer, true, [], "q", "explain", "model", true, false, null, null, ""],
        "ng-mine":   [0, wrong, true, [], "p", "explain", "mine", true, false, null, null, ""],
      };
      for (const [name, vals] of Object.entries(states)) {
        const key = `BS:${q.id}:${name}`;
        guard(key, () => {
          det.reset(key);
          return sha(withForcedHooks(React, new Map(vals.map((v, i) => [i, v])),
            () => render(h(app.BSession, { questions: [q], prefs, setPrefs: noop, onFinish: noop, onQuit: noop, updateCard: noop }))));
        });
      }
      val(`fn:plainPreview:${q.id}`, () => sha(app.plainPreview(q.question)));
      val(`fn:buildFilled:${q.id}`, () => q.choices.map((_, i) => app.buildFilled(q, i)));
    }

    // トレース表：初期化→入力→確定→訂正→削除までの状態遷移と、その描画
    for (const [pid, prog] of Object.entries(PG)) {
      const tr = prog.trace;
      if (!tr) continue;
      const key = `TR:${pid}`;
      guard(key, () => {
        det.reset(key);
        const cols = app.expandColumns(tr.columns || []);
        const c0 = cols[0] ? cols[0].key : "x";
        let st = app.initTrace(tr);
        const R = (a) => (st = app.traceReducer(st, a));
        const open = () => st.rows.find((r) => !r.locked);
        const line = (prog.lines[1] || prog.lines[0] || { n: 1 }).n;
        R({ type: "FOCUS", rowId: open().id, col: c0 });
        R({ type: "SET_STEP", rowId: open().id, value: line });
        R({ type: "SET_CELL", rowId: open().id, col: c0, value: "1" });
        R({ type: "SET_CELL", rowId: open().id, col: c0, value: "2" });       // 未確定なので上書き
        const locked = open().id;
        R({ type: "COMMIT" });
        R({ type: "SET_CELL", rowId: locked, col: c0, value: "3" });          // 確定済みなので訂正として積む
        R({ type: "SET_CELL", rowId: locked, col: c0, value: "3" });          // 同じ値は積まない
        R({ type: "BLUR" });
        const extra = open().id;
        R({ type: "DELETE_ROW", rowId: extra });
        const out = { cols, rows: st.rows, corrections: app.countCorrections(st.rows) };
        items[`TRH:${pid}`] = sha(render(h(app.TraceTable, { columns: tr.columns, rows: st.rows, mode: "edit", activeCell: null, onCellTap: noop, onStepTap: noop })));
        if (tr.expected) items[`TRX:${pid}`] = app.expectedRows(tr.expected);
        return out;
      });
    }

    // 主要画面（学習状態の見本つき）
    const st = srsFixture(QS, (q) => q.id);
    const storage = { "fe-exam-b-srs-v1": JSON.stringify(st) };
    html("SB:App", h(app.App), storage);
    html("SB:App-empty", h(app.App));
    html("SB:BHome", h(app.BHome, { states: st, prefs, setPrefs: noop, dueCount: 3, newCount: 20, onReview: noop, onSetup: noop, onList: noop, onStats: noop, onRef: noop }));
    html("SB:BSetup", h(app.BSetup, { states: st, onStart: noop, onBack: noop }));
    html("SB:BList", h(app.BList, { states: st, onOpen: noop, onBack: noop }));
    html("SB:BStats", h(app.BStats, { states: st, onBack: noop, onReset: noop }), storage);
    html("SB:BStats-empty", h(app.BStats, { states: {}, onBack: noop, onReset: noop }));
    const log = QS.slice(0, 8).map((q, i) => ({ q, selected: i % 2 ? (q.answer + 1) % q.choices.length : q.answer, correct: i % 2 === 0, quality: i % 3, ms: 61000 * (i + 1) }));
    html("SB:BResult", h(app.BResult, { log, onHome: noop, onOpen: noop }));
    html("SB:Ref", h(app.Modal, { title: "擬似言語の記述形式", onClose: noop }, h(app.BRichText || app.RichText, { text: app.REF_TEXT, style: { fontSize: 13 } })));
    val("fn:fmtMs", () => [0, 999, 59000, 60000, 599000, 3599000].map(app.fmtMs));
    val("fn:statusOf", () => QS.map((q) => app.statusOf(st, q)));
  } finally {
    det.restore();
    console.warn = realConsole.warn; console.error = realConsole.error;
  }

  const keys = Object.keys(items).sort();
  const counts = {};
  keys.forEach((k) => { const pfx = k.split(":")[0]; counts[pfx] = (counts[pfx] || 0) + 1; });
  fs.writeFileSync(outPath, JSON.stringify({ counts, errors: errors.length, items: Object.fromEntries(keys.map((k) => [k, items[k]])) }, null, 1) + "\n");
  console.log(`科目B スナップショット ${keys.length}項目 → ${outPath}`);
  console.log("  内訳:", Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / "));
  if (warns.size) [...warns].sort((a, b) => b[1] - a[1]).forEach(([m, n]) => console.log(`   警告 ${String(n).padStart(4)}  ${m}`));
  if (errors.length) { console.log(`  描画・実行エラー ${errors.length}件:`); errors.slice(0, 20).forEach((e) => console.log("   - " + e)); }
}

async function main() {
  const args = process.argv.slice(2);
  // 比較はバンドル不要なので先に分岐する
  if (args[0] === "--snapshot-diff") {
    if (args.length !== 3) { console.error("使い方: --snapshot-diff <a.json> <b.json>"); process.exit(2); }
    snapshotDiff(args[1], args[2]);
    return;
  }
  if (args[0] === "--b-session") {
    // 科目Bの出題画面を「解答済み・解説を展開」で1問ずつ描く（--snapshot-b の差分の中身を見るため）
    // node tools/render_check.mjs --b-session B-R05-01 [ok|ng]
    const appB = await loadApp(KAMOKUB_ENTRY, KAMOKUB_EXPORTS);
    const QS = require(path.join(ROOT, "data", "kamokub.json"));
    const q = QS.find((x) => x.id === args[1]);
    if (!q) { console.error(`# ${args[1]}: 見つかりません`); return; }
    const ok = args[2] !== "ng";
    const det = installDeterminism(); det.reset(`BS:${q.id}`);
    const sel = ok ? q.answer : (q.answer + 1) % q.choices.length;
    const vals = [0, sel, true, [], ok ? "q" : "p", "explain", ok ? "model" : "mine", true, false, null, null, ""];
    try {
      console.log(withForcedHooks(React, new Map(vals.map((v, i) => [i, v])), () => render(React.createElement(appB.BSession,
        { questions: [q], prefs: { timer: true, split: 0.58 }, setPrefs() {}, onFinish() {}, onQuit() {}, updateCard() {} }))));
    } finally { det.restore(); }
    return;
  }
  if (args[0] === "--snapshot-b") {
    if (!args[1]) { console.error("使い方: --snapshot-b <out.json>"); process.exit(2); }
    const appB = await loadApp(KAMOKUB_ENTRY, KAMOKUB_EXPORTS);
    await snapshotB(appB, args[1]);
    return;
  }
  const app = await loadApp();
  if (args[0] === "--snapshot") {
    if (!args[1]) { console.error("使い方: --snapshot <out.json>"); process.exit(2); }
    await snapshot(app, args[1]);
    return;
  }

  if (args.length === 0 || args[0] === "--list") {
    console.log("使える名前:", Object.keys(app).join(", "));
    console.log("\n使い方:");
    console.log("  node tools/render_check.mjs <過去問id> [id...]   QuestionDetail(revealStart=true)");
    console.log("  node tools/render_check.mjs --abbr <英略語id> [id...]  AbbrQuizScreen(回答済み状態)");
    return;
  }

  if (args[0] === "--behavior") { await behavior(app); return; }

  if (args[0] === "--session") {
    const QUESTIONS = require(path.join(ROOT, "data", "questions.json"));
    const id = args[1];
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q) { console.error(`# ${id}: 見つかりません`); return; }
    const order = (args[2] || "3,2,1,0").split(",").map(Number);
    // SessionScreen の useState 呼び出し順: idx, selected, answered, log, shuffledOrder, showFull
    const html = withForcedHooks(
      React,
      new Map([[0, 0], [1, order.indexOf(q.answer)], [2, true], [3, []], [4, order], [5, true]]),
      () => render(React.createElement(app.SessionScreen, {
        questions: [q], onFinish() {}, onQuit() {}, updateCard() {},
      }))
    );
    console.log(`\n===== ${id} (表示順 ${order.join(",")} / 正解の元index ${q.answer}) =====`);
    console.log(html);
    return;
  }

  if (args[0] === "--abbr") {
    const QUESTIONS_ABBR = require(path.join(ROOT, "data", "abbr.json"));
    for (const idStr of args.slice(1)) {
      const id = Number(idStr);
      const card = QUESTIONS_ABBR.find((x) => x.id === id);
      if (!card) {
        console.error(`# 英略語 ${idStr}: 見つかりません`);
        continue;
      }
      const quiz = app.buildAbbrChoices(card);
      console.log(`\n===== abbr ${id} (${card.abbr}) =====`);
      const html = withForcedHooks(
        React,
        new Map([[0, 0], [1, quiz.answer], [2, true], [3, []]]),
        () => render(React.createElement(app.AbbrQuizScreen, {
          cards: [card], onFinish() {}, onQuit() {}, updateCard() {},
        }))
      );
      console.log(html);
    }
    return;
  }

  const QUESTIONS = require(path.join(ROOT, "data", "questions.json"));
  for (const id of args) {
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q) {
      console.error(`# ${id}: 見つかりません`);
      continue;
    }
    console.log(`\n===== ${id} =====`);
    console.log(render(React.createElement(app.QuestionDetail, {
      q, selected: null, revealStart: true, onBack() {},
    })));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
