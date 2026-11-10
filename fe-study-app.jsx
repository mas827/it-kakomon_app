import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import QUESTIONS from "./data/questions.json";
import ABBRS from "./data/abbr.json";
import CALC_IDS_RAW from "./data/calc_ids.json";
import { C, mono, sans, cardBtn, GlobalStyle, loadJSON, saveJSON, DAY_MS, todayStr, addDays,
  initCard, reviewCard, useCardStates, histCorrect, useTimer, fmtMs, shuffle, LIST_PAGE, RichText,
  plainPreview, Stat, Section, Toggle, RateBtn, SummaryCard, TopBar } from "./ui-common.jsx";

// 計算問題（数値計算で解答する問題）のid集合。判定基準は tools/mark_calc.py が一次情報。
// 基準を変えたら mark_calc.py --apply で再生成するだけで、ここは自動的に追従する。
const CALC_IDS = new Set(CALC_IDS_RAW.ids);

const CATEGORIES = ["基礎理論", "アルゴリズム", "コンピュータ構成", "ソフトウェア", "データベース", "ネットワーク", "セキュリティ", "マネジメント", "ストラテジ"];

// 英略語の分野（過去問とは別体系。data/abbr.json の category に対応）
const ABBR_CATEGORIES = ["基礎理論", "コンピュータシステム", "開発技術", "プロジェクトマネジメント",
  "サービスマネジメント", "システム戦略", "経営戦略", "企業と法務", "ネットワーク", "セキュリティ"];

const SETS = ["2009年秋期", "2010年秋期", "2011年秋期", "2012年秋期", "2013年秋期",
  "2014年秋期", "2015年春期", "2015年秋期",
  "2016年春期", "2016年秋期", "2017年春期", "2017年秋期",
  "2018年春期", "2018年秋期", "2019年春期", "2019年秋期"];

// ===== 永続化（localStorage） =====
// スマホ/PCのブラウザに学習データを保存。リロードしても保持される。
// 過去問と英略語は別々のキーに保存し、互いに影響しないようにする。
// ※ 英略語側のキーは英略語暗記アプリ（it-anki_app）と同じものを使っているため、
//    同一オリジンで公開していれば既存の暗記進捗がそのまま引き継がれる。
const STORAGE_KEY = "fe-exam-srs-v1";
const ABBR_STORAGE_KEY = "it-abbr-srs-v1";
// 模試モード。採点時に既定の理解度で過去問モードの学習履歴(STORAGE_KEY)へ登録する（→ MockApp.submit）。
// 進行中は1件だけ（中断再開用）。完了した模試は履歴として新しい順に残す。
const MOCK_STORAGE_KEY = "fe-exam-mock-v1";
const MOCK_PROGRESS_KEY = "fe-exam-mock-progress-v1";
const MOCK_HISTORY_MAX = 50;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 選択肢が「ア/イ/ウ/エ」のような記号のみの問題は、記号が図や表の項目と対応しているため
// シャッフルすると対応が崩れる。そういう問題は元の順序のまま出題する。
function isSymbolOnlyChoices(q) {
  // 「ア」「イ」「ウ」「エ」だけが並ぶ＝選択肢の中身が図や表側にある問題。
  // 数字だけの選択肢（"5","6"など）は中身のある選択肢なのでシャッフル対象のままにする。
  const labels = ["ア", "イ", "ウ", "エ"];
  return q.choices.every((c, i) => String(c).trim() === labels[i]);
}

function makeChoiceOrder(q) {
  const base = [0, 1, 2, 3];
  return q && isSymbolOnlyChoices(q) ? base : shuffleArray(base);
}

// 選択肢の並びや個数が後から修正されたことを検出するための軽いハッシュ。
// 模試は問題の中身を保存せず id だけを持つ（→ data/questions.json を直せば両モードに反映される）。
// そのぶん、保存済みの「選択肢の表示順」と「選んだ選択肢の番号」だけが古い並びを指したまま
// 残りうるので、これで突き合わせて弾く。
function choicesHash(q) {
  const s = q.choices.join("\u0001");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function getExplanationSummary(text) {
  const sentences = text.split("。");
  let summary = sentences[0] + "。";
  if (summary.length < 40 && sentences.length > 1) {
    summary += sentences[1] + "。";
  }
  if (summary.length > 120) {
    return text.slice(0, 100) + "…";
  }
  return summary;
}

// 解説は選択肢ごとに \n で区切ってある（tools/fix_explanations.py が入れる）。
// 出題時は選択肢をシャッフルするため、データ上の順（ア→イ→ウ→エ）のままだと
// 表示順と食い違って読みにくい。本文を先頭に置き、続けて「正解の解説 → 残りを表示順の昇順」
// に並べ替える。複数の選択肢をまとめて述べるブロック（「ア、イ、ウの値は…」）は
// 先頭の記号で位置を決め、1ブロックのまま動かす。
const CHOICE_BLOCK = /^([アイウエ])(?:[．.、，]|は|が|の|に|について)/;

// 「表（図）の a〜d のどれに該当するか」を問う問題では、選択肢ア〜エが a〜d と1対1で
// 対応する。この種の解説は設問の表と同じ a→b→c→d の順に読めたほうが分かりやすく、
// しかも**シャッフルに左右されない**ので、選択肢の表示順より letter の昇順を優先する。
// 条件は「記号つきブロックが3つ以上あり、どれも a〜d をちょうど1つずつ重複なく参照する」。
// 2011A-01（a,bに入る語句の組合せ）や 2014A-04（逆ポーランド記法の a,b,c,d）のように
// 選択肢と a〜d が対応しない問題は、記号つきブロックが2つしか無いので掛からない。
const LETTER_REF = /(?<![0-9A-Za-z])([a-d])(?![0-9A-Za-z])/;

function isLetterMapping(keyed) {
  const ls = keyed.filter((x) => x.orig >= 0).map((x) => x.letter);
  if (ls.length < 3 || ls.some((l) => l === null)) return false;
  return new Set(ls).size === ls.length;
}

function orderExplanation(text, shuffledOrder, answer) {
  if (!text || !text.includes("\n")) return { lead: text || "", rest: "" };
  const keyed = text.split("\n").map((b) => {
    const m = CHOICE_BLOCK.exec(b);
    const l = LETTER_REF.exec(b);
    return { b, orig: m ? "アイウエ".indexOf(m[1]) : -1, letter: l ? l[1] : null };
  });
  const first = keyed.findIndex((x) => x.orig >= 0);
  if (first < 0) return { lead: text, rest: "" };
  const byLetter = isLetterMapping(keyed);
  const rank = (x) => {
    if (x.orig < 0) return 1e6;                 // 選択肢に紐づかないブロックは末尾へ
    if (byLetter) return x.letter.charCodeAt(0); // a→b→c→d の昇順（表示順に依らない）
    if (x.orig === answer) return -1;           // 正解の解説を先頭に
    return shuffledOrder.indexOf(x.orig);       // 残りは表示順の昇順
  };
  const rest = keyed.slice(first)
    .map((x, i) => ({ ...x, i }))
    .sort((p, q) => (rank(p) - rank(q)) || (p.i - q.i))  // 同順位は元の順を保つ
    .map((x) => x.b);
  return { lead: keyed.slice(0, first).map((x) => x.b).join("\n"), rest: rest.join("\n") };
}

// 選択肢シャッフルに合わせ、解説文中の選択肢ラベル（ア/イ/ウ/エ）を表示順に変換する。
// map は元ラベル→表示ラベルの対応。ソフトウェア。/ハードウェアは 等のカタカナ語末尾の
// ア/イ/ウ/エを誤変換しないよう、直前がカタカナでない（＝単独のラベル）ものだけを対象にし、
// 「選択肢ア」またはラベルの直後が区切り記号・助詞（．.、。）)はがのをとにも等）の場合のみ置換する。
function remapLabels(text, map) {
  if (!text) return text;
  return text.replace(
    /(選択肢)([アイウエ])|(?<![ァ-ヶー])([アイウエ])(?=[．.、。）)はがのをにへとやもだでな])/g,
    (m, pre, l1, l2) => {
      if (l1) return pre + (map[l1] || l1);
      if (l2) return map[l2] || l2;
      return m;
    }
  );
}

const catColor = (cat) => {
  const map = { 基礎理論: C.blue, アルゴリズム: C.purple, コンピュータ構成: "#79c0ff", ソフトウェア: "#56d364", データベース: C.amber, ネットワーク: "#ff7b72", セキュリティ: C.red, マネジメント: "#d2a8ff", ストラテジ: "#7ee787" };
  return map[cat] || C.dim;
};

