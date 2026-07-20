import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import katex from "katex";
import QUESTIONS from "./data/questions.json";
import ABBRS from "./data/abbr.json";

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

function loadData(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn("学習データの読み込みに失敗しました", e);
    return {};
  }
}

function saveData(key, states) {
  try {
    localStorage.setItem(key, JSON.stringify(states));
    return true;
  } catch (e) {
    console.warn("学習データの保存に失敗しました", e);
    return false;
  }
}

// ===== 間隔反復エンジン（SM-2を簡略化） =====
// quality: 0=わからなかった, 1=迷った, 2=わかった
const DAY_MS = 24 * 60 * 60 * 1000;
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);

function initCard() {
  return { interval: 0, easeFactor: 2.5, dueDate: todayStr(), reps: 0, lapses: 0, history: [], lastResult: null };
}

// correct は実際の正誤（過去問のみ）。英略語は自己評価だけなので undefined になる。
// ts は「直近N問」を正しい順序で並べるための記録時刻。
function reviewCard(card, quality, correct) {
  const c = { ...card };
  const entry = { date: todayStr(), ts: Date.now(), quality };
  if (typeof correct === "boolean") entry.correct = correct;
  c.history = [...card.history, entry];
  if (quality === 0) {
    c.reps = 0;
    c.lapses = card.lapses + 1;
    c.interval = 1;
    c.easeFactor = Math.max(1.3, card.easeFactor - 0.2);
    c.lastResult = "incorrect";
  } else {
    c.reps = card.reps + 1;
    if (quality === 1) {
      c.interval = c.reps === 1 ? 2 : Math.round(card.interval * 1.4);
      c.easeFactor = Math.max(1.3, card.easeFactor - 0.05);
    } else {
      c.interval = c.reps === 1 ? 4 : Math.round(card.interval * card.easeFactor);
      c.easeFactor = card.easeFactor + 0.1;
    }
    c.lastResult = "correct";
  }
  c.interval = Math.min(c.interval, 180);
  c.dueDate = addDays(c.interval);
  return c;
}

