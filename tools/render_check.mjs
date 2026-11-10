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
//   node tools/render_check.mjs --list                   使える主要コンポーネント名を表示
//
// 出力は生のHTML（stdout）。grepや文字列includesで確認する。例:
//   node tools/render_check.mjs 2012A-03 | grep -c '<table'
//
// 内部で esbuild を都度呼ぶ（react/react-dom は external 化してNode側のreactと共有する。
// 同梱すると2つのReactインスタンスが混在し "Invalid hook call" になるので外さないこと）。

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
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

async function loadApp() {
  const EXPORTS = [
    "QuestionDetail", "QuestionList", "ResultScreen", "HomeScreen", "QuizApp",
    "AbbrQuizScreen", "AbbrHome", "AbbrList", "buildAbbrChoices",
    "SessionScreen", "orderExplanation",
    "MockApp", "MockExamScreen", "MockScore",
  ];
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["react", "react-dom", "react-dom/client"],
    footer: { js: `module.exports.__rc = {${EXPORTS.join(",")}};` },
  });
  const code = stripMount(result.outputFiles[0].text);
  const mod = { exports: {} };
  const fn = new Function("module", "exports", "require", "__dirname", code);
  global.document = global.document || { getElementById: () => null };
  fn(mod, mod.exports, require, ROOT);
  return mod.exports.__rc;
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

  console.log(fails ? `\n${fails}件失敗` : "\nすべてOK");
  if (fails) process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const app = await loadApp();

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
