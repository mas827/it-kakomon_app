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
// 模試モード。過去問モードの学習履歴(STORAGE_KEY)とは完全に分離する。
// 進行中は1件だけ（中断再開用）。完了した模試は履歴として新しい順に残す。
const MOCK_STORAGE_KEY = "fe-exam-mock-v1";
const MOCK_PROGRESS_KEY = "fe-exam-mock-progress-v1";
const MOCK_HISTORY_MAX = 50;

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

// loadData/saveData は {id: card} のオブジェクト前提で useCardStates が依存しているため、
// null や配列を扱いたい模試用に汎用版を別に用意する（既存のシグネチャは変えない）。
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn("データの読み込みに失敗しました", key, e);
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn("データの保存に失敗しました", key, e);
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

// 経過時間。バックグラウンド（別タブ・画面オフ）の間は数えない。
// 常に0から数えるので、再開時は「保存済みの経過 + これ」を使うこと。
function useTimer(enabled, resetKey, running) {
  const [ms, setMs] = useState(0);
  useEffect(() => { setMs(0); }, [resetKey]);
  useEffect(() => {
    if (!enabled || !running) return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (document.visibilityState === "visible") setMs((m) => m + (now - last));
      last = now;
    }, 250);
    return () => clearInterval(id);
  }, [enabled, running, resetKey]);
  return ms;
}