// ===== カスタムフック：カード状態管理（localStorage連携） =====
// storageKey ごとに独立した学習状態を保持する。
function useCardStates(storageKey) {
  const [states, setStates] = useState(() => loadData(storageKey));

  const update = useCallback((id, quality, correct) => {
    setStates((prev) => {
      const card = prev[id] || initCard();
      const next = { ...prev, [id]: reviewCard(card, quality, correct) };
      saveData(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const reset = useCallback(() => {
    setStates({});
    saveData(storageKey, {});
  }, [storageKey]);

  return [states, update, reset];
}

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

// ===== 共通スタイル =====
const C = {
  bg: "#0d1117", panel: "#161b22", panelHi: "#1c2230", border: "#30363d",
  text: "#e6edf3", dim: "#8b949e", faint: "#6e7681",
  accent: "#3fb950", accentDim: "#2ea043", blue: "#58a6ff",
  red: "#f85149", amber: "#d29922", purple: "#bc8cff",
};
const mono = "'SF Mono','Cascadia Code','Roboto Mono',Menlo,Consolas,monospace";
const sans = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const catColor = (cat) => {
  const map = { 基礎理論: C.blue, アルゴリズム: C.purple, コンピュータ構成: "#79c0ff", ソフトウェア: "#56d364", データベース: C.amber, ネットワーク: "#ff7b72", セキュリティ: C.red, マネジメント: "#d2a8ff", ストラテジ: "#7ee787" };
  return map[cat] || C.dim;
};

// ===== リッチテキスト表示（LaTeX数式 + Markdownテーブル対応） =====
const tableCellStyle = { border: `1px solid ${C.border}`, padding: "6px 10px", textAlign: "center" };

function renderInlineMath(text) {
  const parts = [];
  const regex = /\$([^$]+)\$/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
    parts.push({ type: "math", value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

function InlineRich({ text }) {
  if (!text.includes("$")) return <>{text}</>;
  return (
    <>
      {renderInlineMath(text).map((part, i) =>
        part.type === "math"
          ? <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.value, { throwOnError: false }) }} />
          : <React.Fragment key={i}>{part.value}</React.Fragment>
      )}
    </>
  );
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);

function parseTableBlock(lines, startIdx) {
  if (!isTableRow(lines[startIdx]) || !lines[startIdx + 1] || !isTableSep(lines[startIdx + 1])) return null;
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const rows = [splitRow(lines[startIdx])];
  let i = startIdx + 2;
  while (i < lines.length && isTableRow(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  return { rows, nextIdx: i };
}

function RichText({ text, style, as }) {
  if (!text) return null;
  const hasTable = isTableRow(text.split("\n")[0]) || /\n\s*\|.*\|\s*\n\s*\|(\s*:?-+:?\s*\|)+/.test(text);
  const hasMath = text.includes("$");
  if (!hasTable && !hasMath) {
    const Tag = as || "p";
    return <Tag style={{ whiteSpace: "pre-wrap", ...style }}>{text}</Tag>;
  }
  const lines = text.split("\n");
  const blocks = [];
  let i = 0, textBuf = [];
  const flushText = () => {
    if (textBuf.length) {
      blocks.push({ type: "text", value: textBuf.join("\n") });
      textBuf = [];
    }
  };
  while (i < lines.length) {
    const table = parseTableBlock(lines, i);
    if (table) {
      flushText();
      blocks.push({ type: "table", rows: table.rows });
      i = table.nextIdx;
    } else {
      textBuf.push(lines[i]);
      i++;
    }
  }
  flushText();

  const Wrapper = as === "span" ? "span" : "div";
  return (
    <Wrapper style={{ ...(as === "span" ? { display: "block" } : null), ...style }}>
      {blocks.map((b, bi) => {
        if (b.type === "table") {
          const [header, ...body] = b.rows;
          return (
            <table key={bi} style={{ borderCollapse: "collapse", margin: "12px 0", fontSize: 14 }}>
              <thead><tr>{header.map((c, j) => <th key={j} style={tableCellStyle}><InlineRich text={c} /></th>)}</tr></thead>
              <tbody>{body.map((row, ri) => (
                <tr key={ri}>{row.map((c, ci) => <td key={ci} style={tableCellStyle}><InlineRich text={c} /></td>)}</tr>
              ))}</tbody>
            </table>
          );
        }
        return (
          <p key={bi} style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            <InlineRich text={b.value} />
          </p>
        );
      })}
    </Wrapper>
  );
}

function plainPreview(text) {
  return text.replace(/\$([^$]+)\$/g, "$1").replace(/\n/g, " ").replace(/\|/g, " ");
}

// ===== メインコンポーネント（タブで2モードを切り替え） =====
export default function App() {
  const [tab, setTab] = useState("quiz");
  // 学習中（過去問の出題中／英略語のカード学習中）はタブバーを隠して集中できるようにする
  const [quizBusy, setQuizBusy] = useState(false);
  const [abbrBusy, setAbbrBusy] = useState(false);
  const busy = tab === "quiz" ? quizBusy : abbrBusy;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: sans, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 480, minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
        {/* 両モードとも状態を保持したままにするため、非表示で残す */}
        <div style={{ display: tab === "quiz" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <QuizApp onBusyChange={setQuizBusy} />
        </div>
        <div style={{ display: tab === "abbr" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <AbbrApp onBusyChange={setAbbrBusy} />
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
function QuizApp({ onBusyChange }) {
  const [screen, setScreen] = useState("home");
  const [states, updateCard, resetAll] = useCardStates(STORAGE_KEY);
  const [sessionQs, setSessionQs] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);

  useEffect(() => { onBusyChange(screen === "session"); }, [screen, onBusyChange]);

  const dueQuestions = useMemo(() => {
    const today = todayStr();
    return QUESTIONS.filter((q) => {
      const c = states[q.id];
      return c && c.dueDate <= today;
    });
  }, [states]);

  const newQuestions = useMemo(
    () => QUESTIONS.filter((q) => !states[q.id]),
    [states]
  );

  const startSession = (questions) => {
    setSessionQs(questions);
    setSessionLog([]);
    setScreen("session");
  };

  const finishSession = (log) => {
    setSessionLog(log);
    setScreen("result");
  };

  return (
    <>
      {screen === "home" && (
        <HomeScreen
          states={states} dueCount={dueQuestions.length} newCount={newQuestions.length}
          totalCount={QUESTIONS.length}
          onReview={() => startSession(shuffle(dueQuestions).slice(0, 20))}
          onSetup={() => setScreen("setup")}
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
          questions={sessionQs} onFinish={finishSession}
          onQuit={() => setScreen("home")} updateCard={updateCard}
        />
      )}
      {screen === "result" && (
        <ResultScreen
          log={sessionLog} states={states}
          onHome={() => setScreen("home")}
        />
      )}
      {screen === "stats" && (
        <StatsScreen states={states} onBack={() => setScreen("home")} onReset={resetAll} />
      )}
    </>
  );
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== ホーム画面 =====
function HomeScreen({ states, dueCount, newCount, totalCount, onReview, onSetup, onStats }) {
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

      <button onClick={onStats} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px", color: C.dim, fontSize: 14, fontFamily: sans, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}>▤</span> 学習統計を見る
      </button>
    </div>
  );
}

function Stat({ label, value, unit, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: color || C.text }}>
        {value}<span style={{ fontSize: 12, color: C.faint, fontWeight: 400, marginLeft: 3 }}>{unit}</span>
      </div>
    </div>
  );
}

const cardBtn = { width: "100%", padding: 20, borderRadius: 14, fontFamily: sans, textAlign: "left", transition: "transform .1s" };

// ===== セッション設定画面 =====
function SetupScreen({ states, newQuestions, onStart, onBack }) {
  const [selectedCats, setSelectedCats] = useState([]);
  const [selectedSets, setSelectedSets] = useState([]);
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState("new");

  const pool = useMemo(() => {
    let qs = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedCats.length > 0) qs = qs.filter((q) => selectedCats.includes(q.category));
    if (selectedSets.length > 0) qs = qs.filter((q) => selectedSets.includes(q.set));
    return qs;
  }, [mode, selectedCats, selectedSets, newQuestions]);

  const toggleCat = (cat) =>
    setSelectedCats((prev) => prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]);

  const toggleSet = (set) =>
    setSelectedSets((prev) => prev.includes(set) ? prev.filter((s) => s !== set) : [...prev, set]);

  const actualCount = Math.min(count, pool.length);

  // カテゴリごとの残数を計算（出題セットの選択を反映）
  const catCounts = useMemo(() => {
    let base = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedSets.length > 0) base = base.filter((q) => selectedSets.includes(q.set));
    const m = {};
    CATEGORIES.forEach((c) => { m[c] = base.filter((q) => q.category === c).length; });
    return m;
  }, [mode, newQuestions, selectedSets]);

  // 出題セットごとの残数を計算（分野の選択を反映）
  const setCounts = useMemo(() => {
    let base = mode === "new" ? newQuestions : QUESTIONS;
    if (selectedCats.length > 0) base = base.filter((q) => selectedCats.includes(q.category));
    const m = {};
    SETS.forEach((s) => { m[s] = base.filter((q) => q.set === s).length; });
    return m;
  }, [mode, newQuestions, selectedCats]);

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

      <Section title="問題数">
        <div style={{ display: "flex", gap: 10 }}>
          {[10, 20, 30].map((n) => (
            <Toggle key={n} active={count === n} onClick={() => setCount(n)} label={`${n}問`} />
          ))}
        </div>
      </Section>

      <div style={{ flex: 1 }} />

      <button onClick={() => actualCount > 0 && onStart(shuffle(pool).slice(0, count))}
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

function Section({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 10, fontFamily: mono, letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

function Toggle({ active, onClick, label, sub }) {
  return (
    <button onClick={onClick}
      style={{ flex: 1, padding: "12px 8px", borderRadius: 12, fontFamily: sans, cursor: "pointer",
        background: active ? C.panelHi : C.panel,
        border: `1px solid ${active ? C.accent : C.border}`,
        color: active ? C.text : C.dim }}>
      <div style={{ fontSize: 14, fontWeight: active ? 700 : 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{sub}</div>}
    </button>
  );
}

// ===== セッション（問題）画面 =====
function SessionScreen({ questions, onFinish, onQuit, updateCard }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [log, setLog] = useState([]);
  const [shuffledOrder, setShuffledOrder] = useState(() => makeChoiceOrder(questions[0]));
  const [showFull, setShowFull] = useState(false);

  const q = questions[idx];
  const isLast = idx === questions.length - 1;

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
      setShuffledOrder(makeChoiceOrder(questions[idx + 1]));
      setShowFull(false);
    }
  };

  const isCorrect = selected === q.answer;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "100vh" }}>
      <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onQuit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0 }}>✕</button>
          <div style={{ flex: 1, height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${((idx + (answered ? 1 : 0)) / questions.length) * 100}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width .3s" }} />
          </div>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{idx + 1}/{questions.length}</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${catColor(q.category)}22`, color: catColor(q.category) }}>
            {q.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{q.set}</span>
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
          const explanation = remapLabels(q.explanation, labelMap);
          const summary = getExplanationSummary(explanation);
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

function RateBtn({ color, emoji, label, sub, onClick }) {
  return (
    <button onClick={onClick}
      style={{ flex: 1, padding: "12px 4px", borderRadius: 12, border: `1.5px solid ${color}`, background: `${color}14`, cursor: "pointer", fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: 22 }}>{emoji}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{label}</span>
      <span style={{ fontSize: 10, color: C.faint, fontFamily: mono }}>{sub}</span>
    </button>
  );
}

// ===== セッション結果画面 =====
function ResultScreen({ log, onHome }) {
  const correct = log.filter((e) => e.correct).length;
  const total = log.length;
  const rate = total ? Math.round((correct / total) * 100) : 0;
  const wrongList = log.filter((e) => !e.correct);

  let message, msgColor;
  if (rate >= 80) { message = "素晴らしい！この調子です"; msgColor = C.accent; }
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
          問題別レビュー {wrongList.length > 0 && `(${wrongList.length}問間違い → 復習予定に追加)`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {log.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${e.correct ? C.border : C.red + "44"}` }}>
              <span style={{ fontFamily: mono, fontSize: 16, color: e.correct ? C.accent : C.red, fontWeight: 700, minWidth: 16 }}>
                {e.correct ? "✓" : "✗"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(e.q.question)}</div>
                <div style={{ fontSize: 11, color: catColor(e.q.category), marginTop: 2 }}>{e.q.category}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onHome} style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans, cursor: "pointer", background: `linear-gradient(135deg,${C.accentDim},#238636)`, color: "#fff" }}>
        ホームに戻る
      </button>
    </div>
  );
}

