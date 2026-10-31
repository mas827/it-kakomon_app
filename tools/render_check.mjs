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
