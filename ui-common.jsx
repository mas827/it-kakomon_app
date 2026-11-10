// ===== 共通部品 =====
// 過去問・英略語・模試（と今後の科目B）が共有するもの。fe-study-app.jsx から抽出した。
// ここには「どのモードにも属さない」ものだけを置く。モード固有の定数（SETS・STORAGE_KEY など）は置かない。
// このファイルから fe-study-app.jsx を import しないこと（循環インポートになる）。

import React, { useState, useEffect, useCallback } from "react";
import katex from "katex";

// ===== 共通スタイル =====
export const C = {
  bg: "#0d1117", panel: "#161b22", panelHi: "#1c2230", border: "#30363d",
  text: "#e6edf3", dim: "#8b949e", faint: "#6e7681",
  accent: "#3fb950", accentDim: "#2ea043", blue: "#58a6ff",
  red: "#f85149", amber: "#d29922", purple: "#bc8cff",
};

export const mono = "'SF Mono','Cascadia Code','Roboto Mono',Menlo,Consolas,monospace";

export const sans = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

export const cardBtn = { width: "100%", padding: 20, borderRadius: 14, fontFamily: sans, textAlign: "left", transition: "transform .1s" };

export function GlobalStyle() {
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

// ===== 永続化（localStorage） =====
export function loadData(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn("学習データの読み込みに失敗しました", e);
    return {};
  }
}

export function saveData(key, states) {
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
export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn("データの読み込みに失敗しました", key, e);
    return fallback;
  }
}

export function saveJSON(key, value) {
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
export const DAY_MS = 24 * 60 * 60 * 1000;

export const todayStr = () => new Date().toISOString().slice(0, 10);

export const addDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);

export function initCard() {
  return { interval: 0, easeFactor: 2.5, dueDate: todayStr(), reps: 0, lapses: 0, history: [], lastResult: null };
}

// correct は実際の正誤（過去問のみ）。英略語は自己評価だけなので undefined になる。
// ts は「直近N問」を正しい順序で並べるための記録時刻。
export function reviewCard(card, quality, correct) {
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

// 履歴1件が正解だったか。correct を記録する前の古い履歴は自己評価で代用する。
export function histCorrect(h) {
  return typeof h.correct === "boolean" ? h.correct : h.quality >= 1;
}

// ===== カスタムフック：カード状態管理（localStorage連携） =====
// storageKey ごとに独立した学習状態を保持する。
export function useCardStates(storageKey) {
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

  // id→card を一括で置き換える（模試の採点・理解度の選び直し用。保存は1回）
  const setCards = useCallback((cards) => {
    setStates((prev) => {
      const next = { ...prev, ...cards };
      saveData(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return [states, update, reset, setCards];
}

// ===== 汎用（シャッフル・タイマー・一覧の件数） =====
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 経過時間。バックグラウンド（別タブ・画面オフ）の間は数えない。
// 常に0から数えるので、再開時は「保存済みの経過 + これ」を使うこと。
export function useTimer(enabled, resetKey, running) {
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

export const fmtMs = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export const LIST_PAGE = 100;

// ===== リッチテキスト表示（LaTeX数式 + Markdownテーブル対応） =====
export const tableCellStyle = { border: `1px solid ${C.border}`, padding: "6px 10px", textAlign: "center" };

export function renderInlineMath(text) {
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

export function InlineRich({ text }) {
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

export const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);

export const isTableSep = (l) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);

export function parseTableBlock(lines, startIdx) {
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

export function RichText({ text, style, as }) {
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

export function plainPreview(text) {
  return text.replace(/\$([^$]+)\$/g, "$1").replace(/\n/g, " ").replace(/\|/g, " ");
}

// ===== 小物（見出し・トグル・数値カード・理解度ボタン） =====
export function TopBar({ title, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <button onClick={onBack} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: 36, height: 36, color: C.text, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h2>
    </div>
  );
}

export function Section({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 10, fontFamily: mono, letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

export function Toggle({ active, onClick, label, sub }) {
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

export function Stat({ label, value, unit, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: color || C.text }}>
        {value}<span style={{ fontSize: 12, color: C.faint, fontWeight: 400, marginLeft: 3 }}>{unit}</span>
      </div>
    </div>
  );
}

export function SummaryCard({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{label}</div>
    </div>
  );
}

export function RateBtn({ color, emoji, label, sub, onClick }) {
  return (
    <button onClick={onClick}
      style={{ flex: 1, padding: "12px 4px", borderRadius: 12, border: `1.5px solid ${color}`, background: `${color}14`, cursor: "pointer", fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: 22 }}>{emoji}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{label}</span>
      <span style={{ fontSize: 10, color: C.faint, fontFamily: mono }}>{sub}</span>
    </button>
  );
}
