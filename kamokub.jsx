// ===== 科目B（擬似言語・情報セキュリティ）モード =====
// default export の KamokuBApp を、本体の下部タブ「📘 科目B」（fe-study-app.jsx）が描く。
// テーマ・永続化・SRS・RichText・小物は ui-common.jsx のものを使う。ここには科目Bに固有のものだけを置く。
import React, { useState, useEffect, useMemo, useCallback, useRef, useReducer } from "react";
import {
  C, mono, sans, cardBtn, todayStr, addDays, loadData, saveData, useCardStates, histCorrect,
  shuffle, useTimer, fmtMs, LIST_PAGE, RichText as RichTextBase, InlineRich, withBlanks, plainPreview,
  TopBar, Section, Toggle, Stat, SummaryCard, RateBtn,
} from "./ui-common.jsx";
import QUESTIONS from "./data/kamokub.json";
import PROGRAMS from "./data/kamokub_programs.json";

// 科目Bの表（クラスの説明・セキュリティの指摘事項など）は長文のセルが多いので、常に横スクロールの枠で描く
const BRichText = (props) => <RichTextBase scrollTables {...props} />;

// ===== 永続化（localStorage） =====
// 科目Aと英略語のキー（fe-exam-srs-v1 / it-abbr-srs-v1）には一切触らない。
const STORAGE_KEY = "fe-exam-b-srs-v1";   // 学習カード
const TRACE_KEY = "fe-exam-b-trace-v1";   // 問題ごとの記録（トレース・所要時間・訂正回数）
const PREFS_KEY = "fe-exam-b-prefs-v1";   // タイマーON/OFF、画面の分割比
// 本体のバックアップ（fe-study-app.jsx の BACKUP_KEYS）が使う。キー名の出どころはここだけにする
export const KAMOKUB_KEYS = { srs: STORAGE_KEY, trace: TRACE_KEY, prefs: PREFS_KEY };
const TRACE_LIMIT = 50;                   // 記録を残す問題数の上限（古いものから捨てる）

// ===== 設定（タイマーON/OFF、分割比） =====
const DEFAULT_PREFS = { timer: true, split: 0.58 };

function usePrefs() {
  const [prefs, setPrefs] = useState(() => {
    const saved = loadData(PREFS_KEY);
    // 旧既定値(0.5)のまま保存されている端末は、新しい既定値に乗せ替える
    if (saved.split === 0.5) delete saved.split;
    return { ...DEFAULT_PREFS, ...saved };
  });
  const set = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveData(PREFS_KEY, next);
      return next;
    });
  }, []);
  return [prefs, set];
}

// ===== 問題ごとの記録（トレース・所要時間・訂正回数） =====
// 容量が限られるので、直近 TRACE_LIMIT 問だけ残して古いものから捨てる。
function loadRecords() {
  return loadData(TRACE_KEY);
}

function saveRecord(id, patch) {
  const all = loadRecords();
  all[id] = { ...(all[id] || {}), ...patch, savedAt: Date.now() };
  const ids = Object.keys(all).sort((a, b) => (all[b].savedAt || 0) - (all[a].savedAt || 0));
  const trimmed = {};
  ids.slice(0, TRACE_LIMIT).forEach((k) => { trimmed[k] = all[k]; });
  return saveData(TRACE_KEY, trimmed);
}

// ===== 科目Bの定数 =====
const FIELDS = ["アルゴリズム", "セキュリティ"];
const fieldColor = (f) => (f === "セキュリティ" ? C.red : C.purple);
const CHOICE_LABELS = "アイウエオカキクケコ";
const TARGET_MS = 5 * 60 * 1000;  // 本番100分 ÷ 20問

const SETS = [...new Set(QUESTIONS.map((q) => q.set))];
const ALL_TOPICS = [...new Set(QUESTIONS.flatMap((q) => q.topics || []))];

// ===== 空欄（[[a]] / [[fig:1]]）の扱い =====
// 空欄の描画（withBlanks）は ui-common.jsx。ここでは解答から差し込む字句を作るだけ
// 解答後に空欄へ差し込む字句を作る。{ a: "maxNum", b: "…" } の形。
function buildFilled(q, idx) {
  if (idx == null || idx < 0) return null;
  const ch = q.choices[idx];
  if (q.choiceCols) {
    const out = {};
    q.choiceCols.forEach((k, i) => { out[k] = ch[i]; });
    return out;
  }
  return { "": String(ch) };
}

// ===== 擬似言語のレンダラ =====
const KIND_COLOR = {
  comment: C.faint, proc: C.blue, global: C.blue, decl: C.dim,
  if: C.purple, elseif: C.purple, else: C.purple, endif: C.purple,
  while: C.purple, endwhile: C.purple, for: C.purple, endfor: C.purple,
  do: C.purple, dowhile: C.purple,
  return: C.amber, break: C.amber,
};