// ===== メインコンポーネント（タブで2モードを切り替え） =====
export default function App() {
  const [tab, setTab] = useState("quiz");
  // 学習中（過去問の出題中／英略語のカード学習中）はタブバーを隠して集中できるようにする
  const [quizBusy, setQuizBusy] = useState(false);
  const [abbrBusy, setAbbrBusy] = useState(false);
  const [mockBusy, setMockBusy] = useState(false);
  const busy = { quiz: quizBusy, abbr: abbrBusy, mock: mockBusy }[tab];
  // 過去問の学習カードは過去問モードと模試（採点結果を復習に登録）で共有する。
  // 片方が localStorage に直接書くと、もう片方のメモリ上の古い states で上書きされて消えるので、ここで1つだけ持つ
  const [cardStates, updateCard, resetCards, setCards] = useCardStates(STORAGE_KEY);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: sans, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 480, minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
        {/* 両モードとも状態を保持したままにするため、非表示で残す */}
        <div style={{ display: tab === "quiz" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <QuizApp onBusyChange={setQuizBusy} states={cardStates} updateCard={updateCard} resetAll={resetCards} />
        </div>
        <div style={{ display: tab === "abbr" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <AbbrApp onBusyChange={setAbbrBusy} />
        </div>
        <div style={{ display: tab === "mock" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <MockApp onBusyChange={setMockBusy} cardStates={cardStates} setCards={setCards} />
        </div>
        {!busy && <TabBar tab={tab} onChange={setTab} />}
      </div>
      <GlobalStyle />
    </div>
  );
}

function TabBar({ tab, onChange }) {
  const items = [
    { key: "quiz", icon: "📝", label: "過去問" },
    { key: "abbr", icon: "📇", label: "英略語" },
    { key: "mock", icon: "🏁", label: "模試" },
  ];
  return (
    <div style={{
      position: "sticky", bottom: 0, zIndex: 20,
      display: "flex", background: C.panel, borderTop: `1px solid ${C.border}`,
      paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      {items.map((it) => {
        const active = tab === it.key;
        return (
          <button key={it.key} onClick={() => onChange(it.key)}
            style={{
              flex: 1, background: "transparent", border: "none", cursor: "pointer",
              padding: "10px 0 12px", display: "flex", flexDirection: "column",
              alignItems: "center", gap: 3, fontFamily: sans,
              color: active ? C.accent : C.faint,
            }}>
            <span style={{ fontSize: 20, lineHeight: 1, filter: active ? "none" : "grayscale(1)", opacity: active ? 1 : 0.7 }}>{it.icon}</span>
            <span style={{ fontSize: 11, fontWeight: active ? 700 : 400 }}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ===== 過去問モード =====
// 計算問題フィルタ。判定は data/calc_ids.json（tools/mark_calc.py が生成）が一次情報。
// "all"=絞り込まない／"only"=計算問題だけ／"exclude"=計算問題を除く
function filterByCalc(qs, mode) {
  if (mode === "only") return qs.filter((q) => CALC_IDS.has(q.id));
  if (mode === "exclude") return qs.filter((q) => !CALC_IDS.has(q.id));
  return qs;
}

function QuizApp({ onBusyChange, states, updateCard, resetAll }) {
  const [screen, setScreen] = useState("home");
  const [sessionQs, setSessionQs] = useState([]);
  // スキップしたときの差し替え候補。新規の出題では「余った問題」が入り、
  // 今日の復習では空のまま。空かどうかでスキップの動きが決まる（→ SessionScreen）
  const [sessionSpares, setSessionSpares] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);
  const [detail, setDetail] = useState(null);  // { q, selected, revealStart, from }
  const [reviewCalcFilter, setReviewCalcFilter] = useState("all");  // ホームの「今日の復習」用

  useEffect(() => { onBusyChange(screen === "session"); }, [screen, onBusyChange]);

  const dueQuestions = useMemo(() => {
    const today = todayStr();
    return QUESTIONS.filter((q) => {
      const c = states[q.id];
      return c && c.dueDate <= today;
    });
  }, [states]);

  const dueQuestionsFiltered = useMemo(
    () => filterByCalc(dueQuestions, reviewCalcFilter),
    [dueQuestions, reviewCalcFilter]
  );

  const newQuestions = useMemo(
    () => QUESTIONS.filter((q) => !states[q.id]),
    [states]
  );

  const startSession = (questions, spares = []) => {
    setSessionQs(questions);
    setSessionSpares(spares);
    setSessionLog([]);
    setScreen("session");
  };

  const finishSession = (log) => {
    setSessionLog(log);
    setScreen("result");
  };

  const openDetail = (d) => {
    setDetail(d);
    setScreen("detail");
  };

  return (
    <>
      {screen === "home" && (
        <HomeScreen
          states={states} dueCount={dueQuestionsFiltered.length} newCount={newQuestions.length}
          totalCount={QUESTIONS.length}
          calcFilter={reviewCalcFilter} onCalcFilterChange={setReviewCalcFilter}
          onReview={() => startSession(shuffle(dueQuestionsFiltered).slice(0, 20))}
          onSetup={() => setScreen("setup")}
          onList={() => setScreen("list")}
          onStats={() => setScreen("stats")}
        />
      )}
      {screen === "setup" && (
        <SetupScreen
          states={states} newQuestions={newQuestions}
          onStart={startSession} onBack={() => setScreen("home")}
        />
      )}
      {screen === "session" && (
        <SessionScreen
          questions={sessionQs} spares={sessionSpares} onFinish={finishSession}
          onQuit={() => setScreen("home")} updateCard={updateCard}
        />
      )}
      {/* 詳細を開いている間も呼び出し元を非表示で残し、検索条件やスクロール位置を保つ
          （App がタブ切り替えでやっているのと同じ手法） */}
      {(screen === "result" || (screen === "detail" && detail?.from === "result")) && (
        <div style={{ display: screen === "result" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <ResultScreen
            log={sessionLog} states={states}
            onHome={() => setScreen("home")}
            onOpen={(e) => openDetail({ q: e.q, selected: e.selected, revealStart: true, from: "result" })}
          />
        </div>
      )}
      {(screen === "list" || (screen === "detail" && detail?.from === "list")) && (
        <div style={{ display: screen === "list" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <QuestionList
            states={states}
            onOpen={(q) => openDetail({ q, selected: null, revealStart: false, from: "list" })}
            onBack={() => setScreen("home")}
          />
        </div>
      )}
      {screen === "detail" && detail && (
        // 問題が変わったら「解答を見る」の開閉状態を持ち越さないよう key を付ける
        <QuestionDetail
          key={detail.q.id} q={detail.q} selected={detail.selected}
          revealStart={detail.revealStart} onBack={() => setScreen(detail.from)}
        />
      )}
      {screen === "stats" && (
        <StatsScreen states={states} onBack={() => setScreen("home")} onReset={resetAll} />
      )}
    </>
  );
}

// ===== ホーム画面 =====
function HomeScreen({ states, dueCount, newCount, totalCount, calcFilter, onCalcFilterChange, onReview, onSetup, onList, onStats }) {
  const learned = Object.keys(states).length;
  const mastered = Object.values(states).filter((c) => c.interval >= 7).length;
  const progress = totalCount ? Math.round((learned / totalCount) * 100) : 0;

  return (
    <div style={{ padding: "32px 20px 24px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <header style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>
          基本情報技術者
        </h1>
        <p style={{ margin: "4px 0 0", color: C.dim, fontSize: 14 }}>午前問題 間隔反復トレーニング・全{totalCount}問</p>
      </header>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: C.dim }}>学習進捗</span>
          <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: C.accent }}>{progress}%</span>
        </div>
        <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg,${C.accentDim},${C.accent})`, borderRadius: 4, transition: "width .5s" }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
          <Stat label="学習済み" value={learned} unit={`/ ${totalCount}`} />
          <Stat label="定着" value={mastered} unit="問" color={C.blue} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {[["all", "すべて"], ["only", "計算問題だけ"], ["exclude", "計算問題なし"]].map(([key, label]) => (
          <button key={key} onClick={() => onCalcFilterChange(key)}
            style={{ flex: 1, padding: "7px 4px", borderRadius: 8, fontSize: 11, fontFamily: sans, cursor: "pointer",
              background: calcFilter === key ? C.panelHi : "transparent",
              border: `1px solid ${calcFilter === key ? C.accent : C.border}`,
              color: calcFilter === key ? C.text : C.faint,
              fontWeight: calcFilter === key ? 700 : 400 }}>
            {label}
          </button>
        ))}
      </div>

      <button onClick={dueCount > 0 ? onReview : undefined}
        style={{ ...cardBtn, background: dueCount > 0 ? `linear-gradient(135deg,${C.accentDim},#238636)` : C.panel, border: dueCount > 0 ? "none" : `1px solid ${C.border}`, cursor: dueCount > 0 ? "pointer" : "default", opacity: dueCount > 0 ? 1 : 0.6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>今日の復習</div>
            <div style={{ fontSize: 13, color: dueCount > 0 ? "rgba(255,255,255,.85)" : C.dim, marginTop: 2 }}>
              {dueCount > 0 ? "記憶が薄れる前に復習しよう" : "今日の復習は完了！"}
            </div>
          </div>
          <div style={{ fontFamily: mono, fontSize: 34, fontWeight: 800, color: "#fff" }}>{dueCount}</div>
        </div>
      </button>

      <button onClick={onSetup} style={{ ...cardBtn, background: C.panel, border: `1px solid ${C.border}`, cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>新しく解く</div>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 2 }}>未学習 {newCount}問 / カテゴリ選択も可</div>
          </div>
          <div style={{ fontSize: 22, color: C.dim }}>→</div>
        </div>
      </button>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onList} style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
          ▤ 問題一覧
        </button>
        <button onClick={onStats} style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
          ◷ 学習統計
        </button>
      </div>
    </div>
  );
}

// ===== セッション設定画面 =====
function SetupScreen({ states, newQuestions, onStart, onBack }) {
  const [selectedCats, setSelectedCats] = useState([]);
  const [selectedSets, setSelectedSets] = useState([]);
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState("new");
  const [calcFilter, setCalcFilter] = useState("all");

  const pool = useMemo(() => {
    let qs = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedCats.length > 0) qs = qs.filter((q) => selectedCats.includes(q.category));
    if (selectedSets.length > 0) qs = qs.filter((q) => selectedSets.includes(q.set));
    qs = filterByCalc(qs, calcFilter);
    return qs;
  }, [mode, selectedCats, selectedSets, calcFilter, newQuestions]);

  const toggleCat = (cat) =>
    setSelectedCats((prev) => prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]);

  const toggleSet = (set) =>
    setSelectedSets((prev) => prev.includes(set) ? prev.filter((s) => s !== set) : [...prev, set]);

  const actualCount = Math.min(count, pool.length);

  // カテゴリごとの残数を計算（出題セット・計算問題フィルタの選択を反映）
  const catCounts = useMemo(() => {
    let base = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedSets.length > 0) base = base.filter((q) => selectedSets.includes(q.set));
    base = filterByCalc(base, calcFilter);
    const m = {};
    CATEGORIES.forEach((c) => { m[c] = base.filter((q) => q.category === c).length; });
    return m;
  }, [mode, newQuestions, selectedSets, calcFilter]);

  // 出題セットごとの残数を計算（分野・計算問題フィルタの選択を反映）
  const setCounts = useMemo(() => {
    let base = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedCats.length > 0) base = base.filter((q) => selectedCats.includes(q.category));
    base = filterByCalc(base, calcFilter);
    const m = {};
    SETS.forEach((s) => { m[s] = base.filter((q) => q.set === s).length; });
    return m;
  }, [mode, newQuestions, selectedCats, calcFilter]);

  // 計算問題フィルタ各選択肢の残数（分野・セットの選択を反映）
  const calcCounts = useMemo(() => {
    let base = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedCats.length > 0) base = base.filter((q) => selectedCats.includes(q.category));
    if (selectedSets.length > 0) base = base.filter((q) => selectedSets.includes(q.set));
    return { all: base.length, only: filterByCalc(base, "only").length, exclude: filterByCalc(base, "exclude").length };
  }, [mode, newQuestions, selectedCats, selectedSets]);

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1 }}>
      <TopBar title="セッション設定" onBack={onBack} />

      <Section title="出題範囲">
        <div style={{ display: "flex", gap: 10 }}>
          <Toggle active={mode === "new"} onClick={() => setMode("new")} label="未学習のみ" sub={`${newQuestions.length}問`} />
          <Toggle active={mode === "all"} onClick={() => setMode("all")} label="全問題" sub={`${QUESTIONS.length}問`} />
        </div>
      </Section>

      <Section title={`分野${selectedCats.length > 0 ? ` (${selectedCats.length}選択中)` : "（全分野）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {CATEGORIES.map((cat) => {
            const active = selectedCats.includes(cat);
            const n = catCounts[cat];
            return (
              <button key={cat} onClick={() => toggleCat(cat)} disabled={n === 0}
                style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans, cursor: n === 0 ? "default" : "pointer",
                  background: active ? catColor(cat) : C.panel,
                  color: active ? "#0d1117" : (n === 0 ? C.faint : C.dim),
                  border: `1px solid ${active ? catColor(cat) : C.border}`,
                  fontWeight: active ? 700 : 400, opacity: n === 0 ? 0.4 : 1 }}>
                {cat} <span style={{ fontSize: 11, opacity: 0.8 }}>{n}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={`出題セット${selectedSets.length > 0 ? ` (${selectedSets.length}選択中)` : "（全セット）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {SETS.map((set) => {
            const active = selectedSets.includes(set);
            const n = setCounts[set];
            return (
              <button key={set} onClick={() => toggleSet(set)} disabled={n === 0}
                style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans, cursor: n === 0 ? "default" : "pointer",
                  background: active ? C.blue : C.panel,
                  color: active ? "#0d1117" : (n === 0 ? C.faint : C.dim),
                  border: `1px solid ${active ? C.blue : C.border}`,
                  fontWeight: active ? 700 : 400, opacity: n === 0 ? 0.4 : 1 }}>
                {set} <span style={{ fontSize: 11, opacity: 0.8 }}>{n}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="計算問題">
        <div style={{ display: "flex", gap: 10 }}>
          <Toggle active={calcFilter === "all"} onClick={() => setCalcFilter("all")} label="すべて" sub={`${calcCounts.all}問`} />
          <Toggle active={calcFilter === "only"} onClick={() => setCalcFilter("only")} label="計算問題だけ" sub={`${calcCounts.only}問`} />
          <Toggle active={calcFilter === "exclude"} onClick={() => setCalcFilter("exclude")} label="計算問題を除く" sub={`${calcCounts.exclude}問`} />
        </div>
      </Section>

      <Section title="問題数">
        <div style={{ display: "flex", gap: 10 }}>
          {[10, 20, 30].map((n) => (
            <Toggle key={n} active={count === n} onClick={() => setCount(n)} label={`${n}問`} />
          ))}
        </div>
      </Section>

      <div style={{ flex: 1 }} />

      {/* シャッフルは1回だけ。先頭 count 問を出題し、残り全部をスキップ時の
          差し替え候補（spares）にする。同じ並びの前後なので重複しない */}
      <button onClick={() => {
        if (actualCount === 0) return;
        const shuffled = shuffle(pool);
        onStart(shuffled.slice(0, count), shuffled.slice(count));
      }}
        disabled={actualCount === 0}
        style={{ width: "100%", padding: 18, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans,
          cursor: actualCount > 0 ? "pointer" : "default",
          background: actualCount > 0 ? `linear-gradient(135deg,${C.accentDim},#238636)` : C.panel,
          color: actualCount > 0 ? "#fff" : C.faint }}>
        {actualCount > 0 ? `${actualCount}問でスタート` : "該当する問題がありません"}
      </button>
    </div>
  );
}

// ===== セッション（問題）画面 =====
function SessionScreen({ questions, spares = [], onFinish, onQuit, updateCard }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [log, setLog] = useState([]);
  const [shuffledOrder, setShuffledOrder] = useState(() => makeChoiceOrder(questions[0]));
  const [showFull, setShowFull] = useState(false);
  // 新しいフックは必ずここから下（末尾）に足す。render_check.mjs --session が
  // useState を「呼び出し順」で差し替えているので、上6つの順番を変えると壊れる。
  // スキップで問題を差し替えるので questions は state に持つ
  const [qs, setQs] = useState(questions);
  const [spareIdx, setSpareIdx] = useState(0);

  const q = qs[idx];
  const isLast = idx === qs.length - 1;
  const hasSpare = spareIdx < spares.length;

  if (!q) {
    return <div style={{ padding: 40, textAlign: "center", color: C.dim }}>問題がありません</div>;
  }

  const handleSelect = (i) => {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
  };

  const handleRate = (quality) => {
    const isRight = selected === q.answer;
    updateCard(q.id, quality, isRight);
    const entry = { q, selected, correct: isRight, quality };
    const newLog = [...log, entry];
    setLog(newLog);
    if (isLast) {
      onFinish(newLog);
    } else {
      setIdx(idx + 1);
      setSelected(null);
      setAnswered(false);
      setShuffledOrder(makeChoiceOrder(qs[idx + 1]));
      setShowFull(false);
    }
  };

  // スキップ。差し替え候補があれば今の位置の問題を入れ替えてその場に留まり（＝問題数を維持）、
  // 無ければ次へ進む。どちらの場合も updateCard を呼ばないので学習履歴には何も書かれず、
  // 復習で出た問題は期限切れのまま（＝未回答のまま）残る。
  const handleSkip = () => {
    const newLog = [...log, { q, selected: null, correct: false, skipped: true }];
    setLog(newLog);
    setSelected(null);
    setAnswered(false);
    setShowFull(false);
    if (hasSpare) {
      const next = spares[spareIdx];
      const nextQs = [...qs];
      nextQs[idx] = next;
      setQs(nextQs);
      setSpareIdx(spareIdx + 1);
      setShuffledOrder(makeChoiceOrder(next));
      return;
    }
    if (isLast) {
      onFinish(newLog);
      return;
    }
    setIdx(idx + 1);
    setShuffledOrder(makeChoiceOrder(qs[idx + 1]));
  };

  const isCorrect = selected === q.answer;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "100vh" }}>
      <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onQuit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0 }}>✕</button>
          <div style={{ flex: 1, height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${((idx + (answered ? 1 : 0)) / qs.length) * 100}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width .3s" }} />
          </div>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{idx + 1}/{qs.length}</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${catColor(q.category)}22`, color: catColor(q.category) }}>
            {q.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{q.set}</span>
          {/* 不備を報告するときの識別子。修正ログ(fix_log.md)のキーでもある */}
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, fontFamily: mono }}>{q.id}</span>
        </div>
        <RichText text={q.question} style={{ fontSize: 17, lineHeight: 1.7, fontWeight: 500, margin: "0 0 24px" }} />

        {q.image && (
          <img
            src={q.image}
            alt="問題の図"
            style={{
              width: "100%",
              maxWidth: 420,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              margin: "-8px 0 24px",
              display: "block",
              backgroundColor: "#fff"
            }}
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shuffledOrder.map((origIdx, displayIdx) => {
            let bg = C.panel, border = C.border, mark = null, txtColor = C.text;
            if (answered) {
              if (origIdx === q.answer) { bg = `${C.accent}1a`; border = C.accent; mark = "✓"; txtColor = C.accent; }
              else if (origIdx === selected) { bg = `${C.red}1a`; border = C.red; mark = "✗"; txtColor = C.red; }
              else { txtColor = C.dim; }
            }
            return (
              <button key={origIdx} onClick={() => handleSelect(origIdx)} disabled={answered}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12, textAlign: "left", fontFamily: sans, fontSize: 15, lineHeight: 1.5,
                  background: bg, border: `1.5px solid ${border}`, color: txtColor, cursor: answered ? "default" : "pointer", transition: "all .15s" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: C.faint, minWidth: 18 }}>{"アイウエ"[displayIdx]}</span>
                <RichText as="span" text={q.choices[origIdx]} style={{ flex: 1 }} />
                {mark && <span style={{ fontWeight: 700, fontSize: 16 }}>{mark}</span>}
              </button>
            );
          })}
        </div>

        {answered && (() => {
          const labelMap = {};
          shuffledOrder.forEach((origIdx, displayIdx) => {
            labelMap["アイウエ"[origIdx]] = "アイウエ"[displayIdx];
          });
          // 本文→正解の解説→残りを表示順、に並べ替えてからラベルを書き換える
          const { lead, rest } = orderExplanation(q.explanation, shuffledOrder, q.answer);
          const explanation = remapLabels(rest ? `${lead}\n${rest}` : lead, labelMap);
          // 選択肢ごとに分かれているときは本文だけを畳んだ状態で見せる。
          // 改行の無い古い形式の解説は従来どおり先頭1〜2文を要約にする。
          const summary = (rest && lead) ? remapLabels(lead, labelMap) : getExplanationSummary(explanation);
          const hasMore = explanation !== summary;
          return (
            <div style={{ marginTop: 20, padding: 16, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, animation: "fadeIn .3s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: isCorrect ? C.accent : C.red }}>
                  {isCorrect ? "正解" : "不正解"}
                </span>
                <span style={{ fontSize: 12, color: C.faint }}>—　解説</span>
              </div>
              <RichText text={showFull ? explanation : summary} style={{ fontSize: 14, lineHeight: 1.8, color: C.text }} />
              {hasMore && (
                <button onClick={() => setShowFull(!showFull)}
                  style={{ background: "none", border: "none", color: C.blue, fontSize: 13, cursor: "pointer", padding: "8px 0 0", fontFamily: sans }}>
                  {showFull ? "▲ 閉じる" : "▼ 詳しく見る"}
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {/* 未解答のときだけ出す。差し替え候補の有無で起きることが変わるので補足の文言も変える */}
      {!answered && (
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.border}`, background: C.panel }}>
          <button onClick={handleSkip}
            style={{ width: "100%", padding: "10px 4px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", cursor: "pointer", fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.dim }}>⤴ スキップ</span>
            <span style={{ fontSize: 11, color: C.faint }}>
              {hasSpare ? "別の問題に差し替えます" : "あとで復習します"}
            </span>
          </button>
        </div>
      )}

      {answered && (
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}`, background: C.panel, animation: "slideUp .3s" }}>
          <div style={{ fontSize: 12, color: C.faint, textAlign: "center", marginBottom: 10 }}>
            理解度を選ぶと次回の出題間隔が決まります
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <RateBtn color={C.red} emoji="😓" label="わからない" sub="翌日" onClick={() => handleRate(0)} />
            <RateBtn color={C.amber} emoji="🤔" label="迷った" sub="2-4日後" onClick={() => handleRate(1)} />
            <RateBtn color={C.accent} emoji="😊" label="わかった" sub="4日後〜" onClick={() => handleRate(2)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== セッション結果画面 =====
function ResultScreen({ log, onHome, onOpen }) {
  // スキップは採点に入れない。total に含めると正答率が不当に下がるため、
  // 正答率・間違い件数はすべて answeredLog から数える（一覧だけは全件を出す）
  const answeredLog = log.filter((e) => !e.skipped);
  const skippedCount = log.length - answeredLog.length;
  const correct = answeredLog.filter((e) => e.correct).length;
  const total = answeredLog.length;
  const rate = total ? Math.round((correct / total) * 100) : 0;
  const wrongList = answeredLog.filter((e) => !e.correct);

  let message, msgColor;
  if (total === 0) { message = "すべてスキップしました"; msgColor = C.dim; }
  else if (rate >= 80) { message = "素晴らしい！この調子です"; msgColor = C.accent; }
  else if (rate >= 60) { message = "良いペース。復習で確実に"; msgColor = C.blue; }
  else { message = "間違えた問題を重点復習しよう"; msgColor = C.amber; }

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 20, flex: 1, overflowY: "auto" }}>
      <div style={{ textAlign: "center", paddingTop: 24 }}>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, marginBottom: 8 }}>セッション完了</div>
        <div style={{ position: "relative", width: 150, height: 150, margin: "0 auto" }}>
          <svg width="150" height="150" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="75" cy="75" r="64" fill="none" stroke={C.panel} strokeWidth="11" />
            <circle cx="75" cy="75" r="64" fill="none" stroke={msgColor} strokeWidth="11" strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 64}`} strokeDashoffset={`${2 * Math.PI * 64 * (1 - rate / 100)}`}
              style={{ transition: "stroke-dashoffset 1s ease" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 38, fontWeight: 800, color: msgColor }}>{rate}<span style={{ fontSize: 18 }}>%</span></span>
            <span style={{ fontSize: 13, color: C.dim }}>{correct} / {total} 問正解</span>
          </div>
        </div>
        <p style={{ marginTop: 16, fontSize: 15, fontWeight: 600, color: msgColor }}>{message}</p>
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: C.faint, marginBottom: 10, fontFamily: mono }}>
          問題別レビュー（タップで詳細） {wrongList.length > 0 && `(${wrongList.length}問間違い → 復習予定に追加)`}
          {skippedCount > 0 && `（スキップ${skippedCount}問は採点に含めていません）`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {log.map((e, i) => (
            <button key={i} onClick={() => onOpen(e)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${e.correct || e.skipped ? C.border : C.red + "44"}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
              <span style={{ fontFamily: mono, fontSize: 16, color: e.skipped ? C.amber : e.correct ? C.accent : C.red, fontWeight: 700, minWidth: 16 }}>
                {e.skipped ? "—" : e.correct ? "✓" : "✗"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(e.q.question)}</div>
                <div style={{ fontSize: 11, color: catColor(e.q.category), marginTop: 2 }}>
                  {e.q.category}{e.skipped && <span style={{ color: C.amber }}> ・スキップ</span>}
                </div>
              </div>
              <span style={{ fontSize: 18, color: C.faint }}>›</span>
            </button>
          ))}
        </div>
      </div>

      <button onClick={onHome} style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans, cursor: "pointer", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff" }}>
        ホームに戻る
      </button>
    </div>
  );
}