// ===== 統計ダッシュボード =====
// 履歴1件が正解だったか。correct を記録する前の古い履歴は自己評価で代用する。
function histCorrect(h) {
  return typeof h.correct === "boolean" ? h.correct : h.quality >= 1;
}

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

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{label}</div>
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

function AbbrApp({ onBusyChange }) {
  const [screen, setScreen] = useState("home");
  const [states, updateCard, resetAll] = useCardStates(ABBR_STORAGE_KEY);
  const [sessionCards, setSessionCards] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);

  useEffect(() => { onBusyChange(screen === "card"); }, [screen, onBusyChange]);

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
    setScreen("card");
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
      {screen === "card" && (
        <AbbrCardScreen cards={sessionCards} onFinish={finishSession}
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

// カード学習画面：略語 →「意味は？」で裏面（正式名称・意味・豆知識）→ 3段階評価
function AbbrCardScreen({ cards, onFinish, onQuit, updateCard }) {
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [log, setLog] = useState([]);

  const card = cards[idx];
  const isLast = idx === cards.length - 1;

  if (!card) {
    return <div style={{ padding: 40, textAlign: "center", color: C.dim }}>語がありません</div>;
  }

  const handleRate = (quality) => {
    updateCard(card.id, quality);
    const newLog = [...log, { card, quality }];
    setLog(newLog);
    if (isLast) {
      onFinish(newLog);
    } else {
      setIdx(idx + 1);
      setRevealed(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "100vh" }}>
      <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onQuit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0 }}>✕</button>
          <div style={{ flex: 1, height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${((idx + (revealed ? 1 : 0)) / cards.length) * 100}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width .3s" }} />
          </div>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{idx + 1}/{cards.length}</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: "20px", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${abbrCatColor(card.category)}22`, color: abbrCatColor(card.category) }}>
            {card.category}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{FREQ_LABEL[card.freq]}</span>
        </div>

        {/* 表面：略語 */}
        <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
          <div style={{ fontFamily: mono, fontSize: 44, fontWeight: 800, color: C.text, letterSpacing: 1 }}>{card.abbr}</div>
          <div style={{ fontSize: 13, color: C.faint, marginTop: 6 }}>{card.kana}</div>
        </div>

        {!revealed ? (
          <>
            <div style={{ flex: 1 }} />
            <button onClick={() => setRevealed(true)}
              style={{ width: "100%", padding: 18, borderRadius: 14, border: `1px solid ${C.border}`, background: C.panel,
                color: C.text, fontSize: 16, fontWeight: 700, fontFamily: sans, cursor: "pointer" }}>
              意味は？
            </button>
          </>
        ) : (
          <>
            <div style={{ marginTop: 12, padding: 18, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, animation: "fadeIn .3s" }}>
              <div style={{ fontSize: 15, color: C.accent, fontWeight: 700, lineHeight: 1.6 }}>{card.full}</div>
              <div style={{ fontSize: 17, color: C.text, fontWeight: 700, marginTop: 10, lineHeight: 1.6 }}>{card.meaning}</div>
              {card.tips && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 13, color: C.dim, lineHeight: 1.8 }}>
                  <span style={{ color: C.amber, fontWeight: 700 }}>豆 </span>{card.tips}
                </div>
              )}
            </div>
            <div style={{ flex: 1 }} />
          </>
        )}
      </div>

      {revealed && (
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}`, background: C.panel, animation: "slideUp .3s" }}>
          <div style={{ fontSize: 12, color: C.faint, textAlign: "center", marginBottom: 10 }}>
            どのくらい覚えていましたか？
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
  const known = log.filter((e) => e.quality === 2).length;
  const total = log.length;
  const rate = total ? Math.round((known / total) * 100) : 0;
  const weak = log.filter((e) => e.quality < 2);

  let message, msgColor;
  if (rate >= 80) { message = "素晴らしい！この調子です"; msgColor = C.accent; }
  else if (rate >= 50) { message = "良いペース。復習で確実に"; msgColor = C.blue; }
  else { message = "あいまいな語を重点復習しよう"; msgColor = C.amber; }

  return (
    <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>学習おつかれさま</h2>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, textAlign: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 44, fontWeight: 800, color: msgColor }}>{rate}%</div>
        <div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>{known} / {total} 語を「覚えた」</div>
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

      <div style={{ flex: 1 }} />

      <button onClick={handleReset}
        style={{ width: "100%", padding: 14, borderRadius: 12, background: "transparent",
          border: `1px solid ${C.red}`, color: C.red, fontSize: 14, fontFamily: sans, cursor: "pointer" }}>
        進捗をリセット
      </button>
    </div>
  );
}

function TopBar({ title, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <button onClick={onBack} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: 36, height: 36, color: C.text, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h2>
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      :root { color-scheme: dark; }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      body { margin: 0; }
      button, input, select, textarea { color: inherit; font: inherit; }
      button:active { transform: scale(0.98); }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
      ::-webkit-scrollbar { width: 0; background: transparent; }
    `}</style>
  );
}

createRoot(document.getElementById("root")).render(<App />);