function ProgramView({ program, filled, activeLine, onLineTap }) {
  if (!program) return null;
  return (
    <div>
      {program.caption && (
        <div style={{ fontSize: 13, color: C.dim, margin: "0 0 8px" }}>{program.caption}</div>
      )}
      {/* インデントが崩れると読めないので折り返さず横スクロールにする */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: C.panel }}>
        <div style={{ display: "inline-block", minWidth: "100%", padding: "8px 0" }}>
          {program.lines.map((l) => {
            const active = activeLine === l.n;
            return (
              <div key={l.n}
                onClick={() => onLineTap && l.kind !== "blank" && onLineTap(l.n)}
                style={{
                  display: "flex", alignItems: "stretch", whiteSpace: "pre",
                  background: active ? "#58a6ff1f" : "transparent",
                  cursor: onLineTap && l.kind !== "blank" ? "pointer" : "default",
                }}>
                <span style={{
                  flex: "0 0 auto", width: 34, textAlign: "right", paddingRight: 8,
                  color: active ? C.blue : C.faint, fontFamily: mono, fontSize: 11, lineHeight: "22px",
                  position: "sticky", left: 0, background: active ? "#1b2433" : C.panel,
                }}>{l.n}</span>
                <span style={{ flex: "0 0 auto", display: "flex" }}>
                  {/* インデントの縦罫線 */}
                  {Array.from({ length: l.indent }).map((_, k) => (
                    <span key={k} style={{ width: 14, borderLeft: `1px solid ${C.border}` }} />
                  ))}
                </span>
                <span style={{
                  flex: "1 0 auto", paddingRight: 14, fontFamily: mono, fontSize: 12.5, lineHeight: "22px",
                  color: KIND_COLOR[l.kind] || C.text,
                }}>
                  {l.text ? withBlanks(l.text, filled) : " "}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ===== トレース表 =====
// 配列は A[1] … A[n] に展開する。要素数が多い／実行中に変わるものは1列のまま扱う。
function expandColumns(columns) {
  const out = [];
  (columns || []).forEach((c) => {
    if (c.type === "array" && c.size && c.size <= 8) {
      const base = c.base == null ? 1 : c.base;
      for (let i = 0; i < c.size; i++) {
        out.push({ key: `${c.key}[${base + i}]`, label: `${c.label || c.key}[${base + i}]`, type: "int" });
      }
    } else {
      out.push({ key: c.key, label: c.label || c.key, type: c.type || "string" });
    }
  });
  return out;
}

// 模範トレース（expected）を、ユーザーのトレースと同じ行の形に変換する。
// 表の描画を1つのコンポーネントで共用するため。
function expectedRows(expected) {
  return (expected || []).map((r, i) => {
    if (r.ellipsis) return { id: `e${i}`, ellipsis: true, note: r.note };
    const cells = {};
    Object.entries(r.values || {}).forEach(([k, v]) => { cells[k] = { history: [v] }; });
    return { id: `e${i}`, step: r.step, locked: true, cells, note: r.note };
  });
}

function Cell({ cell }) {
  const h = (cell && cell.history) || [];
  if (!h.length) return <span style={{ color: C.faint }}>　</span>;
  if (h.length === 1) return <span>{h[0]}</span>;
  // 訂正あり。元の値を消さずに取り消し線で併記する
  return (
    <span>
      {h.slice(0, -1).map((v, i) => (
        <span key={i} style={{ color: C.faint, textDecoration: "line-through", marginRight: 4 }}>{v}</span>
      ))}
      <span style={{ color: C.amber, fontWeight: 700 }}>{h[h.length - 1]}</span>
    </span>
  );
}

const TD = {
  border: `1px solid ${C.border}`, padding: "5px 8px", fontFamily: mono, fontSize: 12,
  whiteSpace: "nowrap", textAlign: "center",
};

function TraceTable({ columns, rows, mode, activeCell, onCellTap, onStepTap }) {
  const cols = useMemo(() => expandColumns(columns), [columns]);
  const hasNote = rows.some((r) => r.note);
  const edit = mode === "edit";
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", minWidth: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...TD, position: "sticky", left: 0, zIndex: 2, background: C.panelHi, color: C.dim }}>ステップ</th>
            {cols.map((c) => (
              <th key={c.key} style={{ ...TD, background: C.panelHi, color: C.dim }}>{c.label}</th>
            ))}
            {hasNote && <th style={{ ...TD, background: C.panelHi, color: C.dim }}>備考</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.ellipsis) {
              return (
                <tr key={r.id}>
                  <td style={{ ...TD, position: "sticky", left: 0, background: C.panel, color: C.faint }}>…</td>
                  <td style={{ ...TD, color: C.faint, textAlign: "left" }} colSpan={cols.length + (hasNote ? 1 : 0)}>
                    <InlineRich text={r.note || "（中略）"} />
                  </td>
                </tr>
              );
            }
            const rowBg = edit && !r.locked ? "#1c2230" : C.panel;
            const rowActive = activeCell && activeCell.rowId === r.id;
            return (
              <tr key={r.id} data-active={rowActive ? "1" : undefined}>
                <td onClick={() => edit && onStepTap && onStepTap(r.id)}
                  style={{
                    ...TD, position: "sticky", left: 0, zIndex: 1, background: rowBg,
                    color: r.step == null ? C.faint : C.blue, fontWeight: 700,
                    cursor: edit ? "pointer" : "default",
                    outline: activeCell && activeCell.rowId === r.id && activeCell.col === "__step"
                      ? `2px solid ${C.blue}` : "none",
                  }}>
                  {r.step == null ? "—" : r.step}
                </td>
                {cols.map((c) => {
                  const on = activeCell && activeCell.rowId === r.id && activeCell.col === c.key;
                  return (
                    <td key={c.key} onClick={() => edit && onCellTap && onCellTap(r.id, c.key)}
                      style={{
                        ...TD, background: rowBg, cursor: edit ? "pointer" : "default",
                        outline: on ? `2px solid ${C.blue}` : "none",
                      }}>
                      <Cell cell={r.cells && r.cells[c.key]} />
                    </td>
                  );
                })}
                {hasNote && (
                  <td style={{ ...TD, background: rowBg, color: C.dim, textAlign: "left", whiteSpace: "normal", minWidth: 160, fontFamily: sans }}>
                    <InlineRich text={r.note || ""} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===== トレースの状態管理 =====
const newRow = (cells) => ({ id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, step: null, locked: false, cells: cells || {} });

function initTrace(trace) {
  const rows = [];
  if (trace && trace.initial) {
    const cells = {};
    Object.entries(trace.initial.values || {}).forEach(([k, v]) => { cells[k] = { history: [v] }; });
    rows.push({ ...newRow(cells), step: trace.initial.step, locked: true });
  }
  rows.push(newRow());
  return { rows, activeCell: null };
}

function traceReducer(state, action) {
  const { rows } = state;
  const idxOf = (id) => rows.findIndex((r) => r.id === id);
  switch (action.type) {
    case "LOAD":
      return action.state;
    case "FOCUS":
      return { ...state, activeCell: { rowId: action.rowId, col: action.col } };
    case "BLUR":
      return { ...state, activeCell: null };
    case "SET_STEP": {
      const i = idxOf(action.rowId);
      if (i < 0) return state;
      const next = [...rows];
      next[i] = { ...next[i], step: action.value };
      return { ...state, rows: next };
    }
    case "SET_CELL": {
      const i = idxOf(action.rowId);
      if (i < 0) return state;
      const row = rows[i];
      const prev = (row.cells[action.col] && row.cells[action.col].history) || [];
      let history;
      if (!row.locked) {
        // 未確定の行はまだ書き換えてよい
        history = action.value === "" ? [] : [action.value];
      } else if (prev[prev.length - 1] === action.value || action.value === "") {
        history = prev;
      } else {
        // 確定済みの行は上書きせず、訂正として履歴に足す
        history = [...prev, action.value];
      }
      const next = [...rows];
      next[i] = { ...row, cells: { ...row.cells, [action.col]: { history } } };
      return { ...state, rows: next };
    }
    case "COMMIT": {
      const i = rows.findIndex((r) => !r.locked);
      if (i < 0) return state;
      const next = [...rows];
      next[i] = { ...next[i], locked: true };
      next.push(newRow());
      return { rows: next, activeCell: null };
    }
    case "DELETE_ROW": {
      const next = rows.filter((r) => r.id !== action.rowId);
      if (!next.some((r) => !r.locked)) next.push(newRow());
      return { rows: next, activeCell: null };
    }
    case "RESET":
      return initTrace(action.trace);
    default:
      return state;
  }
}

// セルの訂正回数（履歴が2つ以上ある分の合計）。成績分析の副指標に使う。
function countCorrections(rows) {
  let n = 0;
  rows.forEach((r) => Object.values(r.cells || {}).forEach((c) => {
    if (c.history && c.history.length > 1) n += c.history.length - 1;
  }));
  return n;
}

// ===== セルの入力UI =====
// 数値も端末標準のキーボードを使う（自作テンキーは持たない）。
function AuxBtn({ label, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${C.border}`,
      background: C.panelHi, color: color || C.dim, fontFamily: sans, fontSize: 12, cursor: "pointer",
    }}>{label}</button>
  );
}

function CellInput({ type, draft, onDraft, onCarry, onDone, onClear, inputRef }) {
  const numeric = type === "int" || type === "real";
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel, padding: "8px 10px" }}>
      {type === "bool" ? (
        <div style={{ display: "flex", gap: 6 }}>
          {["true", "false", "未定義"].map((v) => (
            <button key={v} onClick={() => onDraft(v)} style={{
              flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontFamily: mono, fontSize: 14,
              border: `1px solid ${draft === v ? C.blue : C.border}`,
              background: draft === v ? "#58a6ff1a" : C.panelHi,
              color: v === "true" ? C.accent : v === "false" ? C.red : C.faint,
            }}>{v}</button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={inputRef} value={draft} onChange={(e) => onDraft(e.target.value)}
            inputMode={numeric ? "decimal" : "text"} enterKeyHint="done"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } }}
            placeholder={numeric ? "値を入力（例 3）" : "値を入力（例 {10, 20}）"}
            style={{
              flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${C.blue}`, background: C.bg, color: C.text,
              fontFamily: mono, fontSize: 16,  // 16px未満だとiOSで勝手に拡大される
            }} />
          <button onClick={onDone} style={{
            flex: "0 0 auto", padding: "0 18px", borderRadius: 8, border: `1px solid ${C.accent}`,
            background: "#3fb95014", color: C.accent, fontSize: 16, cursor: "pointer",
          }}>✓</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <AuxBtn label="↓ 前の値" onClick={onCarry} color={C.blue} />
        <AuxBtn label="未定義" onClick={() => onDraft("未定義")} />
        <AuxBtn label="空にする" onClick={onClear} />
        {type === "bool" && <AuxBtn label="✓ 確定" onClick={onDone} color={C.accent} />}
      </div>
    </div>
  );
}

// ===== 解答欄（選択肢は4〜9個で可変。組合せ問題は表で見せる） =====
// 組合せ問題の各列の最大幅（半角=1・全角=2）の合計。スマホ幅で1行に収まらない問題は
// 列を横に並べると狭い列の中で単語の途中から折り返すので、a / b を縦に積む
const COMBO_ROW_MAX = 40;
const textWidth = (s) => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x100 ? 1 : 2), 0);
function comboStacked(q) {
  if (!q.choiceCols) return false;
  const total = q.choiceCols.reduce((sum, _, k) => sum + Math.max(...q.choices.map((c) => textWidth(c[k]))), 0);
  return total + 2 * q.choiceCols.length > COMBO_ROW_MAX;
}

function ChoiceList({ q, selected, answered, onSelect }) {
  const stacked = comboStacked(q);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {q.choices.map((c, i) => {
        const isAnswer = i === q.answer;
        const picked = i === selected;
        let border = C.border, bg = C.panel, label = C.dim;
        if (answered && isAnswer) { border = C.accent; bg = "#3fb95014"; label = C.accent; }
        else if (answered && picked) { border = C.red; bg = "#f8514914"; label = C.red; }
        else if (picked) { border = C.blue; bg = C.panelHi; label = C.blue; }
        return (
          <button key={i} onClick={() => onSelect(i)} disabled={answered}
            style={{
              display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left",
              padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${border}`,
              background: bg, color: C.text, cursor: answered ? "default" : "pointer", fontFamily: sans,
            }}>
            <span style={{ flex: "0 0 auto", fontFamily: mono, fontWeight: 700, color: label, fontSize: 14, lineHeight: "20px" }}>
              {CHOICE_LABELS[i]}
            </span>
            {Array.isArray(c) && stacked ? (
              <span style={{ flex: 1, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", alignItems: "baseline" }}>
                {q.choiceCols.map((col, k) => (
                  <React.Fragment key={col}>
                    <span style={{ fontSize: 10, color: C.faint, fontFamily: mono, whiteSpace: "nowrap" }}>{col}</span>
                    <span style={{ fontSize: 13, fontFamily: mono, lineHeight: 1.5, overflowWrap: "anywhere" }}>{c[k]}</span>
                  </React.Fragment>
                ))}
              </span>
            ) : Array.isArray(c) ? (
              <span style={{ flex: 1, display: "grid", gridTemplateColumns: `repeat(${q.choiceCols.length}, auto)`, gap: "2px 12px" }}>
                {q.choiceCols.map((col, k) => (
                  <React.Fragment key={col}>
                    <span style={{ fontSize: 10, color: C.faint, fontFamily: mono, gridRow: 1, gridColumn: k + 1 }}>{col}</span>
                    <span style={{ fontSize: 13, fontFamily: mono, gridRow: 2, gridColumn: k + 1 }}>{c[k]}</span>
                  </React.Fragment>
                ))}
              </span>
            ) : (
              <span style={{ flex: 1, fontSize: 14, lineHeight: 1.6 }}>{c}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ===== 図（タップで全画面。ページ全体のズームは禁じたままここだけピンチできる） =====
function Figure({ fig, onOpen, anchorId }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure id={anchorId} style={{ margin: "20px 0", scrollMarginTop: 44 }}>
      {failed ? (
        <div style={{
          padding: "18px 14px", borderRadius: 10, border: `1px solid ${C.red}`,
          background: "#f8514910", color: C.red, fontSize: 12.5, lineHeight: 1.7,
        }}>
          図を読み込めませんでした<br />
          <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>{fig.file}</span>
        </div>
      ) : (
        <img src={fig.file} alt={fig.caption} onClick={() => onOpen(fig)} onError={() => setFailed(true)}
          style={{
            width: "100%", borderRadius: 10, border: `1px solid ${C.border}`,
            background: "#fff", display: "block", cursor: "zoom-in", padding: 6,
          }} />
      )}
      <figcaption style={{ fontSize: 11.5, color: C.dim, textAlign: "center", marginTop: 6 }}>
        {fig.caption}
        {!failed && <span style={{ color: C.blue, marginLeft: 6 }}>タップで拡大</span>}
      </figcaption>
    </figure>
  );
}

function ImageViewer({ fig, onClose }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const g = useRef(null);

  const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);

  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      g.current = { d: dist(e.touches), scale: t.scale, x: t.x, y: t.y };
    } else if (e.touches.length === 1 && t.scale > 1) {
      g.current = { px: e.touches[0].clientX, py: e.touches[0].clientY, x: t.x, y: t.y };
    }
  };
  const onTouchMove = (e) => {
    if (!g.current) return;
    e.preventDefault();
    if (e.touches.length === 2 && g.current.d) {
      const s = Math.min(6, Math.max(1, g.current.scale * (dist(e.touches) / g.current.d)));
      setT((p) => ({ ...p, scale: s }));
    } else if (e.touches.length === 1 && g.current.px != null) {
      setT((p) => ({
        ...p,
        x: g.current.x + (e.touches[0].clientX - g.current.px),
        y: g.current.y + (e.touches[0].clientY - g.current.py),
      }));
    }
  };
  const onTouchEnd = () => { g.current = null; };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 100, background: "#000000e8",
      display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ touchAction: "none", overflow: "hidden", maxWidth: "100%", maxHeight: "80vh" }}>
        <img src={fig.file} alt={fig.caption} draggable={false}
          style={{
            display: "block", maxWidth: "100vw", background: "#fff",
            transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: "center center",
          }} />
      </div>
      <div style={{ color: C.dim, fontSize: 12, marginTop: 14, textAlign: "center", padding: "0 20px" }}>
        {fig.caption}<br />
        <span style={{ color: C.faint }}>2本指で拡大・1本指で移動／どこかをタップで閉じる</span>
      </div>
      <button onClick={onClose} style={{
        marginTop: 12, padding: "8px 18px", borderRadius: 20, border: `1px solid ${C.border}`,
        background: C.panel, color: C.text, fontSize: 13, cursor: "pointer", fontFamily: sans,
      }}>閉じる</button>
      {t.scale !== 1 && (
        <button onClick={(e) => { e.stopPropagation(); setT({ scale: 1, x: 0, y: 0 }); }}
          style={{
            marginTop: 8, background: "none", border: "none", color: C.blue,
            fontSize: 12, cursor: "pointer", fontFamily: sans,
          }}>倍率を戻す</button>
      )}
    </div>
  );
}

// ===== 擬似言語の記述形式リファレンス（本番の問題冊子に載っているもの） =====
const REF_TEXT = `試験では擬似言語の記述形式が問題冊子の冒頭に載っている。ここでいつでも確認できる。

| 記述形式 | 説明 |
|---|---|
| ○手続名又は関数名 | 手続又は関数を宣言する |
| 型名: 変数名 | 変数を宣言する |
| /* 注釈 */　// 注釈 | 注釈を記述する |
| 変数名 ← 式 | 変数に式の値を代入する |
| 手続名又は関数名(引数, …) | 手続又は関数を呼び出し，引数を受け渡す |
| if (条件式) … elseif (条件式) … else … endif | 選択処理。上から評価し，最初に真になった条件式の処理を実行する |
| while (条件式) … endwhile | 前判定繰返し。条件式が真の間，処理を繰り返す |
| do … while (条件式) | 後判定繰返し。処理を実行し，条件式が真の間，繰り返す |
| for (制御記述) … endfor | 制御記述の内容に基づいて処理を繰り返す |

演算子と優先順位（上ほど優先度が高い）

| 種類 | 演算子 |
|---|---|
| 式 | ( ) . |
| 単項演算子 | not ＋ － |
| 二項演算子（乗除） | mod × ÷ |
| 二項演算子（加減） | ＋ － |
| 関係 | ≠ ≦ ≧ ＜ ＝ ＞ |
| 論理積 | and |
| 論理和 | or |

・演算子 . は，メンバ変数又はメソッドのアクセスを表す
・演算子 mod は，剰余算を表す
・論理型の定数は true，false

配列

・配列の要素は “[” と “]” の間に要素番号を指定してアクセスする
・二次元配列の要素番号は，行番号，列番号の順に “,” で区切る
・“{” は配列の内容の始まり，“}” は終わりを表す。二次元配列では内側の { } が1行分
・要素番号が 1 から始まるか 0 から始まるかは，問題文に明記される

未定義，未定義の値

・変数に値が格納されていない状態を “未定義” という
・変数に “未定義の値” を代入すると，その変数は未定義になる`;

function Modal({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 90, background: "#000000cc",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 480, maxHeight: "86vh", background: C.bg,
        borderTop: `1px solid ${C.border}`, borderRadius: "16px 16px 0 0",
        display: "flex", flexDirection: "column", animation: "slideUp .25s",
      }}>
        <div style={{
          display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>{title}</span>
          <button onClick={onClose} style={{
            background: "transparent", border: "none", color: C.dim, fontSize: 20, cursor: "pointer", padding: 0,
          }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

// ===== 上下分割（比率はドラッグで変えられる） =====
function SplitPane({ ratio, onRatio, top, bottom }) {
  const box = useRef(null);
  const drag = useRef(false);

  const move = (clientY) => {
    if (!box.current) return;
    const r = box.current.getBoundingClientRect();
    onRatio(Math.min(0.78, Math.max(0.22, (clientY - r.top) / r.height)));
  };
  useEffect(() => {
    const mm = (e) => { if (drag.current) { e.preventDefault(); move(e.touches ? e.touches[0].clientY : e.clientY); } };
    const mu = () => { drag.current = false; };
    window.addEventListener("mousemove", mm);
    window.addEventListener("touchmove", mm, { passive: false });
    window.addEventListener("mouseup", mu);
    window.addEventListener("touchend", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("touchmove", mm);
      window.removeEventListener("mouseup", mu);
      window.removeEventListener("touchend", mu);
    };
  });

  return (
    <div ref={box} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: `${ratio} 1 0`, minHeight: 0, display: "flex", flexDirection: "column" }}>{top}</div>
      <div onMouseDown={() => { drag.current = true; }} onTouchStart={() => { drag.current = true; }}
        style={{
          flex: "0 0 auto", height: 16, background: C.panel, borderTop: `1px solid ${C.border}`,
          borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center",
          justifyContent: "center", cursor: "row-resize", touchAction: "none",
        }}>
        <div style={{ width: 40, height: 3, borderRadius: 2, background: C.border }} />
      </div>
      <div style={{ flex: `${1 - ratio} 1 0`, minHeight: 0, display: "flex", flexDirection: "column" }}>{bottom}</div>
    </div>
  );
}

// ===== タイマーの色（目標5分を過ぎたら黄、7分半を過ぎたら赤） =====
const timeColor = (ms) => (ms > TARGET_MS * 1.5 ? C.red : ms > TARGET_MS ? C.amber : C.dim);

function Tabs({ items, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, padding: "8px 10px", background: C.panel, borderBottom: `1px solid ${C.border}` }}>
      {items.map((it) => {
        const on = value === it.k;
        return (
          <button key={it.k} onClick={() => onChange(it.k)} style={{
            flex: 1, padding: "7px 0", borderRadius: 8, cursor: "pointer", fontFamily: sans,
            border: `1px solid ${on ? C.blue : C.border}`,
            background: on ? "#58a6ff1a" : "transparent",
            color: on ? C.blue : C.dim, fontSize: 12.5, fontWeight: on ? 700 : 400,
          }}>{it.label}</button>
        );
      })}
    </div>
  );
}

// 問題文。[[fig:1]] の位置に図を差し込む。
// 上ペインは背が低く、図は本文のかなり下に来ることが多い。スクロールしないと図の存在に気づけないので、
// 図がある問題では先頭に「図1」「図2」のチップを貼り付けて、1タップで飛べるようにする。
function QuestionBody({ q, filled, onOpenFig, style }) {
  const figures = q.figures || [];
  const figs = {};
  figures.forEach((f) => { figs[f.key] = f; });
  const anchor = (key) => `fig-${q.id}-${key}`;
  const parts = q.question.split(/(\[\[fig:[^\]]+\]\])/);

  const jump = (key) => {
    const el = document.getElementById(anchor(key));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div style={{ paddingTop: figures.length > 0 ? 0 : 12, ...style }}>
      {figures.length > 0 && (
        <div style={{
          position: "sticky", top: 0, zIndex: 3, display: "flex", gap: 6, flexWrap: "wrap",
          alignItems: "center", background: C.bg,
          // スクロール領域の上端にぴったり貼り付ける。上の余白はこのバー自身が持つ
          // （親に padding-top があると、sticky は margin box を固定するので本文が隙間から覗く）
          padding: "12px 0 10px",
        }}>
          <span style={{ fontSize: 11, color: C.faint }}>図へ移動</span>
          {figures.map((f) => (
            <button key={f.key} onClick={() => jump(f.key)} style={{
              padding: "4px 12px", borderRadius: 14, border: `1px solid ${C.blue}`,
              background: "#58a6ff1a", color: C.blue, fontSize: 12, cursor: "pointer", fontFamily: sans,
            }}>図{f.key}</button>
          ))}
        </div>
      )}
      {parts.map((p, i) => {
        const m = p.match(/^\[\[fig:([^\]]+)\]\]$/);
        if (m) {
          const f = figs[m[1]];
          return f ? <Figure key={i} fig={f} onOpen={onOpenFig} anchorId={anchor(f.key)} /> : null;
        }
        if (!p.trim()) return null;
        return <BRichText key={i} text={p.trim()} filled={filled} style={{ fontSize: 14.5, lineHeight: 1.8 }} />;
      })}
    </div>
  );
}

// 下にまだ続きがあることを示すフェード。入れ子のスクロール領域だと気づきにくいので重ねる。
function ScrollFade({ children, style }) {
  const box = useRef(null);
  const [more, setMore] = useState(false);
  const check = () => {
    const el = box.current;
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 12);
  };
  useEffect(() => { check(); }, [children]);
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
      <div ref={box} onScroll={check} style={{ flex: 1, overflow: "auto", ...style }}>{children}</div>
      {more && (
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, height: 28, pointerEvents: "none",
          background: `linear-gradient(to bottom, transparent, ${C.bg})`,
        }} />
      )}
    </div>
  );
}

// ===== 出題画面 =====
function BSession({ questions, prefs, setPrefs, onFinish, onQuit, updateCard }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [log, setLog] = useState([]);
  const [topTab, setTopTab] = useState("q");
  const [bottomTab, setBottomTab] = useState("trace");
  const [expTab, setExpTab] = useState("model");
  const [showFull, setShowFull] = useState(false);
  const [showRef, setShowRef] = useState(false);
  const [viewer, setViewer] = useState(null);
  const [toast, setToast] = useState(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  const q = questions[idx];
  const program = q && q.programId ? PROGRAMS[q.programId] : null;
  const trace = program && program.trace;
  const isAlgo = !!program;
  const isLast = idx === questions.length - 1;

  const [ts, dispatch] = useReducer(traceReducer, trace, initTrace);
  const ms = useTimer(prefs.timer, q && q.id, !answered);

  // 問題が変わったら、保存してあるトレースを復元する（無ければ初期状態）
  useEffect(() => {
    if (!q) return;
    const rec = loadRecords()[q.id];
    dispatch({ type: "LOAD", state: rec && rec.rows ? { rows: rec.rows, activeCell: null } : initTrace(trace) });
    setDraft("");
  }, [q && q.id]);

  // トレースの途中状態を保存する
  useEffect(() => {
    if (!q || !trace) return;
    const t = setTimeout(() => {
      if (!saveRecord(q.id, { rows: ts.rows })) {
        setToast("トレースを保存できませんでした（保存容量の上限かもしれません）");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [ts.rows]);

  const ac = ts.activeCell;
  const activeRow = ac ? ts.rows.find((r) => r.id === ac.rowId) : null;

  // 編集中の行が入力欄に隠れないようスクロールし、入力欄にフォーカスを移す
  useEffect(() => {
    if (!ac) return;
    const el = document.querySelector('tr[data-active="1"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    if (inputRef.current) inputRef.current.focus();
  }, [ac && ac.rowId, ac && ac.col]);

  // 選択中のセルの値を入力欄に引き写す
  useEffect(() => {
    if (!ac || !activeRow) { setDraft(""); return; }
    if (ac.col === "__step") { setDraft(activeRow.step == null ? "" : String(activeRow.step)); return; }
    const h = (activeRow.cells[ac.col] && activeRow.cells[ac.col].history) || [];
    setDraft(h.length ? h[h.length - 1] : "");
  }, [ac && ac.rowId, ac && ac.col]);

  const cols = useMemo(() => expandColumns(trace && trace.columns), [trace]);
  const activeType = ac && ac.col === "__step" ? "int"
    : (cols.find((c) => ac && c.key === ac.col) || {}).type || "string";

  const commitDraft = (value) => {
    const v = value == null ? draft : value;
    if (!ac) return;
    if (ac.col === "__step") {
      dispatch({ type: "SET_STEP", rowId: ac.rowId, value: v === "" ? null : Number(v) });
    } else {
      dispatch({ type: "SET_CELL", rowId: ac.rowId, col: ac.col, value: String(v).trim() });
    }
  };

  const focusCell = (rowId, col) => {
    commitDraft();
    dispatch({ type: "FOCUS", rowId, col });
  };

  const onLineTap = (n) => {
    const target = ac ? ac.rowId : (ts.rows.find((r) => !r.locked) || {}).id;
    if (!target) return;
    dispatch({ type: "SET_STEP", rowId: target, value: n });
    if (ac && ac.col === "__step") setDraft(String(n));
  };

  const carryDown = () => {
    if (!ac) return;
    const i = ts.rows.findIndex((r) => r.id === ac.rowId);
    if (i <= 0) return;
    const prev = ts.rows[i - 1];
    if (ac.col === "__step") { setDraft(prev.step == null ? "" : String(prev.step)); return; }
    const h = (prev.cells[ac.col] && prev.cells[ac.col].history) || [];
    setDraft(h.length ? h[h.length - 1] : "");
  };

  if (!q) return <div style={{ padding: 40, textAlign: "center", color: C.dim }}>問題がありません</div>;

  const filled = answered ? buildFilled(q, selected) : null;
  const isCorrect = selected === q.answer;

  const handleSelect = (i) => {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
    setBottomTab("explain");
    setShowFull(false);
    setExpTab("model");
    saveRecord(q.id, { elapsedMs: ms, corrections: countCorrections(ts.rows) });
  };

  const handleRate = (quality) => {
    updateCard(q.id, quality, isCorrect);
    const newLog = [...log, { q, selected, correct: isCorrect, quality, ms }];
    setLog(newLog);
    if (isLast) { onFinish(newLog); return; }
    setIdx(idx + 1);
    setSelected(null);
    setAnswered(false);
    setTopTab("q");
    setBottomTab("trace");
  };

  const explanation = (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: isCorrect ? C.accent : C.red }}>
          {isCorrect ? "正解" : "不正解"}
        </span>
        <span style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>
          正解 {CHOICE_LABELS[q.answer]}
          {selected != null && selected !== q.answer && ` ／ 選んだ答え ${CHOICE_LABELS[selected]}`}
        </span>
        {prefs.timer && (
          <span style={{ marginLeft: "auto", fontSize: 12, fontFamily: mono, color: timeColor(ms) }}>{fmtMs(ms)}</span>
        )}
      </div>
      <BRichText text={q.explanation} style={{ fontSize: 13.5, lineHeight: 1.85, color: C.text }} />

      {(trace || q.traceExplanation) && (
        <>
          <button onClick={() => setShowFull(!showFull)} style={{
            background: "none", border: "none", color: C.blue, fontSize: 13,
            cursor: "pointer", padding: "12px 0 0", fontFamily: sans,
          }}>{showFull ? "▲ 閉じる" : "▼ 詳しく見る（トレース）"}</button>

          {showFull && (
            <div style={{ marginTop: 10 }}>
              {trace && (
                <>
                  <Tabs items={[{ k: "model", label: "模範トレース" }, { k: "mine", label: "自分の表" }]}
                    value={expTab} onChange={setExpTab} />
                  <div style={{ marginTop: 10 }}>
                    <TraceTable columns={trace.columns}
                      rows={expTab === "model" ? expectedRows(trace.expected) : ts.rows}
                      mode="view" />
                  </div>
                  {expTab === "mine" && (
                    <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>
                      トレース表の内容は採点していない。模範と見比べて，どこから食い違ったかを確かめる。
                    </div>
                  )}
                </>
              )}
              {q.traceExplanation && (
                <BRichText text={q.traceExplanation}
                  style={{ fontSize: 13.5, lineHeight: 1.85, color: C.text, marginTop: 14 }} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const header = (
    <div style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${C.border}`, background: C.bg }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onQuit} style={{ background: "transparent", border: "none", color: C.dim, fontSize: 19, cursor: "pointer", padding: 0 }}>✕</button>
        <div style={{ flex: 1, height: 5, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${((idx + (answered ? 1 : 0)) / questions.length) * 100}%`, height: "100%", background: C.accent, transition: "width .3s" }} />
        </div>
        <span style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>{idx + 1}/{questions.length}</span>
        {prefs.timer && (
          <span onClick={() => setPrefs({ timer: false })} title="タイマーを隠す"
            style={{ fontFamily: mono, fontSize: 13, color: timeColor(ms), cursor: "pointer", minWidth: 42, textAlign: "right" }}>
            {fmtMs(ms)}
          </span>
        )}
        <button onClick={() => setShowRef(true)} title="擬似言語の記述形式"
          style={{ background: "transparent", border: "none", fontSize: 17, cursor: "pointer", padding: 0 }}>📖</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: `${fieldColor(q.field)}22`, color: fieldColor(q.field), fontWeight: 700 }}>
          {q.field}
        </span>
        <span style={{ fontSize: 10.5, color: C.faint }}>{q.set}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.dim, fontFamily: mono }}>{q.id}</span>
      </div>
    </div>
  );

  const rateBar = answered && (
    <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}`, background: C.panel }}>
      <div style={{ display: "flex", gap: 8 }}>
        <RateBtn color={C.red} emoji="😓" label="わからない" sub="翌日" onClick={() => handleRate(0)} />
        <RateBtn color={C.amber} emoji="🤔" label="迷った" sub="2-4日後" onClick={() => handleRate(1)} />
        <RateBtn color={C.accent} emoji="😊" label="わかった" sub="4日後〜" onClick={() => handleRate(2)} />
      </div>
    </div>
  );

  const bottomItems = [
    ...(trace ? [{ k: "trace", label: "トレース表" }] : []),
    { k: "choices", label: "解答欄" },
    ...(answered ? [{ k: "explain", label: "解説" }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {header}

      {isAlgo ? (
        <SplitPane ratio={prefs.split} onRatio={(r) => setPrefs({ split: r })}
          top={
            <>
              <Tabs items={[{ k: "q", label: "問題文" }, { k: "program", label: "プログラム" }]}
                value={topTab} onChange={setTopTab} />
              <ScrollFade style={{ padding: "0 14px 12px" }}>
                {topTab === "q"
                  ? <QuestionBody q={q} filled={filled} onOpenFig={setViewer} />
                  : <div style={{ paddingTop: 12 }}>
                      <ProgramView program={program} filled={filled}
                        activeLine={activeRow ? activeRow.step : null}
                        onLineTap={trace && !answered ? onLineTap : null} />
                    </div>}
              </ScrollFade>
            </>
          }
          bottom={
            <>
              <Tabs items={bottomItems} value={bottomTab} onChange={setBottomTab} />
              {bottomTab === "trace" && trace && (
                <>
                  <div style={{ flex: 1, overflow: "auto" }}>
                    <TraceTable columns={trace.columns} rows={ts.rows} mode="edit"
                      activeCell={ts.activeCell}
                      onCellTap={focusCell} onStepTap={(rid) => focusCell(rid, "__step")} />
                    <div style={{ padding: "10px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => { commitDraft(); dispatch({ type: "COMMIT" }); }}
                        style={{
                          padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.accent}`,
                          background: "#3fb95014", color: C.accent, fontSize: 13, cursor: "pointer", fontFamily: sans,
                        }}>この行を確定して次へ</button>
                      {activeRow && activeRow.locked && (
                        <button onClick={() => dispatch({ type: "DELETE_ROW", rowId: activeRow.id })}
                          style={{
                            padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
                            background: "transparent", color: C.red, fontSize: 13, cursor: "pointer", fontFamily: sans,
                          }}>この行を削除</button>
                      )}
                      <button onClick={() => dispatch({ type: "RESET", trace })}
                        style={{
                          padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
                          background: "transparent", color: C.dim, fontSize: 13, cursor: "pointer", fontFamily: sans,
                        }}>最初から</button>
                    </div>
                    <div style={{ padding: "0 12px 12px", fontSize: 11, color: C.faint, lineHeight: 1.7 }}>
                      ステップ列はタップして自分で入力する。上の「プログラム」タブで行をタップしても入れられる。
                    </div>
                  </div>
                  {ac && (
                    <CellInput type={activeType} draft={draft} onDraft={setDraft} onCarry={carryDown}
                      inputRef={inputRef}
                      onDone={() => { commitDraft(); dispatch({ type: "BLUR" }); }}
                      onClear={() => { commitDraft(""); dispatch({ type: "BLUR" }); }} />
                  )}
                </>
              )}
              {bottomTab === "choices" && (
                <div style={{ flex: 1, overflow: "auto", padding: "12px 14px" }}>
                  <ChoiceList q={q} selected={selected} answered={answered} onSelect={handleSelect} />
                </div>
              )}
              {bottomTab === "explain" && (
                <div style={{ flex: 1, overflow: "auto" }}>{explanation}</div>
              )}
            </>
          } />
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <div style={{ padding: "14px 16px" }}>
            <QuestionBody q={q} filled={filled} onOpenFig={setViewer} />
            <div style={{ marginTop: 18 }}>
              <ChoiceList q={q} selected={selected} answered={answered} onSelect={handleSelect} />
            </div>
          </div>
          {answered && explanation}
        </div>
      )}

      {rateBar}

      {showRef && (
        <Modal title="擬似言語の記述形式" onClose={() => setShowRef(false)}>
          <BRichText text={REF_TEXT} style={{ fontSize: 13, lineHeight: 1.8, color: C.text }} />
        </Modal>
      )}
      {viewer && <ImageViewer fig={viewer} onClose={() => setViewer(null)} />}
      {toast && (
        <div onClick={() => setToast(null)} style={{
          position: "fixed", left: 16, right: 16, bottom: 20, zIndex: 120, maxWidth: 448, margin: "0 auto",
          padding: "12px 16px", borderRadius: 10, background: C.red, color: "#fff",
          fontSize: 13, cursor: "pointer", fontFamily: sans,
        }}>{toast}</div>
      )}
    </div>
  );
}

// 角丸のピル型ボタン（分野・セット・状態の絞り込みに使う）
// ===== 小物（科目Bだけで使うもの。共通の小物は ui-common.jsx） =====
function Pill({ active, onClick, label, count, color, disabled }) {
  const c = color || C.blue;
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding: "8px 12px", borderRadius: 20, fontSize: 13, fontFamily: sans,
        cursor: disabled ? "default" : "pointer",
        background: active ? c : C.panel,
        color: active ? "#0d1117" : (disabled ? C.faint : C.dim),
        border: `1px solid ${active ? c : C.border}`,
        fontWeight: active ? 700 : 400, opacity: disabled ? 0.4 : 1 }}>
      {label}{count != null && <span style={{ fontSize: 11, opacity: 0.8, marginLeft: 4 }}>{count}</span>}
    </button>
  );
}

const screenBox = { padding: "20px", display: "flex", flexDirection: "column", gap: 22, flex: 1, overflowY: "auto" };

// 問題の学習状態。科目Aの QuestionList / StatsScreen と同じ判定。
function statusOf(states, q) {
  const c = states[q.id];
  if (!c) return "new";
  if (c.interval >= 7) return "mastered";
  if (c.dueDate <= todayStr()) return "due";
  return "learning";
}

const STATUS_COLOR = { due: C.amber, learning: C.blue, mastered: C.accent, new: C.faint };
const STATUS_LABEL = { due: "復習待ち", learning: "学習中", mastered: "定着", new: "未学習" };

// ===== ホーム =====
function BHome({ states, prefs, setPrefs, dueCount, newCount, onReview, onSetup, onList, onStats, onRef }) {
  const learned = Object.keys(states).length;
  const mastered = Object.values(states).filter((c) => c.interval >= 7).length;
  const total = QUESTIONS.length;
  const progress = total ? Math.round((learned / total) * 100) : 0;

  return (
    <div style={{ padding: "32px 20px 24px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <header style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>
          科目B
        </h1>
        <p style={{ margin: "4px 0 0", color: C.dim, fontSize: 14 }}>擬似言語のトレースと情報セキュリティ・全{total}問</p>
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
          <Stat label="学習済み" value={learned} unit={`/ ${total}`} />
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
            <div style={{ fontSize: 13, color: C.dim, marginTop: 2 }}>未学習 {newCount}問 / 分野選択も可</div>
          </div>
          <div style={{ fontSize: 22, color: C.dim }}>→</div>
        </div>
      </button>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 10 }}>
        {[["▤ 問題一覧", onList], ["◷ 学習統計", onStats], ["📖 記述形式", onRef]].map(([label, fn]) => (
          <button key={label} onClick={fn}
            style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 4px", color: C.dim, fontSize: 13, fontFamily: sans, cursor: "pointer" }}>
            {label}
          </button>
        ))}
      </div>

      <button onClick={() => setPrefs({ timer: !prefs.timer })}
        style={{ background: "none", border: "none", color: C.faint, fontSize: 12, fontFamily: sans, cursor: "pointer", padding: 0, textAlign: "center" }}>
        タイマー：{prefs.timer ? "ON（目標 5分/問）" : "OFF"}　タップで切替
      </button>
    </div>
  );
}

// ===== セッション設定 =====
function BSetup({ states, onStart, onBack }) {
  const [fields, setFields] = useState([]);
  const [topics, setTopics] = useState([]);
  const [sets, setSets] = useState([]);
  const [mode, setMode] = useState("new");
  const [count, setCount] = useState(5);

  const matchFilters = (q) =>
    (fields.length === 0 || fields.includes(q.field)) &&
    (topics.length === 0 || (q.topics || []).some((t) => topics.includes(t))) &&
    (sets.length === 0 || sets.includes(q.set));

  const inMode = (q) => (mode === "new" ? !states[q.id] : true);

  const pool = useMemo(
    () => QUESTIONS.filter((q) => inMode(q) && matchFilters(q)),
    [fields, topics, sets, mode, states]
  );

  // ピルに出す件数は「出題範囲だけ適用した数」。絞り込み同士で数が消えないようにする。
  const countBy = (pred) => QUESTIONS.filter((q) => inMode(q) && pred(q)).length;
  const newCount = QUESTIONS.filter((q) => !states[q.id]).length;

  const toggle = (arr, set, v) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const actual = Math.min(count, pool.length);

  return (
    <div style={{ ...screenBox, gap: 22 }}>
      <TopBar title="セッション設定" onBack={onBack} />

      <Section title="出題範囲">
        <div style={{ display: "flex", gap: 10 }}>
          <Toggle active={mode === "new"} onClick={() => setMode("new")} label="未学習のみ" sub={`${newCount}問`} />
          <Toggle active={mode === "all"} onClick={() => setMode("all")} label="全問題" sub={`${QUESTIONS.length}問`} />
        </div>
      </Section>

      <Section title={`分野${fields.length > 0 ? ` (${fields.length}選択中)` : "（全分野）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {FIELDS.map((f) => {
            const n = countBy((q) => q.field === f);
            return <Pill key={f} active={fields.includes(f)} onClick={() => toggle(fields, setFields, f)}
              label={f} count={n} color={fieldColor(f)} disabled={n === 0} />;
          })}
        </div>
      </Section>

      <Section title={`トピック${topics.length > 0 ? ` (${topics.length}選択中)` : "（全トピック）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ALL_TOPICS.map((t) => {
            const n = countBy((q) => (q.topics || []).includes(t));
            return <Pill key={t} active={topics.includes(t)} onClick={() => toggle(topics, setTopics, t)}
              label={t} count={n} color={C.purple} disabled={n === 0} />;
          })}
        </div>
      </Section>

      <Section title={`出題セット${sets.length > 0 ? ` (${sets.length}選択中)` : "（全セット）"}`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {SETS.map((s) => {
            const n = countBy((q) => q.set === s);
            return <Pill key={s} active={sets.includes(s)} onClick={() => toggle(sets, setSets, s)}
              label={s} count={n} disabled={n === 0} />;
          })}
        </div>
      </Section>

      <Section title="問題数">
        <div style={{ display: "flex", gap: 10 }}>
          {[3, 5, 10, 20].map((n) => (
            <Toggle key={n} active={count === n} onClick={() => setCount(n)} label={`${n}問`} />
          ))}
        </div>
      </Section>

      <div style={{ flex: 1 }} />

      <button onClick={() => actual > 0 && onStart(shuffle(pool).slice(0, count))}
        disabled={actual === 0}
        style={{ width: "100%", padding: 18, borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, fontFamily: sans,
          cursor: actual > 0 ? "pointer" : "default",
          background: actual > 0 ? `linear-gradient(135deg,${C.accentDim},#238636)` : C.panel,
          color: actual > 0 ? "#fff" : C.faint }}>
        {actual > 0 ? `${actual}問でスタート` : "該当する問題がありません"}
      </button>
      {actual > 0 && (
        <div style={{ fontSize: 11, color: C.faint, textAlign: "center", marginTop: -14 }}>目安 {actual * 5}分</div>
      )}
    </div>
  );
}

// ===== 結果 =====
function BResult({ log, onHome, onOpen }) {
  const correct = log.filter((e) => e.correct).length;
  const total = log.length;
  const rate = total ? Math.round((correct / total) * 100) : 0;
  const wrongList = log.filter((e) => !e.correct);
  const totalMs = log.reduce((s, e) => s + (e.ms || 0), 0);
  const avgMs = total ? totalMs / total : 0;

  let message, msgColor;
  if (rate >= 80) { message = "素晴らしい！この調子です"; msgColor = C.accent; }
  else if (rate >= 60) { message = "良いペース。復習で確実に"; msgColor = C.blue; }
  else { message = "間違えた問題を重点復習しよう"; msgColor = C.amber; }

  return (
    <div style={{ ...screenBox, gap: 20 }}>
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

      <div style={{ display: "flex", gap: 10 }}>
        <SummaryCard label="合計時間" value={fmtMs(totalMs)} color={C.blue} />
        <SummaryCard label="1問平均" value={fmtMs(avgMs)} color={timeColor(avgMs)} />
        <SummaryCard label="目標" value="05:00" color={C.faint} />
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: C.faint, marginBottom: 10, fontFamily: mono }}>
          問題別レビュー（タップで詳細） {wrongList.length > 0 && `(${wrongList.length}問間違い → 復習予定に追加)`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {log.map((e, i) => (
            <button key={i} onClick={() => onOpen(e.q)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: C.panel, border: `1px solid ${e.correct ? C.border : C.red + "44"}`, textAlign: "left", fontFamily: sans, cursor: "pointer", width: "100%" }}>
              <span style={{ fontFamily: mono, fontSize: 16, color: e.correct ? C.accent : C.red, fontWeight: 700, minWidth: 16 }}>
                {e.correct ? "✓" : "✗"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plainPreview(e.q.question)}</div>
                <div style={{ fontSize: 11, color: fieldColor(e.q.field), marginTop: 2 }}>
                  {e.q.field}
                  <span style={{ color: C.faint, fontFamily: mono, marginLeft: 8 }}>{fmtMs(e.ms)}</span>
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

// ===== 問題一覧 =====
function BList({ states, onOpen, onBack }) {
  const [query, setQuery] = useState("");
  const [field, setField] = useState("all");
  const [set, setSet] = useState("all");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(LIST_PAGE);

  const haystack = useMemo(() => {
    const m = {};
    QUESTIONS.forEach((q) => {
      m[q.id] = (q.id + " " + (q.topics || []).join(" ") + " " + plainPreview(q.question)).toLowerCase();
    });
    return m;
  }, []);

  const list = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return QUESTIONS.filter((q) =>
      (field === "all" || q.field === field) &&
      (set === "all" || q.set === set) &&
      (status === "all" || statusOf(states, q) === status) &&
      (!kw || haystack[q.id].includes(kw))
    );
  }, [query, field, set, status, states, haystack]);

  useEffect(() => { setLimit(LIST_PAGE); }, [query, field, set, status]);

  const counts = useMemo(() => {
    const m = { all: QUESTIONS.length, due: 0, learning: 0, mastered: 0, new: 0 };
    QUESTIONS.forEach((q) => { m[statusOf(states, q)] += 1; });
    return m;
  }, [states]);

  const FILTERS = [
    { key: "all", label: "すべて" },
    { key: "due", label: "復習待ち" },
    { key: "learning", label: "学習中" },
    { key: "mastered", label: "定着" },
    { key: "new", label: "未学習" },
  ];
  const selectStyle = { flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10, background: C.panel, color: C.text, border: `1px solid ${C.border}`, fontSize: 13, fontFamily: sans };

  return (
    <div style={{ ...screenBox, gap: 14 }}>
      <TopBar title="問題一覧" onBack={onBack} />

      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="ID や問題文で検索（例: B-R05-01／単方向リスト）"
        style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: C.panel, color: C.text, border: `1px solid ${C.border}`, fontSize: 14, fontFamily: sans }} />

      <div style={{ display: "flex", gap: 8 }}>
        <select value={field} onChange={(e) => setField(e.target.value)} style={selectStyle}>
          <option value="all">分野: すべて</option>
          {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select value={set} onChange={(e) => setSet(e.target.value)} style={selectStyle}>
          <option value="all">セット: すべて</option>
          {SETS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {FILTERS.map((f) => (
          <Pill key={f.key} active={status === f.key} onClick={() => setStatus(f.key)}
            label={f.label} count={counts[f.key]} />
        ))}
      </div>

      <div style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>{list.length}問</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: C.faint, fontSize: 13 }}>該当する問題がありません</div>
        )}
        {list.slice(0, limit).map((q) => {
          const st = statusOf(states, q);
          return (
            <button key={q.id} onClick={() => onOpen(q)}
              style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", textAlign: "left", fontFamily: sans, cursor: "pointer", display: "block", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.text }}>{q.id}</span>
                <span style={{ fontSize: 11, color: fieldColor(q.field) }}>{q.field}</span>
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

// ===== 学習統計 =====
// 直近何問を見るか。科目Bの本試験は20問なのでそれに合わせる。
const RECENT_N = 20;

function BStats({ states, onBack, onReset }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const records = useMemo(() => loadRecords(), []);

  // ① 全問題数に対する分野別の定着状況（定着 = 復習3回以上）
  const coverage = useMemo(() => {
    const m = {};
    FIELDS.forEach((f) => { m[f] = { total: 0, learned: 0, mastered: 0 }; });
    QUESTIONS.forEach((q) => {
      const s = m[q.field];
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

  // ② 直近20問の正答率。復習での再解答は除き、各問題の初回解答だけを見る。
  const recent = useMemo(() => {
    const rows = [];
    QUESTIONS.forEach((q) => {
      const c = states[q.id];
      if (!c || c.history.length === 0) return;
      const first = c.history[0];
      rows.push({
        field: q.field,
        topics: q.topics || [],
        ts: typeof first.ts === "number" ? first.ts : (Date.parse(first.date) || 0),
        correct: histCorrect(first),
      });
    });
    rows.sort((a, b) => b.ts - a.ts);
    return rows.slice(0, RECENT_N);
  }, [states]);

  const groupBy = (keysOf) => {
    const m = {};
    recent.forEach((r) => {
      keysOf(r).forEach((k) => {
        if (!m[k]) m[k] = { n: 0, correct: 0 };
        m[k].n += 1;
        if (r.correct) m[k].correct += 1;
      });
    });
    return m;
  };
  const recentByField = useMemo(() => groupBy((r) => [r.field]), [recent]);
  const recentByTopic = useMemo(() => groupBy((r) => r.topics), [recent]);
  const recentRate = recent.length ? Math.round((recent.filter((r) => r.correct).length / recent.length) * 100) : 0;

  const allHistory = Object.values(states).flatMap((c) => c.history);
  const totalAnswered = allHistory.length;
  const overallRate = totalAnswered ? Math.round((allHistory.filter(histCorrect).length / totalAnswered) * 100) : 0;
  const learnedCount = Object.values(states).filter((c) => c.history.length > 0).length;

  const times = Object.values(records).map((r) => r.elapsedMs).filter((m) => m > 0);
  const avgMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const corrections = Object.values(records).reduce((s, r) => s + (r.corrections || 0), 0);

  const schedule = useMemo(() => {
    const days = {};
    for (let i = 0; i < 7; i++) days[addDays(i)] = 0;
    Object.values(states).forEach((c) => {
      if (days[c.dueDate] !== undefined) days[c.dueDate] += 1;
    });
    return Object.entries(days);
  }, [states]);
  const maxSched = Math.max(1, ...schedule.map(([, n]) => n));

  const RateBar = ({ label, s, color }) => {
    const rate = Math.round((s.correct / s.n) * 100);
    const barColor = color || (rate >= 80 ? C.accent : rate >= 50 ? C.amber : C.red);
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
          <span style={{ fontSize: 13, color: C.text }}>
            {label} <span style={{ fontSize: 11, color: C.faint }}>({s.n}問)</span>
          </span>
          <span style={{ fontFamily: mono, fontSize: 12, color: barColor }}>
            {s.correct}/{s.n}<span style={{ marginLeft: 6 }}>{rate}%</span>
          </span>
        </div>
        <div style={{ height: 6, background: C.panel, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${rate}%`, height: "100%", background: barColor, borderRadius: 3, transition: "width .5s" }} />
        </div>
      </div>
    );
  };

  return (
    <div style={screenBox}>
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

          <div>
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 4, fontFamily: mono }}>
              分野別の定着状況（全{QUESTIONS.length}問中）
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, fontSize: 10, color: C.faint }}>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.accent, marginRight: 4 }} />定着(復習3回以上)</span>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: `${C.accent}55`, marginRight: 4 }} />学習中</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {FIELDS.map((f) => {
                const s = coverage[f];
                if (!s || s.total === 0) return null;
                const mPct = (s.mastered / s.total) * 100;
                const lPct = ((s.learned - s.mastered) / s.total) * 100;
                return (
                  <div key={f}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: s.learned > 0 ? C.text : C.faint }}>{f}</span>
                      <span style={{ fontFamily: mono, fontSize: 12, color: s.mastered > 0 ? fieldColor(f) : C.faint }}>
                        {s.mastered}/{s.total}問
                        <span style={{ color: C.faint, marginLeft: 6 }}>{Math.round(mPct)}%</span>
                      </span>
                    </div>
                    <div style={{ height: 6, background: C.panel, borderRadius: 3, overflow: "hidden", display: "flex" }}>
                      <div style={{ width: `${mPct}%`, height: "100%", background: fieldColor(f), transition: "width .5s" }} />
                      <div style={{ width: `${lPct}%`, height: "100%", background: `${fieldColor(f)}55`, transition: "width .5s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: C.faint, fontFamily: mono }}>
                直近{Math.min(RECENT_N, recent.length)}問の分野別正答率
                <span style={{ marginLeft: 6, fontSize: 10 }}>（初回解答のみ）</span>
              </span>
              <span style={{ fontFamily: mono, fontSize: 12, color: C.accent }}>全体 {recentRate}%</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {FIELDS.filter((f) => recentByField[f]).map((f) => (
                <RateBar key={f} label={f} s={recentByField[f]} />
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 12, fontFamily: mono }}>
              トピック別の正答率<span style={{ marginLeft: 6, fontSize: 10 }}>（苦手な順）</span>
            </div>
            {Object.keys(recentByTopic).length === 0 ? (
              <div style={{ fontSize: 12, color: C.faint }}>まだ解答履歴がありません</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Object.entries(recentByTopic)
                  .sort((a, b) => (a[1].correct / a[1].n) - (b[1].correct / b[1].n))
                  .map(([t, s]) => <RateBar key={t} label={t} s={s} />)}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 12, fontFamily: mono }}>
              トレースの記録<span style={{ marginLeft: 6, fontSize: 10 }}>（直近{TRACE_LIMIT}問）</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <SummaryCard label="1問の平均時間" value={avgMs ? fmtMs(avgMs) : "—"} color={timeColor(avgMs)} />
              <SummaryCard label="目標" value="05:00" color={C.faint} />
              <SummaryCard label="訂正した回数" value={corrections} color={C.amber} />
            </div>
            <div style={{ fontSize: 11, color: C.faint, lineHeight: 1.8, marginTop: 10 }}>
              トレース表の内容そのものは採点していない。訂正回数は同じセルを書き直した回数。
            </div>
          </div>

          <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            {!confirmReset ? (
              <button onClick={() => setConfirmReset(true)}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "transparent", border: `1px solid ${C.border}`, color: C.faint, fontSize: 13, fontFamily: sans, cursor: "pointer" }}>
                学習データをリセット
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, color: C.red, textAlign: "center" }}>
                  科目Bの学習履歴が削除されます。よろしいですか？<br />
                  <span style={{ fontSize: 11, color: C.faint }}>科目A・英略語の履歴は消えません</span>
                </div>
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

// ===== 問題の詳細（一覧・結果から開く。解答済みとして中身を見る） =====
function BDetail({ q, onBack }) {
  const [viewer, setViewer] = useState(null);
  const [showFull, setShowFull] = useState(false);
  const program = q.programId ? PROGRAMS[q.programId] : null;
  const trace = program && program.trace;
  const filled = buildFilled(q, q.answer);

  return (
    <div style={{ ...screenBox, gap: 18 }}>
      <TopBar title="問題の詳細" onBack={onBack} />
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, background: `${fieldColor(q.field)}22`, color: fieldColor(q.field) }}>
            {q.field}
          </span>
          <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>{q.set}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, fontFamily: mono }}>{q.id}</span>
        </div>
        <QuestionBody q={q} filled={filled} onOpenFig={setViewer} />
        {program && (
          <div style={{ marginTop: 16 }}>
            <ProgramView program={program} filled={filled} />
          </div>
        )}
        <div style={{ marginTop: 18 }}>
          <ChoiceList q={q} selected={q.answer} answered onSelect={() => {}} />
        </div>
        <div style={{ marginTop: 20, padding: 14, borderRadius: 10, background: C.panel, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 8 }}>解説</div>
          <BRichText text={q.explanation} style={{ fontSize: 13.5, lineHeight: 1.85 }} />
          {(trace || q.traceExplanation) && (
            <>
              <button onClick={() => setShowFull(!showFull)} style={{
                background: "none", border: "none", color: C.blue, fontSize: 13,
                cursor: "pointer", padding: "12px 0 0", fontFamily: sans,
              }}>{showFull ? "▲ 閉じる" : "▼ 詳しく見る（トレース）"}</button>
              {showFull && (
                <div style={{ marginTop: 10 }}>
                  {trace && <TraceTable columns={trace.columns} rows={expectedRows(trace.expected)} mode="view" />}
                  {q.traceExplanation && (
                    <BRichText text={q.traceExplanation} style={{ fontSize: 13.5, lineHeight: 1.85, marginTop: 14 }} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: C.faint, marginTop: 14 }}>出典: {q.source}</div>
      </div>
      {viewer && <ImageViewer fig={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

// ===== ルート =====
// 外枠（幅480pxの器・GlobalStyle）は描かない。それは呼び出す側（本体の App か単体確認用の入口）の役目。
// 出題中は onBusyChange(true) を伝え、本体の下部タブを隠させる（他の3モードと同じ約束）。
export default function KamokuBApp({ onBusyChange }) {
  const [screen, setScreen] = useState("home");
  const [states, updateCard, resetAll] = useCardStates(STORAGE_KEY);
  const [prefs, setPrefs] = usePrefs();
  const [sessionQs, setSessionQs] = useState([]);
  const [sessionLog, setSessionLog] = useState([]);
  const [detail, setDetail] = useState(null);
  const [showRef, setShowRef] = useState(false);

  const dueQuestions = useMemo(() => {
    const today = todayStr();
    return QUESTIONS.filter((q) => {
      const c = states[q.id];
      return c && c.dueDate <= today;
    });
  }, [states]);
  const newCount = QUESTIONS.filter((q) => !states[q.id]).length;

  useEffect(() => { if (onBusyChange) onBusyChange(screen === "session"); }, [screen, onBusyChange]);

  const start = (qs) => {
    if (!qs.length) return;
    setSessionQs(qs);
    setScreen("session");
  };

  let body;
  if (screen === "session") {
    body = <BSession questions={sessionQs} prefs={prefs} setPrefs={setPrefs} updateCard={updateCard}
      onQuit={() => setScreen("home")}
      onFinish={(log) => { setSessionLog(log); setScreen("result"); }} />;
  } else if (screen === "result") {
    body = <BResult log={sessionLog} onHome={() => setScreen("home")}
      onOpen={(q) => { setDetail({ q, from: "result" }); setScreen("detail"); }} />;
  } else if (screen === "detail") {
    body = <BDetail q={detail.q} onBack={() => setScreen(detail.from)} />;
  } else if (screen === "setup") {
    body = <BSetup states={states} onBack={() => setScreen("home")} onStart={start} />;
  } else if (screen === "list") {
    body = <BList states={states} onBack={() => setScreen("home")}
      onOpen={(q) => { setDetail({ q, from: "list" }); setScreen("detail"); }} />;
  } else if (screen === "stats") {
    body = <BStats states={states} onBack={() => setScreen("home")} onReset={resetAll} />;
  } else {
    body = <BHome states={states} prefs={prefs} setPrefs={setPrefs}
      dueCount={dueQuestions.length} newCount={newCount}
      onReview={() => start(dueQuestions.slice(0, 10))}
      onSetup={() => setScreen("setup")}
      onList={() => setScreen("list")}
      onStats={() => setScreen("stats")}
      onRef={() => setShowRef(true)} />;
  }

  return (
    <>
      {body}
      {showRef && (
        <Modal title="擬似言語の記述形式" onClose={() => setShowRef(false)}>
          <BRichText text={REF_TEXT} style={{ fontSize: 13, lineHeight: 1.8, color: C.text }} />
        </Modal>
      )}
    </>
  );
}