// ===== 問題の詳細（振り返り画面と問題一覧から使う） =====
// 出題ではないので選択肢はシャッフルせず、questions.json の順のまま ア〜エ を振る。
// そのため解説のラベルは元のままで正しく、remapLabels は使わない（使うとずれる）。
function QuestionDetail({ q, selected, revealStart, onBack }) {
  const [revealed, setRevealed] = useState(!!revealStart);

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 18, flex: 1, overflowY: "auto" }}>
      <TopBar title="問題の詳細" onBack={onBack} />

      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${catColor(q.category)}22`, color: catColor(q.category) }}>
            {q.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{q.set}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, fontFamily: mono }}>{q.id}</span>
        </div>

        <RichText text={q.question} style={{ fontSize: 17, lineHeight: 1.7, fontWeight: 500, margin: "0 0 24px" }} />

        {q.image && (
          <img src={q.image} alt="問題の図"
            style={{ width: "100%", maxWidth: 420, borderRadius: 8, border: `1px solid ${C.border}`, margin: "-8px 0 24px", display: "block", backgroundColor: "#fff" }} />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {q.choices.map((choice, i) => {
            let bg = C.panel, border = C.border, mark = null, txtColor = C.text;
            if (revealed) {
              if (i === q.answer) { bg = `${C.accent}1a`; border = C.accent; mark = "✓"; txtColor = C.accent; }
              else if (i === selected) { bg = `${C.red}1a`; border = C.red; mark = "✗"; txtColor = C.red; }
              else { txtColor = C.dim; }
            }
            return (
              <div key={i}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12, fontSize: 15, lineHeight: 1.5,
                  background: bg, border: `1.5px solid ${border}`, color: txtColor }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: C.faint, minWidth: 18 }}>{"アイウエ"[i]}</span>
                <RichText as="span" text={choice} style={{ flex: 1 }} />
                {mark && <span style={{ fontWeight: 700, fontSize: 16 }}>{mark}</span>}
              </div>
            );
          })}
        </div>

        {!revealed ? (
          <button onClick={() => setRevealed(true)}
            style={{ width: "100%", marginTop: 20, padding: 14, borderRadius: 12, border: `1px solid ${C.blue}`, background: `${C.blue}14`, color: C.blue, fontSize: 15, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
            解答を見る
          </button>
        ) : (
          <div style={{ marginTop: 20, padding: 16, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>正解: {"アイウエ"[q.answer]}</span>
              <span style={{ fontSize: 12, color: C.faint }}>—　解説</span>
            </div>
            <RichText text={q.explanation} style={{ fontSize: 14, lineHeight: 1.8, color: C.text }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ===== 問題一覧 =====
function QuestionList({ states, onOpen, onBack }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("all");
  const [set, setSet] = useState("all");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(LIST_PAGE);

  const statusOf = (q) => {
    const c = states[q.id];
    if (!c) return "new";
    if (c.interval >= 7) return "mastered";
    if (c.dueDate <= todayStr()) return "due";
    return "learning";
  };

  // 検索用の文字列は1度だけ作る（1,252問を毎キー入力で作り直さない）
  const haystack = useMemo(() => {
    const m = {};
    QUESTIONS.forEach((q) => { m[q.id] = (q.id + " " + plainPreview(q.question)).toLowerCase(); });
    return m;
  }, []);

  const list = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return QUESTIONS.filter((q) =>
      (cat === "all" || q.category === cat) &&
      (set === "all" || q.set === set) &&
      (status === "all" || statusOf(q) === status) &&
      (!kw || haystack[q.id].includes(kw))
    );
  }, [query, cat, set, status, states, haystack]);

  // 条件を変えたら先頭に戻す
  useEffect(() => { setLimit(LIST_PAGE); }, [query, cat, set, status]);

  const counts = useMemo(() => {
    const m = { all: QUESTIONS.length, due: 0, learning: 0, mastered: 0, new: 0 };
    QUESTIONS.forEach((q) => { m[statusOf(q)] += 1; });
    return m;
  }, [states]);

  const FILTERS = [
    { key: "all", label: "すべて" },
    { key: "due", label: "復習待ち" },
    { key: "learning", label: "学習中" },
    { key: "mastered", label: "定着" },
    { key: "new", label: "未学習" },
  ];
  const STATUS_COLOR = { due: C.amber, learning: C.blue, mastered: C.accent, new: C.faint };
  const STATUS_LABEL = { due: "復習待ち", learning: "学習中", mastered: "定着", new: "未学習" };
  const selectStyle = { flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10, background: C.panel, color: C.text, border: `1px solid ${C.border}`, fontSize: 13, fontFamily: sans };

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
      <TopBar title="問題一覧" onBack={onBack} />

      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="ID や問題文で検索（例: 2013A-18／最短経路）"
        style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: C.panel, color: C.text, border: `1px solid ${C.border}`, fontSize: 14, fontFamily: sans }} />

      <div style={{ display: "flex", gap: 8 }}>
        <select value={cat} onChange={(e) => setCat(e.target.value)} style={selectStyle}>
          <option value="all">分野: すべて</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={set} onChange={(e) => setSet(e.target.value)} style={selectStyle}>
          <option value="all">年度: すべて</option>
          {SETS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {FILTERS.map((f) => {
          const active = status === f.key;
          return (
            <button key={f.key} onClick={() => setStatus(f.key)}
              style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans, cursor: "pointer",
                background: active ? C.blue : C.panel, color: active ? "#0d1117" : C.dim,
                border: `1px solid ${active ? C.blue : C.border}`, fontWeight: active ? 700 : 400 }}>
              {f.label} <span style={{ fontSize: 11, opacity: 0.8 }}>{counts[f.key]}</span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>{list.length}問</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: C.faint, fontSize: 13 }}>該当する問題がありません</div>
        )}
        {list.slice(0, limit).map((q) => {
          const st = statusOf(q);
          return (
            <button key={q.id} onClick={() => onOpen(q)}
              style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", textAlign: "left", fontFamily: sans, cursor: "pointer", display: "block", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.text }}>{q.id}</span>
                <span style={{ fontSize: 11, color: catColor(q.category) }}>{q.category}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: STATUS_COLOR[st], fontFamily: mono }}>{STATUS_LABEL[st]}</span>
              </div>
              <div style={{ fontSize: 13, color: C.dim, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {plainPreview(q.question)}
              </div>
            </button>
          );
        })}
      </div>

      {list.length > limit && (
        <button onClick={() => setLimit(limit + LIST_PAGE)}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "transparent", border: `1px solid ${C.border}`, color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
          もっと見る（残り{list.length - limit}件）
        </button>
      )}
    </div>
  );
}

// ===== 統計ダッシュボード =====
function StatsScreen({ states, onBack, onReset }) {
  const [confirmReset, setConfirmReset] = useState(false);

  // ① 全問題数に対する分野別の定着状況（定着 = 復習3回以上）
  const coverage = useMemo(() => {
    const m = {};
    CATEGORIES.forEach((cat) => { m[cat] = { total: 0, learned: 0, mastered: 0 }; });
    QUESTIONS.forEach((q) => {
      const s = m[q.category];
      if (!s) return;
      s.total += 1;
      const c = states[q.id];
      if (c && c.history.length > 0) {
        s.learned += 1;
        if (c.reps >= 3) s.mastered += 1;
      }
    });
    return m;
  }, [states]);

  // ② 直近80問（本試験と同じ問題数）の分野別正答率
  // 復習での再解答は除外し、各問題の「初回に解いたときの結果」だけを対象にする。
  // （tsが無い古い履歴は日付で並べる）
  const RECENT_N = 80;
  const recent = useMemo(() => {
    const rows = [];
    QUESTIONS.forEach((q) => {
      const c = states[q.id];
      if (!c || c.history.length === 0) return;
      const first = c.history[0];
      rows.push({
        cat: q.category,
        ts: typeof first.ts === "number" ? first.ts : (Date.parse(first.date) || 0),
        correct: histCorrect(first),
      });
    });
    rows.sort((a, b) => b.ts - a.ts);
    return rows.slice(0, RECENT_N);
  }, [states]);

  const recentByCat = useMemo(() => {
    const m = {};
    recent.forEach((r) => {
      if (!m[r.cat]) m[r.cat] = { n: 0, correct: 0 };
      m[r.cat].n += 1;
      if (r.correct) m[r.cat].correct += 1;
    });
    return m;
  }, [recent]);
  const recentRate = recent.length ? Math.round((recent.filter((r) => r.correct).length / recent.length) * 100) : 0;

  const allHistory = Object.values(states).flatMap((c) => c.history);
  const totalAnswered = allHistory.length;
  const totalCorrect = allHistory.filter(histCorrect).length;
  const overallRate = totalAnswered ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
  const learnedCount = Object.values(states).filter((c) => c.history.length > 0).length;

  const schedule = useMemo(() => {
    const days = {};
    for (let i = 0; i < 7; i++) days[addDays(i)] = 0;
    Object.values(states).forEach((c) => {
      if (days[c.dueDate] !== undefined) days[c.dueDate] += 1;
    });
    return Object.entries(days);
  }, [states]);
  const maxSched = Math.max(1, ...schedule.map(([, n]) => n));

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1, overflowY: "auto" }}>
      <TopBar title="学習統計" onBack={onBack} />

      {learnedCount === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.dim, textAlign: "center", gap: 8 }}>
          <div style={{ fontSize: 40 }}>▤</div>
          <p style={{ fontSize: 15 }}>まだ学習データがありません</p>
          <p style={{ fontSize: 13, color: C.faint }}>問題を解くと、ここに統計が表示されます</p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <SummaryCard label="総合正答率" value={`${overallRate}%`} color={C.accent} />
            <SummaryCard label="解答数" value={totalAnswered} color={C.blue} />
            <SummaryCard label="学習問題" value={learnedCount} color={C.purple} />
          </div>

          <div>
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 12, fontFamily: mono }}>今後7日間の復習予定</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100, padding: "0 4px" }}>
              {schedule.map(([date, n], i) => {
                const d = new Date(date);
                const label = i === 0 ? "今日" : ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
                return (
                  <div key={date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <div style={{ fontFamily: mono, fontSize: 11, color: n > 0 ? C.accent : C.faint }}>{n || ""}</div>
                    <div style={{ width: "100%", height: `${(n / maxSched) * 70}px`, minHeight: n > 0 ? 4 : 0,
                      background: i === 0 ? C.accent : `${C.accent}77`, borderRadius: 4, transition: "height .4s" }} />
                    <div style={{ fontSize: 10, color: i === 0 ? C.accent : C.faint, fontWeight: i === 0 ? 700 : 400 }}>{label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ① 全問題数に対する分野別の定着状況 */}
          <div>
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 4, fontFamily: mono }}>
              分野別の定着状況（全{QUESTIONS.length}問中）
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, fontSize: 10, color: C.faint }}>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.accent, marginRight: 4 }} />定着(復習3回以上)</span>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: `${C.accent}55`, marginRight: 4 }} />学習中</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {CATEGORIES.map((cat) => {
                const s = coverage[cat];
                if (!s || s.total === 0) return null;
                const mPct = (s.mastered / s.total) * 100;
                const lPct = ((s.learned - s.mastered) / s.total) * 100;
                const rate = Math.round(mPct);
                return (
                  <div key={cat}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: s.learned > 0 ? C.text : C.faint }}>{cat}</span>
                      <span style={{ fontFamily: mono, fontSize: 12, color: s.mastered > 0 ? catColor(cat) : C.faint }}>
                        {s.mastered}/{s.total}問
                        <span style={{ color: C.faint, marginLeft: 6 }}>{rate}%</span>
                      </span>
                    </div>
                    <div style={{ height: 6, background: C.panel, borderRadius: 3, overflow: "hidden", display: "flex" }}>
                      <div style={{ width: `${mPct}%`, height: "100%", background: catColor(cat), transition: "width .5s" }} />
                      <div style={{ width: `${lPct}%`, height: "100%", background: `${catColor(cat)}55`, transition: "width .5s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ② 直近50問の分野別正答率 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>
                直近{Math.min(RECENT_N, recent.length)}問の分野別正答率
                <span style={{ marginLeft: 6, fontSize: 10 }}>（初回解答のみ）</span>
              </span>
              <span style={{ fontFamily: mono, fontSize: 12, color: C.accent }}>全体 {recentRate}%</span>
            </div>
            {recent.length === 0 ? (
              <div style={{ fontSize: 12, color: C.faint }}>まだ解答履歴がありません</div>
            ) : (
              // 復習を挟んでも初回の結果は変わらないので、実力の推移が見やすい
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {CATEGORIES.filter((cat) => recentByCat[cat]).map((cat) => {
                  const s = recentByCat[cat];
                  const rate = Math.round((s.correct / s.n) * 100);
                  // 正答率が低い分野を目立たせる
                  const barColor = rate >= 80 ? C.accent : rate >= 50 ? C.amber : C.red;
                  return (
                    <div key={cat}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 13, color: C.text }}>
                          {cat} <span style={{ fontSize: 11, color: C.faint }}>({s.n}問)</span>
                        </span>
                        <span style={{ fontFamily: mono, fontSize: 12, color: barColor }}>
                          {s.correct}/{s.n}
                          <span style={{ marginLeft: 6 }}>{rate}%</span>
                        </span>
                      </div>
                      <div style={{ height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${rate}%`, height: "100%", background: barColor, borderRadius: 3, transition: "width .5s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* バックアップ / 復元 */}
          <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            <BackupRestore />
          </div>

          {/* データリセット */}
          <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            {!confirmReset ? (
              <button onClick={() => setConfirmReset(true)}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "transparent", border: `1px solid ${C.border}`, color: C.faint, fontSize: 13, fontFamily: sans, cursor: "pointer" }}>
                学習データをリセット
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, color: C.red, textAlign: "center" }}>全ての学習履歴が削除されます。よろしいですか？</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setConfirmReset(false)}
                    style={{ flex: 1, padding: 12, borderRadius: 10, background: C.panel, border: `1px solid ${C.border}`, color: C.text, fontSize: 13, fontFamily: sans, cursor: "pointer" }}>
                    キャンセル
                  </button>
                  <button onClick={() => { onReset(); setConfirmReset(false); }}
                    style={{ flex: 1, padding: 12, borderRadius: 10, background: `${C.red}22`, border: `1px solid ${C.red}`, color: C.red, fontSize: 13, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
                    削除する
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ===== 学習履歴のバックアップ / 復元 =====
// 過去問（fe-exam-srs-v1）と英略語（it-abbr-srs-v1）の両方を1つのファイルにまとめて
// 書き出し・読み込みできる。アプリを消しても、このファイルから履歴を復元できる。
const SRS_KEYS = [STORAGE_KEY, ABBR_STORAGE_KEY];
const BACKUP_KEYS = [...SRS_KEYS, MOCK_STORAGE_KEY];
const BACKUP_MAGIC = "fe-exam-trainer-backup";

function buildBackup() {
  const stores = {};
  BACKUP_KEYS.forEach((k) => {
    const raw = localStorage.getItem(k);
    if (raw) {
      try { stores[k] = JSON.parse(raw); } catch (e) { /* skip broken */ }
    }
  });
  return { app: BACKUP_MAGIC, version: 1, exportedAt: new Date().toISOString(), stores };
}

function countCards(backup) {
  return SRS_KEYS.reduce((sum, k) => sum + Object.keys(backup.stores[k] || {}).length, 0);
}

// 模試履歴は {v, runs:[...]} の形なのでカード数には混ぜず、別に回数を数える
function countMockRuns(backup) {
  const m = backup.stores[MOCK_STORAGE_KEY];
  return m && Array.isArray(m.runs) ? m.runs.length : 0;
}

const backupSummary = (backup) => {
  const runs = countMockRuns(backup);
  return `${countCards(backup)}件の学習履歴` + (runs ? `と模試${runs}回分` : "");
};

function BackupRestore() {
  const fileRef = React.useRef(null);
  const [msg, setMsg] = useState(null); // {type, text}

  const doExport = () => {
    try {
      const backup = buildBackup();
      const n = backupSummary(backup);
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fe-exam-backup-${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg({ type: "ok", text: `${n}を書き出しました。ダウンロードを確認してください。` });
    } catch (e) {
      setMsg({ type: "err", text: "書き出しに失敗しました: " + e.message });
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // 同じファイルを続けて選べるように
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || !data.stores || data.app !== BACKUP_MAGIC) {
        throw new Error("このアプリのバックアップファイルではありません");
      }
      const n = backupSummary(data);
      if (!window.confirm(`バックアップから${n}を復元します。\n現在の履歴は上書きされます。よろしいですか？`)) return;
      BACKUP_KEYS.forEach((k) => {
        if (data.stores[k]) localStorage.setItem(k, JSON.stringify(data.stores[k]));
      });
      setMsg({ type: "ok", text: "復元しました。画面を更新します…" });
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      setMsg({ type: "err", text: "復元に失敗しました: " + err.message });
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 10, fontFamily: mono }}>学習履歴のバックアップ</div>
      <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7, marginBottom: 12 }}>
        過去問と英略語の履歴をまとめて1つのファイルに保存します。アプリを消したり端末を変えても、このファイルから復元できます。
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={doExport}
          style={{ flex: 1, padding: 12, borderRadius: 10, background: C.panel, border: `1px solid ${C.border}`, color: C.text, fontSize: 13, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
          ⬇ ファイルに保存
        </button>
        <button onClick={() => fileRef.current && fileRef.current.click()}
          style={{ flex: 1, padding: 12, borderRadius: 10, background: C.panel, border: `1px solid ${C.border}`, color: C.text, fontSize: 13, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
          ⬆ ファイルから復元
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
      </div>
      {msg && (
        <div style={{ marginTop: 10, fontSize: 12, color: msg.type === "ok" ? C.accent : C.red, lineHeight: 1.6 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 英略語暗記モード
// ============================================================
const abbrCatColor = (cat) => {
  const map = {
    基礎理論: C.blue, コンピュータシステム: "#79c0ff", 開発技術: "#56d364",
    プロジェクトマネジメント: "#d2a8ff", サービスマネジメント: C.purple,
    システム戦略: C.amber, 経営戦略: "#7ee787", 企業と法務: "#ffa657",
    ネットワーク: "#ff7b72", セキュリティ: C.red,
  };
  return map[cat] || C.dim;
};

const FREQ_LABEL = { 3: "最頻出", 2: "頻出", 1: "標準" };

// ===== 4択のダミー選択肢（誤答）生成 =====
// 正解と「紛らわしい綴り」「近い分野」の英略語を誤答に採用する。
function letterJaccard(a, b) {
  const sa = new Set(a.toUpperCase()), sb = new Set(b.toUpperCase());
  let inter = 0;
  sa.forEach((c) => { if (sb.has(c)) inter += 1; });
  const uni = new Set([...sa, ...sb]).size;
  return uni ? inter / uni : 0;
}
function commonPrefixLen(a, b) {
  a = a.toUpperCase(); b = b.toUpperCase();
  let n = 0;
  const m = Math.min(a.length, b.length);
  while (n < m && a[n] === b[n]) n += 1;
  return n;
}
function editDistance(a, b) {
  a = a.toUpperCase(); b = b.toUpperCase();
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[b.length];
}
function abbrSimilarity(t, c) {
  const ta = t.abbr, ca = c.abbr;
  let s = 0;
  if (t.category === c.category) s += 3;                       // 近い分野
  s += letterJaccard(ta, ca) * 4;                              // 文字の重なり（アナグラム系）
  s += commonPrefixLen(ta, ca) * 2;                            // 先頭一致（MTBF/MTTR）
  if (ta.length === ca.length) s += 1.5;                       // 同じ文字数
  const maxLen = Math.max(ta.length, ca.length) || 1;
  s += (1 - editDistance(ta, ca) / maxLen) * 2;                // 全体の近さ
  return s;
}
// 最も紛らわしい語（最上位）は毎回必ず入れ、残りは次点からランダムに選ぶ。
// これで「LRU⇔LFU」「FIFO⇔LIFO」「MTBF⇔MTTR」等の目玉の誤答が確実に出つつ、他は程よく変化する。
function abbrDistractors(target, all, k = 3) {
  const scored = all
    .filter((c) => c.id !== target.id)
    .map((c) => ({ c, s: abbrSimilarity(target, c) }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
  const picked = [];
  if (scored.length) picked.push(scored[0]);                    // 最上位は固定
  const nextPool = scored.slice(1, 6);                          // 次点5語から
  for (const c of shuffle(nextPool)) { if (picked.length >= k) break; picked.push(c); }
  // 念のため k 語に満たなければ残り全体から補完
  if (picked.length < k) {
    const used = new Set([target.id, ...picked.map((c) => c.id)]);
    for (const c of scored) { if (picked.length >= k) break; if (!used.has(c.id)) { picked.push(c); used.add(c.id); } }
  }
  return picked.slice(0, k);
}
// カード1枚分の4択（選択肢の略語オブジェクト配列と正解index）を作る
function buildAbbrChoices(card) {
  const distractors = abbrDistractors(card, ABBRS, 3);
  const choices = shuffle([card, ...distractors]);
  return { choices, answer: choices.findIndex((c) => c.id === card.id) };
}

function AbbrApp({ onBusyChange }) {
  const [screen, setScreen] = useState("home");
  const [states, updateCard, resetAll] = useCardStates(ABBR_STORAGE_KEY);
  const [sessionCards, setSessionCards] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);

  useEffect(() => { onBusyChange(screen === "quiz"); }, [screen, onBusyChange]);

  const dueAbbrs = useMemo(() => {
    const today = todayStr();
    return ABBRS.filter((a) => {
      const c = states[a.id];
      return c && c.dueDate <= today;
    });
  }, [states]);

  const newAbbrs = useMemo(() => ABBRS.filter((a) => !states[a.id]), [states]);

  const startSession = (cards) => {
    setSessionCards(cards);
    setSessionLog([]);
    setScreen("quiz");
  };

  const finishSession = (log) => {
    setSessionLog(log);
    setScreen("result");
  };

  return (
    <>
      {screen === "home" && (
        <AbbrHome
          states={states} dueCount={dueAbbrs.length} newCount={newAbbrs.length}
          onReview={() => startSession(shuffle(dueAbbrs).slice(0, 20))}
          onSetup={() => setScreen("setup")}
          onList={() => setScreen("list")}
          onStats={() => setScreen("stats")}
        />
      )}
      {screen === "setup" && (
        <AbbrSetup states={states} newAbbrs={newAbbrs}
          onStart={startSession} onBack={() => setScreen("home")} />
      )}
      {screen === "quiz" && (
        <AbbrQuizScreen cards={sessionCards} onFinish={finishSession}
          onQuit={() => setScreen("home")} updateCard={updateCard} />
      )}
      {screen === "result" && (
        <AbbrResult log={sessionLog} onHome={() => setScreen("home")} />
      )}
      {screen === "list" && (
        <AbbrList states={states} onBack={() => setScreen("home")} />
      )}
      {screen === "stats" && (
        <AbbrStats states={states} onBack={() => setScreen("home")} onReset={resetAll} />
      )}
    </>
  );
}

function AbbrHome({ states, dueCount, newCount, onReview, onSetup, onList, onStats }) {
  const learned = ABBRS.filter((a) => states[a.id]).length;
  const mastered = ABBRS.filter((a) => (states[a.id]?.reps || 0) >= 3).length;
  const progress = Math.round((learned / ABBRS.length) * 100);

  return (
    <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -0.5, color: C.text }}>英略語100</h1>
        <p style={{ margin: "4px 0 0", color: C.dim, fontSize: 14 }}>頻出英略語 暗記カード・全{ABBRS.length}語</p>
      </header>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: C.dim }}>定着度</span>
          <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: C.accent }}>{progress}%</span>
        </div>
        <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg,${C.accentDim},${C.accent})`, borderRadius: 4, transition: "width .5s" }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
          <Stat label="学習済み" value={learned} unit={`/ ${ABBRS.length}`} />
          <Stat label="記憶定着" value={mastered} unit="語" color={C.blue} />
        </div>
      </div>

      <button onClick={dueCount > 0 ? onReview : undefined}
        style={{ ...cardBtn, background: dueCount > 0 ? `linear-gradient(135deg,${C.accentDim},#238636)` : C.panel, border: dueCount > 0 ? "none" : `1px solid ${C.border}`, cursor: dueCount > 0 ? "pointer" : "default", opacity: dueCount > 0 ? 1 : 0.6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>今日の復習</div>
            <div style={{ fontSize: 13, color: dueCount > 0 ? "rgba(255,255,255,.85)" : C.dim, marginTop: 2 }}>
              {dueCount > 0 ? "記憶が薄れる前に復習しよう" : "今日の復習は完了！"}
            </div>
          </div>
          <div style={{ fontFamily: mono, fontSize: 34, fontWeight: 800, color: "#fff" }}>{dueCount}</div>
        </div>
      </button>

      <button onClick={onSetup} style={{ ...cardBtn, background: C.panel, border: `1px solid ${C.border}`, cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>新しく覚える</div>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 2 }}>未学習 {newCount}語 / 分野・頻出度も選べる</div>
          </div>
          <div style={{ fontSize: 22, color: C.dim }}>→</div>
        </div>
      </button>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onList} style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
          ▤ 語一覧
        </button>
        <button onClick={onStats} style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
          ◷ 学習統計
        </button>
      </div>
    </div>
  );
}

function AbbrSetup({ states, newAbbrs, onStart, onBack }) {
  const [selectedCats, setSelectedCats] = useState([]);
  const [selectedFreqs, setSelectedFreqs] = useState([]);
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState("new");

  const pool = useMemo(() => {
    let list = mode === "new" ? newAbbrs : ABBRS;
    if (selectedCats.length > 0) list = list.filter((a) => selectedCats.includes(a.category));
    if (selectedFreqs.length > 0) list = list.filter((a) => selectedFreqs.includes(a.freq));
    return list;
  }, [mode, selectedCats, selectedFreqs, newAbbrs]);

  const toggleCat = (c) =>
    setSelectedCats((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  const toggleFreq = (f) =>
    setSelectedFreqs((prev) => prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]);

  const actualCount = Math.min(count, pool.length);

  const catCounts = useMemo(() => {
    let base = mode === "new" ? newAbbrs : ABBRS;
    if (selectedFreqs.length > 0) base = base.filter((a) => selectedFreqs.includes(a.freq));
    const m = {};
    ABBR_CATEGORIES.forEach((c) => { m[c] = base.filter((a) => a.category === c).length; });
    return m;
  }, [mode, newAbbrs, selectedFreqs]);

  const freqCounts = useMemo(() => {
    let base = mode === "new" ? newAbbrs : ABBRS;
    if (selectedCats.length > 0) base = base.filter((a) => selectedCats.includes(a.category));
    const m = {};
    [3, 2, 1].forEach((f) => { m[f] = base.filter((a) => a.freq === f).length; });
    return m;
  }, [mode, newAbbrs, selectedCats]);

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1 }}>
      <TopBar title="出題設定" onBack={onBack} />

      <Section title="出題範囲">
        <div style={{ display: "flex", gap: 10 }}>
          <Toggle active={mode === "new"} onClick={() => setMode("new")} label="未学習のみ" sub={`${newAbbrs.length}語`} />
          <Toggle active={mode === "all"} onClick={() => setMode("all")} label="全ての語" sub={`${ABBRS.length}語`} />
        </div>
      </Section>

      <Section title={`頻出度${selectedFreqs.length > 0 ? ` (${selectedFreqs.length}選択中)` : "（すべて）"}`}>
        <div style={{ display: "flex", gap: 8 }}>
          {[3, 2, 1].map((f) => (
            <Toggle key={f} active={selectedFreqs.includes(f)} onClick={() => toggleFreq(f)}
              label={FREQ_LABEL[f]} sub={`${freqCounts[f]}語`} />
          ))}
        </div>
      </Section>

      <Section title={`分野${selectedCats.length > 0 ? ` (${selectedCats.length}選択中)` : "（全分野）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ABBR_CATEGORIES.map((cat) => {
            const active = selectedCats.includes(cat);
            const n = catCounts[cat];
            return (
              <button key={cat} onClick={() => toggleCat(cat)} disabled={n === 0}
                style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans, cursor: n === 0 ? "default" : "pointer",
                  background: active ? abbrCatColor(cat) : C.panel,
                  color: active ? "#0d1117" : (n === 0 ? C.faint : C.dim),
                  border: `1px solid ${active ? abbrCatColor(cat) : C.border}`,
                  fontWeight: active ? 700 : 400, opacity: n === 0 ? 0.4 : 1 }}>
                {cat} <span style={{ fontSize: 11, opacity: 0.8 }}>{n}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="出題数">
        <div style={{ display: "flex", gap: 8 }}>
          {[5, 10, 20, 30].map((n) => (
            <Toggle key={n} active={count === n} onClick={() => setCount(n)} label={`${n}語`} />
          ))}
        </div>
      </Section>

      <div style={{ flex: 1 }} />

      <button onClick={() => actualCount > 0 && onStart(shuffle(pool).slice(0, count))}
        style={{ width: "100%", padding: 18, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans,
          cursor: actualCount > 0 ? "pointer" : "default",
          background: actualCount > 0 ? `linear-gradient(135deg,${C.accentDim},#238636)` : C.panel,
          color: actualCount > 0 ? "#fff" : C.faint }}>
        {actualCount > 0 ? `${actualCount}語でスタート` : "該当する語がありません"}
      </button>
    </div>
  );
}

// 4択問題画面：意味を見せ、4つの英略語から選ぶ → 正誤判定＋展開 → 理解度3段階評価
function AbbrQuizScreen({ cards, onFinish, onQuit, updateCard }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [log, setLog] = useState([]);

  const card = cards[idx];
  // 選択肢は問題ごとに1度だけ生成（回答中に並びが変わらないように idx で固定）
  const quiz = useMemo(() => (card ? buildAbbrChoices(card) : null), [card]);

  if (!card || !quiz) {
    return <div style={{ padding: 40, textAlign: "center", color: C.dim }}>語がありません</div>;
  }

  const isLast = idx === cards.length - 1;
  const isCorrect = selected === quiz.answer;

  const handleSelect = (i) => {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
  };

  const handleRate = (quality) => {
    updateCard(card.id, quality, isCorrect);
    const newLog = [...log, { card, correct: isCorrect, quality }];
    setLog(newLog);
    if (isLast) {
      onFinish(newLog);
    } else {
      setIdx(idx + 1);
      setSelected(null);
      setAnswered(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "100vh" }}>
      <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onQuit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0 }}>✕</button>
          <div style={{ flex: 1, height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${((idx + (answered ? 1 : 0)) / cards.length) * 100}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width .3s" }} />
          </div>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{idx + 1}/{cards.length}</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${abbrCatColor(card.category)}22`, color: abbrCatColor(card.category) }}>
            {card.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{FREQ_LABEL[card.freq]}</span>
          {/* 不備を報告するときの識別子。過去問IDと区別するため A- を前置する */}
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, fontFamily: mono }}>A-{card.id}</span>
        </div>

        {/* 問題：意味を表示し、英略語を選ばせる */}
        <div style={{ margin: "4px 0 24px" }}>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 8 }}>この意味を表す英略語は？</div>
          <div style={{ fontSize: 22, lineHeight: 1.5, fontWeight: 700, color: C.text }}>{card.meaning}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {quiz.choices.map((choice, i) => {
            let bg = C.panel, border = C.border, mark = null, txtColor = C.text;
            if (answered) {
              if (i === quiz.answer) { bg = `${C.accent}1a`; border = C.accent; mark = "✓"; txtColor = C.accent; }
              else if (i === selected) { bg = `${C.red}1a`; border = C.red; mark = "✗"; txtColor = C.red; }
              else { txtColor = C.dim; }
            }
            return (
              <button key={choice.id} onClick={() => handleSelect(i)} disabled={answered}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px", borderRadius: 12, textAlign: "left", fontFamily: mono, fontSize: 18, fontWeight: 700, letterSpacing: 0.5,
                  background: bg, border: `1.5px solid ${border}`, color: txtColor, cursor: answered ? "default" : "pointer", transition: "all .15s" }}>
                <span style={{ flex: 1 }}>{choice.abbr}</span>
                {mark && <span style={{ fontSize: 16 }}>{mark}</span>}
              </button>
            );
          })}
        </div>

        {answered && (
          <div style={{ marginTop: 20, padding: 18, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, animation: "fadeIn .3s" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: isCorrect ? C.accent : C.red }}>
                {isCorrect ? "正解" : "不正解"}
              </span>
              <span style={{ fontFamily: mono, fontSize: 18, fontWeight: 800, color: C.text }}>{card.abbr}</span>
              <span style={{ fontSize: 12, color: C.faint }}>{card.kana}</span>
            </div>
            <div style={{ fontSize: 14, color: C.accent, fontWeight: 700, lineHeight: 1.6 }}>{card.full}</div>
            <div style={{ fontSize: 15, color: C.text, fontWeight: 700, marginTop: 8, lineHeight: 1.6 }}>{card.meaning}</div>
            {card.tips && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontSize: 13, color: C.dim, lineHeight: 1.8 }}>
                <span style={{ color: C.amber, fontWeight: 700 }}>豆 </span>{card.tips}
              </div>
            )}
            {/* 正解以外の3語も full/meaning を出す。4択の誤答にも学習価値があるため */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 8, fontFamily: mono, letterSpacing: 0.5 }}>そのほかの語</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {quiz.choices.filter((c) => c.id !== card.id).map((c) => (
                  <div key={c.id}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: C.text }}>{c.abbr}</span>
                      <span style={{ fontSize: 12, color: C.dim }}>{c.full}</span>
                    </div>
                    <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{c.meaning}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {answered && (
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}`, background: C.panel, animation: "slideUp .3s" }}>
          <div style={{ fontSize: 12, color: C.faint, textAlign: "center", marginBottom: 10 }}>
            理解度を選ぶと次回の出題間隔が決まります
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <RateBtn color={C.red} emoji="😓" label="わからない" sub="翌日" onClick={() => handleRate(0)} />
            <RateBtn color={C.amber} emoji="🤔" label="あいまい" sub="2-4日後" onClick={() => handleRate(1)} />
            <RateBtn color={C.accent} emoji="😊" label="覚えた" sub="4日後〜" onClick={() => handleRate(2)} />
          </div>
        </div>
      )}
    </div>
  );
}