const fmtMs = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

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
  const [mockBusy, setMockBusy] = useState(false);
  const busy = { quiz: quizBusy, abbr: abbrBusy, mock: mockBusy }[tab];

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
        <div style={{ display: tab === "mock" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
          <MockApp onBusyChange={setMockBusy} />
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
function QuizApp({ onBusyChange }) {
  const [screen, setScreen] = useState("home");
  const [states, updateCard, resetAll] = useCardStates(STORAGE_KEY);
  const [sessionQs, setSessionQs] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);
  const [detail, setDetail] = useState(null);  // { q, selected, revealStart, from }

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

  const openDetail = (d) => {
    setDetail(d);
    setScreen("detail");
  };

  return (
    <>
      {screen === "home" && (
        <HomeScreen
          states={states} dueCount={dueQuestions.length} newCount={newQuestions.length}
          totalCount={QUESTIONS.length}
          onReview={() => startSession(shuffle(dueQuestions).slice(0, 20))}
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
          questions={sessionQs} onFinish={finishSession}
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== ホーム画面 =====
function HomeScreen({ states, dueCount, newCount, totalCount, onReview, onSetup, onList, onStats }) {
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
function ResultScreen({ log, onHome, onOpen }) {
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
          問題別レビュー（タップで詳細） {wrongList.length > 0 && `(${wrongList.length}問間違い → 復習予定に追加)`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {log.map((e, i) => (
            <button key={i} onClick={() => onOpen(e)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${e.correct ? C.border : C.red + "44"}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
              <span style={{ fontFamily: mono, fontSize: 16, color: e.correct ? C.accent : C.red, fontWeight: 700, minWidth: 16 }}>
                {e.correct ? "✓" : "✗"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(e.q.question)}</div>
                <div style={{ fontSize: 11, color: catColor(e.q.category), marginTop: 2 }}>{e.q.category}</div>
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
const LIST_PAGE = 100;

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

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{label}</div>
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
    ids: p.ids, orders, answers,
    hashes: qs.map((q) => choicesHash(q)),
    idx: Math.min(Math.max(0, p.idx | 0), qs.length - 1),
    qs, repaired,
  };
}

function saveProgress(p, answers, idx, elapsedMs) {
  return saveJSON(MOCK_PROGRESS_KEY, {
    v: 1, startedAt: p.startedAt, updatedAt: Date.now(), elapsedMs,
    ids: p.ids, orders: p.orders, hashes: p.hashes, answers, idx,
  });
}

// ===== 採点 =====

// corrects は正誤を "1"/"0" の文字列で凍結する。あとから answer が修正されても、
// その日に取った点数と問題別の○×が食い違わないようにするため。
function gradeMock(p, answers, elapsedMs) {
  const byCat = {};
  let correct = 0;
  let corrects = "";
  p.ids.forEach((id, i) => {
    const q = questionById(id);
    const cat = q ? q.category : "不明";
    const cell = byCat[cat] || (byCat[cat] = [0, 0]);
    cell[0]++;
    const ok = !!q && answers[i] === q.answer;
    if (ok) { cell[1]++; correct++; }
    corrects += ok ? "1" : "0";
  });
  return {
    v: 1, runId: "m-" + p.startedAt,
    startedAt: p.startedAt, finishedAt: Date.now(), elapsedMs,
    total: p.ids.length, correct, byCat,
    ids: p.ids, answers, hashes: p.hashes, corrects,
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

// ===== 模試モードのルート =====
function MockApp({ onBusyChange }) {
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

  useEffect(() => { onBusyChange(screen === "exam"); }, [screen, onBusyChange]);

  const progressRef = React.useRef(null);
  progressRef.current = progress;

  const persist = useCallback(({ answers, idx, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) return;
    setSaveFailed(!saveProgress(p, answers, idx, elapsedMs));
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

  const suspend = ({ answers, idx, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) { setScreen("home"); return; }
    setSaveFailed(!saveProgress(p, answers, idx, elapsedMs));
    setProgress({ ...p, answers, idx, elapsedMs, repaired: 0 });
    setScreen("home");
  };

  const submit = ({ answers, elapsedMs }) => {
    const p = progressRef.current;
    if (!p) { setScreen("home"); return; }
    const run = gradeMock(p, answers, elapsedMs);
    let list = [run, ...runs].slice(0, MOCK_HISTORY_MAX);
    let ok = saveMockHistory(list);
    while (!ok && list.length > 1) {          // 容量オーバー → 古いものから捨ててリトライ
      list = list.slice(0, list.length - 1);
      ok = saveMockHistory(list);
    }
    setHistFailed(!ok);
    setRuns(list);
    localStorage.removeItem(MOCK_PROGRESS_KEY);
    setProgress(null);
    setSaveFailed(false);
    setCurrent(run);
    setScoreFrom("home");
    setScreen("score");
  };

  const openRun = (run) => { setCurrent(run); setScoreFrom("history"); setScreen("score"); };

  const openDetail = (i) => {
    const run = current;
    const q = questionById(run.ids[i]);
    if (!q) return;
    // 選択肢が後から修正されていたら、保存してある解答番号は別の選択肢を指している可能性が
    // あるのでハイライトしない（§修正済みバッジ）
    const edited = run.hashes && run.hashes[i] !== choicesHash(q);
    setDetail({ q, selected: edited ? null : run.answers[i] });
    setScreen("detail");
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
            onOpen={openDetail} onBack={() => setScreen(scoreFrom)}
          />
        </div>
      )}
      {screen === "detail" && detail && (
        <QuestionDetail
          key={detail.q.id} q={detail.q} selected={detail.selected}
          revealStart={true} onBack={() => setScreen("score")}
        />
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
          採点は最後にまとめて。学習履歴（過去問モード）には影響しません。
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

  const ms = useTimer(true, init.startedAt, true);
  const totalMs = init.elapsedMs + ms;
  const msRef = React.useRef(0);
  msRef.current = ms;

  const bodyRef = React.useRef(null);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [idx]);

  const liveRef = React.useRef({ answers, idx });
  liveRef.current = { answers, idx };

  // 保存トリガは「解答」「移動」「60秒ごと」「非表示化」「離脱」だけ。
  // タイマー更新（250ms）では保存しない（setItem は同期I/O）。
  const persistNow = useCallback(() => {
    const l = liveRef.current;
    onPersist({ answers: l.answers, idx: l.idx, elapsedMs: init.elapsedMs + msRef.current });
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

  const commit = (nextAnswers, nextIdx) => {
    setAnswers(nextAnswers);
    setIdx(nextIdx);
    onPersist({ answers: nextAnswers, idx: nextIdx, elapsedMs: init.elapsedMs + msRef.current });
  };

  const q = qs[idx];
  const answeredCount = answers.filter((a) => a != null).length;
  const unanswered = answers.reduce((acc, a, i) => (a == null ? [...acc, i + 1] : acc), []);

  const select = (origIdx) => {
    const next = [...answers];
    next[idx] = origIdx;
    commit(next, idx);
  };

  const go = (n) => {
    const next = Math.min(Math.max(0, n), qs.length - 1);
    if (next !== idx) commit(answers, next);
  };

  const quit = () => {
    if (!window.confirm("模試を中断します。あとで再開できます。よろしいですか？")) return;
    onSuspend({ answers, idx, elapsedMs: init.elapsedMs + msRef.current });
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
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6, marginBottom: 16 }}>
            {qs.map((_, i) => {
              const cur = i === idx, ans = answers[i] != null;
              return (
                <button key={i} onClick={() => { go(i); setPalette(false); }}
                  style={{ aspectRatio: "1", borderRadius: 6, fontFamily: mono, fontSize: 11, cursor: "pointer",
                    background: ans ? `${C.blue}33` : C.bg,
                    border: `1.5px solid ${cur ? C.accent : ans ? C.blue + "88" : C.border}`,
                    color: ans ? C.text : C.faint, fontWeight: cur ? 700 : 400, padding: 0 }}>
                  {i + 1}
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
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.7, marginBottom: 16 }}>
            {unanswered.length > 0
              ? <>未回答が <span style={{ color: C.amber, fontFamily: mono, fontWeight: 700 }}>{unanswered.length}問</span> あります（問 {unanswered.slice(0, 12).join(", ")}{unanswered.length > 12 ? " …" : ""}）。<br />未回答は不正解として集計されます。</>
              : <>全{qs.length}問に解答済みです。</>}
          </div>
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
function MockScore({ run, isFresh, histFailed, onOpen, onBack }) {
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
              <button key={i} onClick={() => onOpen(i)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${ok ? C.border : C.red + "44"}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
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