function AbbrResult({ log, onHome }) {
  const correct = log.filter((e) => e.correct).length;
  const total = log.length;
  const rate = total ? Math.round((correct / total) * 100) : 0;
  // 間違えた語＋「あいまい/わからない」と自己評価した語を復習候補にする
  const weak = log.filter((e) => !e.correct || e.quality < 2);

  let message, msgColor;
  if (rate >= 80) { message = "素晴らしい！この調子です"; msgColor = C.accent; }
  else if (rate >= 50) { message = "良いペース。復習で確実に"; msgColor = C.blue; }
  else { message = "間違えた語を重点復習しよう"; msgColor = C.amber; }

  return (
    <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>学習おつかれさま</h2>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, textAlign: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 44, fontWeight: 800, color: msgColor }}>{rate}%</div>
        <div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>{correct} / {total} 語 正解</div>
        <div style={{ fontSize: 14, color: msgColor, marginTop: 12, fontWeight: 700 }}>{message}</div>
      </div>

      {weak.length > 0 && (
        <Section title={`もう一度確認したい語 (${weak.length})`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {weak.map((e, i) => (
              <div key={i} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: C.text }}>{e.card.abbr}</span>
                  <span style={{ fontSize: 13, color: C.dim }}>{e.card.meaning}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <div style={{ flex: 1 }} />

      <button onClick={onHome}
        style={{ width: "100%", padding: 18, borderRadius: 14, border: "none", background: `linear-gradient(135deg,${C.accentDim},#238636)`,
          color: "#fff", fontSize: 16, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
        ホームに戻る
      </button>
    </div>
  );
}

// 語一覧：状態別に絞り込んで確認できる
function AbbrList({ states, onBack }) {
  const [filter, setFilter] = useState("all");

  const statusOf = (a) => {
    const c = states[a.id];
    if (!c) return "new";
    if (c.reps >= 3) return "mastered";
    if (c.dueDate <= todayStr()) return "due";
    return "learning";
  };

  const counts = useMemo(() => {
    const m = { all: ABBRS.length, due: 0, learning: 0, mastered: 0, new: 0 };
    ABBRS.forEach((a) => { m[statusOf(a)] += 1; });
    return m;
  }, [states]);

  const list = useMemo(
    () => (filter === "all" ? ABBRS : ABBRS.filter((a) => statusOf(a) === filter)),
    [filter, states]
  );

  const FILTERS = [
    { key: "all", label: "すべて" },
    { key: "due", label: "復習待ち" },
    { key: "learning", label: "学習中" },
    { key: "mastered", label: "定着" },
    { key: "new", label: "未学習" },
  ];
  const STATUS_COLOR = { due: C.amber, learning: C.blue, mastered: C.accent, new: C.faint };
  const STATUS_LABEL = { due: "復習待ち", learning: "学習中", mastered: "定着", new: "未学習" };

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
      <TopBar title="語一覧" onBack={onBack} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans, cursor: "pointer",
                background: active ? C.blue : C.panel, color: active ? "#0d1117" : C.dim,
                border: `1px solid ${active ? C.blue : C.border}`, fontWeight: active ? 700 : 400 }}>
              {f.label} <span style={{ fontSize: 11, opacity: 0.8 }}>{counts[f.key]}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: C.faint, fontSize: 13 }}>該当する語がありません</div>
        )}
        {list.map((a) => {
          const st = statusOf(a);
          const c = states[a.id];
          return (
            <div key={a.id} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: C.text }}>{a.abbr}</span>
                <span style={{ fontSize: 13, color: C.dim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.meaning}</span>
                <span style={{ fontSize: 10, color: STATUS_COLOR[st], fontFamily: mono }}>{STATUS_LABEL[st]}</span>
              </div>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>
                {a.full}
                {c && <span style={{ marginLeft: 8, fontFamily: mono }}>次回: {c.dueDate} / 復習{c.reps}回</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AbbrStats({ states, onBack, onReset }) {
  const learned = ABBRS.filter((a) => states[a.id]).length;
  const mastered = ABBRS.filter((a) => (states[a.id]?.reps || 0) >= 3).length;
  const progress = Math.round((learned / ABBRS.length) * 100);

  // 今後7日間の復習予定
  const upcoming = useMemo(() => {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(Date.now() + d * DAY_MS).toISOString().slice(0, 10);
      const n = ABBRS.filter((a) => {
        const c = states[a.id];
        return c && (d === 0 ? c.dueDate <= date : c.dueDate === date);
      }).length;
      days.push({ date, n, label: d === 0 ? "今日" : d === 1 ? "明日" : `${date.slice(5).replace("-", "/")}` });
    }
    return days;
  }, [states]);
  const maxN = Math.max(1, ...upcoming.map((u) => u.n));

  const handleReset = () => {
    if (window.confirm("英略語の学習進捗をすべてリセットします。よろしいですか？")) onReset();
  };

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1 }}>
      <TopBar title="学習統計" onBack={onBack} />

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: C.dim }}>定着度</span>
          <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: C.accent }}>{progress}%</span>
        </div>
        <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg,${C.accentDim},${C.accent})`, borderRadius: 4 }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
          <Stat label="学習済み" value={learned} unit={`/ ${ABBRS.length}`} />
          <Stat label="記憶定着" value={mastered} unit="語" color={C.blue} />
        </div>
      </div>

      <Section title="今後7日間の復習予定">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90 }}>
          {upcoming.map((u) => (
            <div key={u.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: u.n > 0 ? C.text : C.faint, fontFamily: mono }}>{u.n || ""}</span>
              <div style={{ width: "100%", height: `${(u.n / maxN) * 52}px`, minHeight: u.n > 0 ? 4 : 2,
                background: u.n > 0 ? C.accent : C.border, borderRadius: 3, transition: "height .4s" }} />
              <span style={{ fontSize: 9, color: C.faint }}>{u.label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="分野別の定着">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ABBR_CATEGORIES.map((cat) => {
            const items = ABBRS.filter((a) => a.category === cat);
            if (items.length === 0) return null;
            const done = items.filter((a) => states[a.id]).length;
            const rate = Math.round((done / items.length) * 100);
            return (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.dim }}>{cat}</span>
                  <span style={{ fontFamily: mono, fontSize: 12, color: abbrCatColor(cat) }}>{done}/{items.length}</span>
                </div>
                <div style={{ height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${rate}%`, height: "100%", background: abbrCatColor(cat), borderRadius: 3, transition: "width .5s" }} />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <div style={{ marginTop: 4, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
        <BackupRestore />
      </div>

      <div style={{ flex: 1 }} />

      <button onClick={handleReset}
        style={{ width: "100%", padding: 14, borderRadius: 12, background: "transparent",
          border: `1px solid ${C.red}`, color: C.red, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
        進捗をリセット
      </button>
    </div>
  );
}

// ============================================================
// 模試モード（本番形式・60問通し）
// ============================================================
// 【不変条件】模試は問題の中身（question/choices/answer/explanation/image）を保存しない。
// 保存するのは id だけで、表示のたびに QUESTIONS から引く。そのため data/questions.json を
// 直せば、過去問モードにも模試にも、履歴から開いた過去の模試の見直し画面にまで反映される。
// ここに問題文や選択肢のスナップショットを持たせないこと（修正が二重管理になる）。
//
// 学習履歴（STORAGE_KEY）には一切書き込まない。updateCard を受け取らないことで構造的に保証する。

// 本番（科目A 60問）の分野配分。テクノロジ系42 / マネジメント6 / ストラテジ12。
const MOCK_BLUEPRINT = [
  ["基礎理論", 5], ["アルゴリズム", 4], ["コンピュータ構成", 8], ["ソフトウェア", 9],
  ["データベース", 4], ["ネットワーク", 5], ["セキュリティ", 7],   // テクノロジ系 計42
  ["マネジメント", 6],
  ["ストラテジ", 12],
];
const MOCK_TOTAL = MOCK_BLUEPRINT.reduce((s, [, n]) => s + n, 0);
const MOCK_TECH_CATS = ["基礎理論", "アルゴリズム", "コンピュータ構成", "ソフトウェア", "データベース", "ネットワーク", "セキュリティ"];
const MOCK_AVOID_RUNS = 3;   // 直近何回分の出題を避けるか

// ===== 問題プール =====

let _qById = null;
function questionById(id) {
  if (!_qById) {
    _qById = new Map();
    QUESTIONS.forEach((q) => _qById.set(q.id, q));
  }
  return _qById.get(id);
}

// IPAの再出題により本文がほぼ同じ問題が複数ある。同じ模試に2問入らないよう代表1問へ畳む。
// 正規化は「空白と約物を除いた先頭80字」。選択肢の一致は条件に入れない
// （同一問題でもOCRのゆれやLaTeX化の有無で選択肢の文字列が食い違うため、厳しくすると取りこぼす）。
function mockNormKey(q) {
  return q.question.replace(/[\s（）()、。,.]/g, "").slice(0, 80);
}

let _mockPool = null;
function mockPool() {
  if (_mockPool) return _mockPool;
  const groups = new Map();
  QUESTIONS.forEach((q) => {
    const k = mockNormKey(q);
    const g = groups.get(k);
    if (g) g.push(q); else groups.set(k, [q]);
  });
  // 代表の選び方: NO1/NO2/NO3系（初期取り込み分でOCR品質が劣る）を避け、
  // 新しい年度を優先し、最後は id の辞書順で安定させる（毎回同じ代表を選ぶため）。
  const cmp = (a, b) => {
    const na = a.id.startsWith("NO") ? 1 : 0, nb = b.id.startsWith("NO") ? 1 : 0;
    if (na !== nb) return na - nb;
    const sa = SETS.indexOf(a.set), sb = SETS.indexOf(b.set);
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const byCat = {};
  CATEGORIES.forEach((c) => { byCat[c] = []; });
  const keyOf = new Map();
  groups.forEach((list, k) => {
    const rep = list.length === 1 ? list[0] : [...list].sort(cmp)[0];
    keyOf.set(rep.id, k);
    if (byCat[rep.category]) byCat[rep.category].push(rep);
  });
  _mockPool = { byCat, keyOf };
  return _mockPool;
}

// 分野クオータで60問を引く。avoidIds は直近の模試で出た問題（見覚え感を減らすためのソフト制約）。
function pickMockSet(avoidIds) {
  const { byCat, keyOf } = mockPool();
  const avoid = new Set(avoidIds);
  const usedIds = new Set();
  const usedKeys = new Set();   // 重複問題の二重採用を防ぐ
  const picked = [];

  const take = (cands, n) => {
    let got = 0;
    for (const q of shuffleArray(cands)) {
      if (got >= n) break;
      if (usedIds.has(q.id) || usedKeys.has(keyOf.get(q.id))) continue;
      usedIds.add(q.id);
      usedKeys.add(keyOf.get(q.id));
      picked.push(q);
      got++;
    }
    return got;
  };

  MOCK_BLUEPRINT.forEach(([cat, n]) => {
    const pool = byCat[cat] || [];
    let got = take(pool.filter((q) => !avoid.has(q.id)), n);
    // 以下は将来データを減らしたときの安全装置。現在の収録数では発動しない。
    if (got < n) got += take(pool, n - got);                       // 直近の出題を避けきれない
    if (got < n) {                                                  // 分野が枯れている→同系統から補う
      const sibs = (MOCK_TECH_CATS.includes(cat) ? MOCK_TECH_CATS : CATEGORIES).filter((c) => c !== cat);
      for (const c of sibs) {
        if (got >= n) break;
        got += take(byCat[c] || [], n - got);
      }
    }
  });
  return picked;
}

// ===== 進行中データ =====

function newMockProgress(runs) {
  const avoid = new Set();
  (runs || []).slice(0, MOCK_AVOID_RUNS).forEach((r) => (r.ids || []).forEach((id) => avoid.add(id)));
  const qs = pickMockSet([...avoid]);
  const now = Date.now();
  return {
    v: 1, startedAt: now, updatedAt: now, elapsedMs: 0,
    ids: qs.map((q) => q.id),
    orders: qs.map((q) => makeChoiceOrder(q)),
    answers: qs.map(() => null),
    flags: qs.map(() => false),     // 「あとで解く」の印
    hashes: qs.map((q) => choicesHash(q)),
    idx: 0,
  };
}

// 保存された進行中データを現在の questions.json に合わせて復元する。
// 問題が1つでも消えていたら部分復元はしない（分野配分が崩れた模試を続けさせても意味がない）。
// 選択肢が後から修正された問題は、表示順を作り直して解答を消す（repaired に数える）。
function hydrateProgress(p) {
  if (!p || p.v !== 1 || !Array.isArray(p.ids) || p.ids.length === 0) return null;
  const qs = p.ids.map(questionById);
  if (qs.some((q) => !q)) return null;

  const orders = Array.isArray(p.orders) ? [...p.orders] : [];
  const answers = Array.isArray(p.answers) ? [...p.answers] : [];
  const hashes = Array.isArray(p.hashes) ? p.hashes : [];
  // flags は後から足した項目。無い中断データ（旧版）は全問「印なし」で再開する
  const flags = qs.map((_, i) => Array.isArray(p.flags) && p.flags[i] === true);
  let repaired = 0;

  qs.forEach((q, i) => {
    const o = orders[i];
    const validOrder = Array.isArray(o) && o.length === 4 && [0, 1, 2, 3].every((n) => o.includes(n));
    if (hashes[i] !== choicesHash(q)) {
      orders[i] = makeChoiceOrder(q);          // 選択肢が修正された → 解答し直し
      if (answers[i] != null) repaired++;
      answers[i] = null;
    } else if (!validOrder) {
      orders[i] = makeChoiceOrder(q);          // 保存データの破損
    }
    const a = answers[i];
    if (a != null && !(Number.isInteger(a) && a >= 0 && a <= 3)) answers[i] = null;
  });

  return {
    v: 1,
    startedAt: p.startedAt || Date.now(),
    elapsedMs: Math.max(0, p.elapsedMs || 0),
    ids: p.ids, orders, answers, flags,
    hashes: qs.map((q) => choicesHash(q)),
    idx: Math.min(Math.max(0, p.idx | 0), qs.length - 1),
    qs, repaired,
  };
}

function saveProgress(p, answers, flags, idx, elapsedMs) {
  return saveJSON(MOCK_PROGRESS_KEY, {
    v: 1, startedAt: p.startedAt, updatedAt: Date.now(), elapsedMs,
    ids: p.ids, orders: p.orders, hashes: p.hashes, answers, flags, idx,
  });
}

// ===== 採点 =====

// corrects は正誤を "1"/"0" の文字列で凍結する。あとから answer が修正されても、
// その日に取った点数と問題別の○×が食い違わないようにするため。
function gradeMock(p, answers, elapsedMs) {
  const byCat = {};
  let correct = 0;
  let corrects = "";
  let ratings = "";
  p.ids.forEach((id, i) => {
    const q = questionById(id);
    const cat = q ? q.category : "不明";
    const cell = byCat[cat] || (byCat[cat] = [0, 0]);
    cell[0]++;
    const ok = !!q && answers[i] === q.answer;
    if (ok) { cell[1]++; correct++; }
    corrects += ok ? "1" : "0";
    ratings += !q ? "-" : ok ? "2" : "0";   // 既定の理解度: 正解→わかった／不正解・未回答→わからない
  });
  return {
    v: 1, runId: "m-" + p.startedAt,
    startedAt: p.startedAt, finishedAt: Date.now(), elapsedMs,
    total: p.ids.length, correct, byCat,
    ids: p.ids, answers, hashes: p.hashes, corrects, ratings,
  };
}

function loadMockHistory() {
  const d = loadJSON(MOCK_STORAGE_KEY, null);
  if (!d || d.v !== 1 || !Array.isArray(d.runs)) return [];
  return d.runs.filter((r) => r && r.v === 1 && Array.isArray(r.ids));
}

function saveMockHistory(runs) {
  return saveJSON(MOCK_STORAGE_KEY, { v: 1, runs: runs.slice(0, MOCK_HISTORY_MAX) });
}

const fmtStamp = (ts) => {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// 起動時に進行中データを読む。問題が削除されていて復元できないときは、
// 中途半端な状態を残さず捨てたうえで理由を知らせる。
function bootMockProgress() {
  const raw = loadJSON(MOCK_PROGRESS_KEY, null);
  const h = hydrateProgress(raw);
  if (raw && !h) {
    localStorage.removeItem(MOCK_PROGRESS_KEY);
    return { progress: null, notice: "問題データが更新されたため、中断していた模試は再開できませんでした" };
  }
  return { progress: h, notice: null };
}

const lastTs = (card) => (card && card.history.length ? card.history[card.history.length - 1].ts : null);

// ===== 模試モードのルート =====
function MockApp({ onBusyChange, cardStates, setCards }) {
  const [screen, setScreen] = useState("home");
  const [runs, setRuns] = useState(loadMockHistory);
  const [boot] = useState(bootMockProgress);
  const [progress, setProgress] = useState(boot.progress);
  const [notice, setNotice] = useState(boot.notice);
  const [current, setCurrent] = useState(null);      // 表示中の結果（直後 or 履歴）
  const [scoreFrom, setScoreFrom] = useState("home");
  const [detail, setDetail] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [histFailed, setHistFailed] = useState(false);
  // 採点直前の学習カード（メモリのみ）。理解度を選び直したときは、ここから作り直して置き換える
  // （reviewCard を重ねると履歴が2回分積まれるため）。これが無い＝履歴から開いた過去の模試なので選び直せない
  // written は模試が書いた履歴の ts。過去問モードで同じ問題を解き直した後は一致しなくなるので、上書きしない
  const [snapshot, setSnapshot] = useState(null);   // { runId, cards: {id: card|null}, written: {id: ts} }

  useEffect(() => { onBusyChange(screen === "exam"); }, [screen, onBusyChange]);

  const progressRef = React.useRef(null);
  progressRef.current = progress;

  const persist = useCallback(({ answers, flags, idx, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) return;
    setSaveFailed(!saveProgress(p, answers, flags, idx, elapsedMs));
  }, []);

  const startNew = () => {
    const raw = newMockProgress(runs);
    const h = hydrateProgress(raw);
    if (!h) { setNotice("問題を抽出できませんでした"); return; }
    saveJSON(MOCK_PROGRESS_KEY, raw);
    setProgress(h);
    setNotice(null);
    setScreen("exam");
  };

  const resume = () => { setNotice(null); setScreen("exam"); };

  const discard = () => {
    if (!window.confirm("中断した模試を破棄します。よろしいですか？")) return;
    localStorage.removeItem(MOCK_PROGRESS_KEY);
    setProgress(null);
    setSaveFailed(false);
  };

  const suspend = ({ answers, flags, idx, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) { setScreen("home"); return; }
    setSaveFailed(!saveProgress(p, answers, flags, idx, elapsedMs));
    setProgress({ ...p, answers, flags, idx, elapsedMs, repaired: 0 });
    setScreen("home");
  };

  const submit = ({ answers, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) { setScreen("home"); return; }
    const run = gradeMock(p, answers, elapsedMs);
    // 既定の理解度で過去問モードの復習に登録する
    const before = {}, cards = {}, written = {};
    run.ids.forEach((id, i) => {
      if (run.ratings[i] === "-") return;     // 削除済みの問題
      before[id] = cardStates[id] || null;
      cards[id] = reviewCard(before[id] || initCard(), Number(run.ratings[i]), run.corrects[i] === "1");
      written[id] = lastTs(cards[id]);
    });
    setCards(cards);
    setSnapshot({ runId: run.runId, cards: before, written });
    persistRuns([run, ...runs]);
    localStorage.removeItem(MOCK_PROGRESS_KEY);
    setProgress(null);
    setSaveFailed(false);
    setCurrent(run);
    setScoreFrom("home");
    setScreen("score");
  };

  function persistRuns(all) {
    let list = all.slice(0, MOCK_HISTORY_MAX);
    let ok = saveMockHistory(list);
    while (!ok && list.length > 1) {          // 容量オーバー → 古いものから捨ててリトライ
      list = list.slice(0, list.length - 1);
      ok = saveMockHistory(list);
    }
    setHistFailed(!ok);
    setRuns(list);
  }

  // 理解度の選び直し。採点直後の結果画面（snapshot がこの回のもの）でだけ渡す
  const canRate = !!(snapshot && current && snapshot.runId === current.runId);
  const rate = (i, r) => {
    const run = current;
    const id = run.ids[i];
    if (!canRate || !(id in snapshot.cards) || run.ratings[i] === String(r)) return;
    if (lastTs(cardStates[id]) !== snapshot.written[id]) {
      window.alert("この問題は模試のあとに過去問モードで解いているため、理解度は変更できません");
      return;
    }
    const card = reviewCard(snapshot.cards[id] || initCard(), r, run.corrects[i] === "1");
    setCards({ [id]: card });
    setSnapshot({ ...snapshot, written: { ...snapshot.written, [id]: lastTs(card) } });
    const next = { ...run, ratings: run.ratings.slice(0, i) + r + run.ratings.slice(i + 1) };
    setCurrent(next);
    persistRuns(runs.map((x) => (x.runId === next.runId ? next : x)));
  };

  const openRun = (run) => { setCurrent(run); setScoreFrom("history"); setScreen("score"); };

  const openDetail = (i) => {
    const run = current;
    const q = questionById(run.ids[i]);
    if (!q) return;
    // 選択肢が後から修正されていたら、保存してある解答番号は別の選択肢を指している可能性が
    // あるのでハイライトしない（§修正済みバッジ）
    const edited = run.hashes && run.hashes[i] !== choicesHash(q);
    setDetail({ i, q, selected: edited ? null : run.answers[i] });
    setScreen("detail");
  };

  // 詳細画面の前後移動。削除済みの問題は飛ばす
  const stepDetail = (dir) => {
    for (let j = detail.i + dir; j >= 0 && j < current.ids.length; j += dir) {
      if (questionById(current.ids[j])) { openDetail(j); return; }
    }
  };

  return (
    <>
      {screen === "home" && (
        <MockHome
          progress={progress} runs={runs} notice={notice} saveFailed={saveFailed}
          onStart={startNew} onResume={resume} onDiscard={discard}
          onHistory={() => setScreen("history")}
        />
      )}
      {screen === "exam" && progress && (
        <MockExamScreen
          key={progress.startedAt} init={progress} saveFailed={saveFailed}
          onPersist={persist} onSuspend={suspend} onSubmit={submit}
        />
      )}
      {(screen === "history" || (scoreFrom === "history" && (screen === "score" || screen === "detail"))) && (
        <div style={{ display: screen === "history" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <MockHistoryScreen runs={runs} onOpen={openRun} onBack={() => setScreen("home")} />
        </div>
      )}
      {(screen === "score" || screen === "detail") && current && (
        <div style={{ display: screen === "score" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <MockScore
            run={current} isFresh={scoreFrom === "home"} histFailed={histFailed}
            onRate={canRate ? rate : null}
            onOpen={openDetail} onBack={() => setScreen(scoreFrom)}
          />
        </div>
      )}
      {screen === "detail" && detail && current && (
        <MockDetail
          key={detail.i} i={detail.i} total={current.ids.length}
          rating={current.ratings ? current.ratings[detail.i] : undefined}
          onRate={canRate ? (r) => rate(detail.i, r) : null}
          onStep={stepDetail}
        >
          <QuestionDetail
            key={detail.q.id} q={detail.q} selected={detail.selected}
            revealStart={true} onBack={() => setScreen("score")}
          />
        </MockDetail>
      )}
    </>
  );
}

// ===== 模試ホーム =====
function MockHome({ progress, runs, notice, saveFailed, onStart, onResume, onDiscard, onHistory }) {
  const last = runs[0];
  const done = progress ? progress.answers.filter((a) => a != null).length : 0;

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1, overflowY: "auto" }}>
      <div style={{ paddingTop: 12 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>模試</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: C.dim, lineHeight: 1.7 }}>
          過去問から本番の分野配分どおりに{MOCK_TOTAL}問を抽選し、通しで解きます。<br />
          採点は最後にまとめて。結果は過去問モードの復習に登録されます（理解度は結果画面で選び直せます）。
        </p>
      </div>

      {notice && (
        <div style={{ padding: 12, borderRadius: 10, background: `${C.amber}14`, border: `1px solid ${C.amber}55`, fontSize: 13, color: C.amber }}>
          {notice}
        </div>
      )}

      {progress && (
        <div style={{ padding: 16, borderRadius: 14, background: C.panel, border: `1px solid ${C.blue}55` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, marginBottom: 4 }}>中断した模試があります</div>
          <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, marginBottom: 12 }}>
            {done}/{progress.ids.length}問・経過 {fmtMs(progress.elapsedMs)}・{fmtStamp(progress.startedAt)}開始
          </div>
          {saveFailed && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>⚠ 中断の保存ができていません</div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onResume}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: "none", background: C.blue, color: "#0d1117", fontSize: 14, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
              再開する
            </button>
            <button onClick={onDiscard}
              style={{ padding: "12px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
              破棄
            </button>
          </div>
        </div>
      )}

      <button onClick={onStart} disabled={!!progress}
        style={{ ...cardBtn, border: "none", cursor: progress ? "default" : "pointer", opacity: progress ? 0.4 : 1,
          background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff" }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>🏁 模試を始める</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          {MOCK_TOTAL}問・通し・毎回ちがうセット{progress ? "（先に中断中の模試を終えるか破棄してください）" : ""}
        </div>
      </button>

      <Section title="分野配分">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {MOCK_BLUEPRINT.map(([cat, n]) => (
            <span key={cat} style={{ padding: "5px 10px", borderRadius: 20, fontSize: 12, fontFamily: sans,
              background: `${catColor(cat)}1a`, color: catColor(cat), border: `1px solid ${catColor(cat)}44` }}>
              {cat} <span style={{ fontFamily: mono, fontWeight: 700 }}>{n}</span>
            </span>
          ))}
        </div>
      </Section>

      {last && (
        <Section title="直近の成績">
          <button onClick={onHistory}
            style={{ width: "100%", padding: 16, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, cursor: "pointer", fontFamily: sans, textAlign: "left", display: "flex", alignItems: "center", gap: 14 }}>
            <div>
              <div style={{ fontFamily: mono, fontSize: 24, fontWeight: 800, color: rateColor(Math.round((last.correct / last.total) * 100)) }}>
                {Math.round((last.correct / last.total) * 100)}<span style={{ fontSize: 13 }}>%</span>
              </div>
              <div style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{last.correct}/{last.total}問</div>
            </div>
            <div style={{ flex: 1, fontSize: 12, color: C.dim }}>
              {fmtStamp(last.startedAt)}<br />
              <span style={{ fontFamily: mono }}>所要 {fmtMs(last.elapsedMs)}</span>
            </div>
            <span style={{ fontSize: 18, color: C.faint }}>›</span>
          </button>
        </Section>
      )}

      <button onClick={onHistory} disabled={runs.length === 0}
        style={{ padding: 14, borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel,
          color: runs.length ? C.text : C.faint, fontSize: 14, fontFamily: sans, cursor: runs.length ? "pointer" : "default" }}>
        履歴を見る{runs.length ? `（${runs.length}回）` : "（まだありません）"}
      </button>
    </div>
  );
}

const rateColor = (rate) => (rate >= 80 ? C.accent : rate >= 60 ? C.blue : C.amber);

// ===== 模試の実施画面（通し・答えは見せない） =====
function MockExamScreen({ init, saveFailed, onPersist, onSuspend, onSubmit }) {
  const { qs, orders } = init;
  const [answers, setAnswers] = useState(init.answers);
  const [idx, setIdx] = useState(init.idx);
  const [palette, setPalette] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [repairNotice, setRepairNotice] = useState(init.repaired > 0);
  const [flags, setFlags] = useState(init.flags);     // 「あとで解く」の印

  const ms = useTimer(true, init.startedAt, true);
  const totalMs = init.elapsedMs + ms;
  const msRef = React.useRef(0);
  msRef.current = ms;

  const bodyRef = React.useRef(null);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [idx]);

  const liveRef = React.useRef({ answers, flags, idx });
  liveRef.current = { answers, flags, idx };

  // 保存トリガは「解答」「移動」「60秒ごと」「非表示化」「離脱」だけ。
  // タイマー更新（250ms）では保存しない（setItem は同期I/O）。
  const persistNow = useCallback(() => {
    const l = liveRef.current;
    onPersist({ answers: l.answers, flags: l.flags, idx: l.idx, elapsedMs: init.elapsedMs + msRef.current });
  }, [onPersist, init.elapsedMs]);

  useEffect(() => {
    const t = setInterval(persistNow, 60000);
    const onVis = () => { if (document.visibilityState === "hidden") persistNow(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", persistNow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", persistNow);
    };
  }, [persistNow]);

  const commit = (nextAnswers, nextIdx, nextFlags = flags) => {
    setAnswers(nextAnswers);
    setIdx(nextIdx);
    setFlags(nextFlags);
    onPersist({ answers: nextAnswers, flags: nextFlags, idx: nextIdx, elapsedMs: init.elapsedMs + msRef.current });
  };

  const q = qs[idx];
  const answeredCount = answers.filter((a) => a != null).length;
  const unanswered = answers.reduce((acc, a, i) => (a == null ? [...acc, i] : acc), []);
  const flagged = flags.reduce((acc, f, i) => (f ? [...acc, i] : acc), []);

  const select = (origIdx) => {
    const next = [...answers];
    next[idx] = origIdx;
    commit(next, idx);
  };

  const go = (n) => {
    const next = Math.min(Math.max(0, n), qs.length - 1);
    if (next !== idx) commit(answers, next);
  };

  // 印を付けたら次の問題へ進む（最終問は印だけ）。印を外すときは移動しない。
  // 選択肢を選んでも印は外さない（「答えたが見直したい」にも使えるように）
  const toggleFlag = () => {
    const next = [...flags];
    next[idx] = !flags[idx];
    commit(answers, next[idx] ? Math.min(idx + 1, qs.length - 1) : idx, next);
  };

  const quit = () => {
    if (!window.confirm("模試を中断します。あとで再開できます。よろしいですか？")) return;
    onSuspend({ answers, flags, idx, elapsedMs: init.elapsedMs + msRef.current });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "100vh" }}>
      <div style={{ padding: "14px 20px 10px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={quit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0 }}>✕</button>
          <div style={{ flex: 1, height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${(answeredCount / qs.length) * 100}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width .3s" }} />
          </div>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{fmtMs(totalMs)}</span>
          <button onClick={() => setPalette(true)}
            style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", color: C.text, fontSize: 12, fontFamily: mono, cursor: "pointer" }}>
            {idx + 1}/{qs.length}
          </button>
        </div>
        {saveFailed && (
          <div style={{ marginTop: 8, fontSize: 11, color: C.red }}>⚠ 中断の保存ができていません（このまま解き終えてください）</div>
        )}
        {repairNotice && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.amber, flex: 1 }}>
              {init.repaired}問が修正されたため解答し直しになります
            </span>
            <button onClick={() => setRepairNotice(false)}
              style={{ background: "transparent", border: "none", color: C.faint, fontSize: 12, cursor: "pointer", padding: 0 }}>閉じる</button>
          </div>
        )}
      </div>

      <div ref={bodyRef} style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${catColor(q.category)}22`, color: catColor(q.category) }}>
            {q.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{q.set}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, fontFamily: mono }}>{q.id}</span>
        </div>

        <RichText text={q.question} style={{ fontSize: 17, lineHeight: 1.7, fontWeight: 500, margin: "0 0 24px" }} />

        {q.image && (
          <img src={q.image} alt="問題の図"
            style={{ width: "100%", maxWidth: 420, borderRadius: 8, border: `1px solid ${C.border}`, margin: "-8px 0 24px", display: "block", backgroundColor: "#fff" }} />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {orders[idx].map((origIdx, displayIdx) => {
            const chosen = answers[idx] === origIdx;
            return (
              <button key={origIdx} onClick={() => select(origIdx)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12, textAlign: "left", fontFamily: sans, fontSize: 15, lineHeight: 1.5,
                  background: chosen ? `${C.blue}1a` : C.panel, border: `1.5px solid ${chosen ? C.blue : C.border}`,
                  color: C.text, cursor: "pointer", transition: "all .15s" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: chosen ? C.blue : C.faint, minWidth: 18, fontWeight: chosen ? 700 : 400 }}>{"アイウエ"[displayIdx]}</span>
                <RichText as="span" text={q.choices[origIdx]} style={{ flex: 1 }} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "12px 20px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.panel, display: "flex", gap: 10 }}>
        <button onClick={() => go(idx - 1)} disabled={idx === 0}
          style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent", color: idx === 0 ? C.faint : C.text, fontSize: 14, fontFamily: sans, cursor: idx === 0 ? "default" : "pointer" }}>
          ← 前へ
        </button>
        <button onClick={toggleFlag}
          style={{ padding: "12px 12px", borderRadius: 10, border: `1px solid ${flags[idx] ? C.amber : C.border}`, background: flags[idx] ? `${C.amber}1a` : "transparent", color: flags[idx] ? C.amber : C.dim, fontSize: 13, fontFamily: sans, cursor: "pointer", whiteSpace: "nowrap" }}>
          {flags[idx] ? "🔖 印を外す" : "🔖 あとで"}
        </button>
        {idx < qs.length - 1 ? (
          <button onClick={() => go(idx + 1)}
            style={{ flex: 1, padding: 12, borderRadius: 10, border: "none", background: C.blue, color: "#0d1117", fontSize: 15, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
            次へ →
          </button>
        ) : (
          <button onClick={() => setConfirm(true)}
            style={{ flex: 1, padding: 12, borderRadius: 10, border: "none", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff", fontSize: 15, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
            採点する
          </button>
        )}
      </div>

      {palette && (
        <MockSheet onClose={() => setPalette(false)}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>解答状況</div>
          <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, marginBottom: 12 }}>
            回答済み {answeredCount} / 未回答 {qs.length - answeredCount}
            {flagged.length > 0 && <span style={{ color: C.amber }}> / 🔖あとで {flagged.length}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6, marginBottom: 16 }}>
            {qs.map((_, i) => {
              const cur = i === idx, ans = answers[i] != null, fl = flags[i];
              return (
                <button key={i} onClick={() => { go(i); setPalette(false); }}
                  style={{ position: "relative", aspectRatio: "1", borderRadius: 6, fontFamily: mono, fontSize: 11, cursor: "pointer",
                    background: ans ? `${C.blue}33` : C.bg,
                    border: `1.5px solid ${cur ? C.accent : fl ? C.amber : ans ? C.blue + "88" : C.border}`,
                    color: ans ? C.text : C.faint, fontWeight: cur ? 700 : 400, padding: 0 }}>
                  {i + 1}
                  {fl && <span style={{ position: "absolute", top: -5, right: -3, fontSize: 9 }}>🔖</span>}
                </button>
              );
            })}
          </div>
          <button onClick={() => { setPalette(false); setConfirm(true); }}
            style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff", fontSize: 15, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
            採点する
          </button>
        </MockSheet>
      )}

      {confirm && (
        <MockSheet onClose={() => setConfirm(false)}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>採点しますか？</div>
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.7, marginBottom: 12 }}>
            {unanswered.length > 0
              ? <>未回答が <span style={{ color: C.amber, fontFamily: mono, fontWeight: 700 }}>{unanswered.length}問</span> あります。未回答は不正解として集計されます。</>
              : <>全{qs.length}問に解答済みです。</>}
          </div>
          <MockJumpList title="未回答" color={C.amber} items={unanswered} qs={qs} answers={answers}
            onJump={(i) => { go(i); setConfirm(false); }} />
          <MockJumpList title="🔖 あとで解く" color={C.amber} items={flagged} qs={qs} answers={answers}
            onJump={(i) => { go(i); setConfirm(false); }} />
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => setConfirm(false)}
              style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
              戻る
            </button>
            <button onClick={() => onSubmit({ answers, elapsedMs: init.elapsedMs + msRef.current })}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: "none", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff", fontSize: 15, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
              採点する
            </button>
          </div>
        </MockSheet>
      )}
    </div>
  );
}

// 採点前の確認シートに出す問題の一覧（タップでその問題へ）。中身は questions.json から引くだけで保存しない
function MockJumpList({ title, color, items, qs, answers, onJump }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 6 }}>{title}（{items.length}問）</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((i) => (
          <button key={i} onClick={() => onJump(i)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: C.bg, border: `1px solid ${C.border}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
            <span style={{ fontFamily: mono, fontSize: 12, color: C.dim, minWidth: 34 }}>問{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(qs[i].question)}</span>
            {answers[i] == null && <span style={{ fontSize: 10, color: C.amber }}>未回答</span>}
            <span style={{ fontSize: 16, color: C.faint }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MockSheet({ onClose, children }) {
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "#000000aa", zIndex: 30, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, background: C.panel, borderTop: `1px solid ${C.border}`, borderRadius: "16px 16px 0 0",
          padding: 18, paddingBottom: "calc(18px + env(safe-area-inset-bottom))", maxHeight: "78vh", overflowY: "auto", animation: "slideUp .2s" }}>
        {children}
      </div>
    </div>
  );
}

// ===== 模試の結果（実施直後と履歴の両方で使う） =====
// 理解度（過去問モードの RateBtn と同じ 0/1/2）
const MOCK_RATES = [
  { r: 0, emoji: "😓", label: "わからない", color: C.red },
  { r: 1, emoji: "🤔", label: "迷った", color: C.amber },
  { r: 2, emoji: "😊", label: "わかった", color: C.accent },
];

// onRate が無い（履歴から開いた過去の模試）ときは、登録した理解度を表示するだけ
function MockRateChips({ rating, onRate, big }) {
  if (rating == null || rating === "-") return null;
  const opts = onRate ? MOCK_RATES : MOCK_RATES.filter((o) => String(o.r) === rating);
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {opts.map((o) => {
        const on = String(o.r) === rating;
        return (
          <button key={o.r} onClick={onRate ? (e) => { e.stopPropagation(); onRate(o.r); } : undefined}
            style={{ flex: big ? 1 : "none", padding: big ? "10px 6px" : "4px 9px", borderRadius: 8, fontFamily: sans, fontSize: big ? 13 : 11,
              background: on ? `${o.color}22` : "transparent", border: `1px solid ${on ? o.color : C.border}`,
              color: on ? o.color : C.faint, fontWeight: on ? 700 : 400, cursor: onRate ? "pointer" : "default" }}>
            {o.emoji} {o.label}
          </button>
        );
      })}
    </div>
  );
}

function MockScore({ run, isFresh, histFailed, onRate, onOpen, onBack }) {
  const rate = run.total ? Math.round((run.correct / run.total) * 100) : 0;
  const col = rateColor(rate);
  const message = rate >= 80 ? "合格ラインを大きく超えています"
    : rate >= 60 ? "合格ライン（60%）を超えています"
    : "合格ラインは60%。間違えた分野を重点的に";

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1, overflowY: "auto" }}>
      <TopBar title={isFresh ? "模試の結果" : "過去の模試"} onBack={onBack} />

      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, marginBottom: 8 }}>{fmtStamp(run.startedAt)}</div>
        <div style={{ position: "relative", width: 150, height: 150, margin: "0 auto" }}>
          <svg width="150" height="150" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="75" cy="75" r="64" fill="none" stroke={C.panel} strokeWidth="11" />
            <circle cx="75" cy="75" r="64" fill="none" stroke={col} strokeWidth="11" strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 64}`} strokeDashoffset={`${2 * Math.PI * 64 * (1 - rate / 100)}`}
              style={{ transition: "stroke-dashoffset 1s ease" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 38, fontWeight: 800, color: col }}>{rate}<span style={{ fontSize: 18 }}>%</span></span>
            <span style={{ fontSize: 13, color: C.dim }}>{run.correct} / {run.total} 問正解</span>
          </div>
        </div>
        <p style={{ marginTop: 14, marginBottom: 4, fontSize: 15, fontWeight: 600, color: col }}>{message}</p>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.faint }}>所要時間 {fmtMs(run.elapsedMs)}</div>
      </div>

      {histFailed && isFresh && (
        <div style={{ padding: 12, borderRadius: 10, background: `${C.red}14`, border: `1px solid ${C.red}55`, fontSize: 13, color: C.red }}>
          履歴を保存できませんでした（この結果は画面を離れると消えます）
        </div>
      )}

      <Section title="分野別の正答率">
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {CATEGORIES.filter((c) => run.byCat[c]).map((c) => (
            <CatRateBar key={c} cat={c} n={run.byCat[c][0]} c={run.byCat[c][1]} />
          ))}
        </div>
      </Section>

      <Section title="問題別レビュー（タップで詳細）">
        {run.ratings && (
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6, marginBottom: 10 }}>
            {onRate
              ? "この結果は過去問モードの復習に登録しました（正解→わかった／不正解→わからない）。理解度はここで選び直せます。"
              : "この模試の結果は、下の理解度で過去問モードの復習に登録済みです。"}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {run.ids.map((id, i) => {
            const q = questionById(id);
            const ok = run.corrects ? run.corrects[i] === "1" : (!!q && run.answers[i] === q.answer);
            if (!q) {
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${C.border}`, opacity: 0.5 }}>
                  <span style={{ fontFamily: mono, fontSize: 16, color: C.faint, minWidth: 16 }}>{ok ? "✓" : "✗"}</span>
                  <div style={{ flex: 1, fontSize: 13, color: C.faint }}>（この問題は削除されました）</div>
                  <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{id}</span>
                </div>
              );
            }
            const edited = run.hashes && run.hashes[i] !== choicesHash(q);
            return (
              <div key={i} style={{ borderRadius: 10, background: C.panel, border: `1px solid ${ok ? C.border : C.red + "44"}` }}>
              <button onClick={() => onOpen(i)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: "transparent", border: "none", textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
                <span style={{ fontFamily: mono, fontSize: 16, color: ok ? C.accent : C.red, fontWeight: 700, minWidth: 16 }}>{ok ? "✓" : "✗"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(q.question)}</div>
                  <div style={{ fontSize: 11, color: catColor(q.category), marginTop: 2 }}>
                    {q.category}
                    {run.answers[i] == null && <span style={{ color: C.amber, marginLeft: 8 }}>未回答</span>}
                    {edited && <span style={{ color: C.faint, marginLeft: 8 }}>修正済み</span>}
                  </div>
                </div>
                <span style={{ fontSize: 18, color: C.faint }}>›</span>
              </button>
              {run.ratings && (
                <div style={{ padding: "0 14px 10px 40px" }}>
                  <MockRateChips rating={run.ratings[i]} onRate={onRate ? (r) => onRate(i, r) : null} />
                </div>
              )}
              </div>
            );
          })}
        </div>
      </Section>

      <button onClick={onBack}
        style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans, cursor: "pointer", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff" }}>
        {isFresh ? "模試ホームに戻る" : "履歴に戻る"}
      </button>
    </div>
  );
}

// 結果画面から開いた問題詳細。左右スワイプ／下部ボタンで前後の問題へ、理解度もここで選べる。
// QuestionDetail は他の画面と共用なので手を入れず、外側で包む
function MockDetail({ i, total, rating, onRate, onStep, children }) {
  const start = React.useRef(null);
  useEffect(() => { window.scrollTo(0, 0); }, [i]);
  const onTouchStart = (e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e) => {
    const s0 = start.current;
    start.current = null;
    if (!s0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s0.x, dy = t.clientY - s0.y;
    // 縦スクロールや表の横スクロールを拾わないよう、はっきり横に払ったときだけ
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) onStep(dx < 0 ? 1 : -1);
  };
  const navBtn = (disabled) => ({ padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent",
    color: disabled ? C.faint : C.text, fontSize: 13, fontFamily: sans, cursor: disabled ? "default" : "pointer" });
  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {children}
      <div style={{ position: "sticky", bottom: 0, padding: "10px 20px", paddingBottom: "calc(10px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.panel, display: "flex", flexDirection: "column", gap: 10 }}>
        {rating != null && rating !== "-" && <MockRateChips rating={rating} onRate={onRate} big />}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => onStep(-1)} disabled={i === 0} style={navBtn(i === 0)}>← 前の問題</button>
          <span style={{ flex: 1, textAlign: "center", fontFamily: mono, fontSize: 12, color: C.dim }}>{i + 1}/{total}</span>
          <button onClick={() => onStep(1)} disabled={i === total - 1} style={navBtn(i === total - 1)}>次の問題 →</button>
        </div>
      </div>
    </div>
  );
}

function CatRateBar({ cat, n, c }) {
  const rate = n ? Math.round((c / n) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 12, color: C.dim, minWidth: 96 }}>{cat}</span>
      <div style={{ flex: 1, height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${rate}%`, height: "100%", background: catColor(cat), borderRadius: 4 }} />
      </div>
      <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, minWidth: 62, textAlign: "right" }}>{c}/{n}・{rate}%</span>
    </div>
  );
}

// ===== 模試の履歴 =====
function MockHistoryScreen({ runs, onOpen, onBack }) {
  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 18, flex: 1, overflowY: "auto" }}>
      <TopBar title="模試の履歴" onBack={onBack} />

      {runs.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.faint, fontSize: 13 }}>まだ模試の記録はありません</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>
            {runs.length}回（最大{MOCK_HISTORY_MAX}回まで保存）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {runs.map((r) => {
              const rate = r.total ? Math.round((r.correct / r.total) * 100) : 0;
              return (
                <button key={r.runId} onClick={() => onOpen(r)}
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
                  <div style={{ minWidth: 54 }}>
                    <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 800, color: rateColor(rate) }}>{rate}<span style={{ fontSize: 11 }}>%</span></div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.faint }}>{r.correct}/{r.total}</div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: C.dim, lineHeight: 1.6 }}>
                    {fmtStamp(r.startedAt)}<br />
                    <span style={{ fontFamily: mono, color: C.faint }}>所要 {fmtMs(r.elapsedMs)}</span>
                  </div>
                  <span style={{ fontSize: 18, color: C.faint }}>›</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
