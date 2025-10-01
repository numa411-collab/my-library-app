import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/* ======================== 型定義 ======================== */
export type Book = {
  id: string;
  title: string;
  author: string;
  isbn: string;
  year: string;
  publisher: string;
  tags: string[]; // 「タグ」列（;区切り）を配列で保持
  location: string;
  status: "所蔵" | "貸出中";
  note: string;
  // 追加列は extras に格納（雑誌コード/タイムスタンプ/表紙URL）
  extras?: Record<string, string>;
};

/* ======================== ユーティリティ ======================== */
const uuid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36)) as string;

const emptyBook = (): Book => ({
  id: uuid(),
  title: "",
  author: "",
  isbn: "",
  year: "",
  publisher: "",
  tags: [],
  location: "",
  status: "所蔵",
  note: "",
});

function normalizeIsbn(raw: string) {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 13) return d;
  if (d.length === 10) {
    const core12 = "978" + d.slice(0, 9);
    return core12 + ean13CheckDigit(core12);
  }
  return d; // それ以外は生値（空もOK）
}
function ean13CheckDigit(core12: string) {
  let sum = 0;
  for (let i = 0; i < core12.length; i++) {
    const n = Number(core12[i] || 0);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const r = sum % 10;
  return r === 0 ? "0" : String(10 - r);
}
function normalize(s: string) {
  return (s || "").toString().normalize("NFKC").toLowerCase().trim();
}
function parseTags(input: string | string[]) {
  if (Array.isArray(input)) return input.map((t) => t.trim()).filter(Boolean);
  return String(input || "")
    .split(/[;、\s]+/) // 「;」推奨だが空白・読点も許容
    .map((t) => t.trim())
    .filter(Boolean);
}
function save(key: string, data: any) {
  localStorage.setItem(key, JSON.stringify(data));
}
function load<T = any>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function csvEscape(value: string) {
  const v = value ?? "";
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

/* ======================== CSVヘッダ ======================== */
// 新：タグあり（書き出しは常にこちら）
const JP_HEADERS = [
  "ISBNコード",
  "雑誌コード",
  "タイトル",
  "著者",
  "出版社",
  "年",
  "タイムスタンプ",
  "表紙",
  "場所",
  "状態",
  "メモ",
  "タグ",
] as const;

// 旧：タグなし（読み込み時のみ許容）
const JP_HEADERS_LEGACY = [
  "ISBNコード",
  "雑誌コード",
  "タイトル",
  "著者",
  "出版社",
  "年",
  "タイムスタンプ",
  "表紙",
  "場所",
  "状態",
  "メモ",
] as const;

type JpHeader = (typeof JP_HEADERS)[number];

/* ======================== CSV 低レベルパーサ ======================== */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur = "", inQ = false, row: string[] = [];
  const src = String(text ?? "").replace(/\r\n/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ======================== ヘッダ検出（新旧対応） ======================== */
function normalizeHeaderCell(s: string) {
  return String(s || "")
    .replace(/\s+/g, "") // 空白除去（全角/半角問わず）
    .normalize("NFKC");
}
function detectHeaderMap(headerRow: string[]) {
  const norm = headerRow.map(normalizeHeaderCell);
  const NEW_NORM = JP_HEADERS.map(normalizeHeaderCell);
  const OLD_NORM = JP_HEADERS_LEGACY.map(normalizeHeaderCell);

  const isNew = norm.length >= NEW_NORM.length && NEW_NORM.every((h, i) => norm[i] === h);
  const isOld =
    !isNew &&
    norm.length >= OLD_NORM.length &&
    OLD_NORM.every((h, i) => norm[i] === h);

  if (isNew) {
    const map: Record<string, number> = {};
    JP_HEADERS.forEach((h, i) => (map[h] = i));
    return { kind: "new" as const, map };
  }
  if (isOld) {
    const map: Record<string, number> = {};
    JP_HEADERS_LEGACY.forEach((h, i) => (map[h] = i));
    (map as any)["タグ"] = -1; // 旧ヘッダには無い
    return { kind: "old" as const, map };
  }

  throw new Error(
    "CSVヘッダが想定順序と一致しません。\n" +
      "許容される先頭行：\n" +
      "・新（タグあり）: " +
      JP_HEADERS.join(", ") +
      "\n" +
      "・旧（タグなし）: " +
      JP_HEADERS_LEGACY.join(", ")
  );
}

/* ======================== CSV 読み込み/書き出し ======================== */
function fromCSV_JP(text: string): Book[] {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const header = rows.shift() || [];
  const prof = detectHeaderMap(header);

  const getCell = (r: string[], key: JpHeader) => {
    const idx = (prof.map as any)[key];
    return idx != null && idx >= 0 ? String(r[idx] ?? "").trim() : "";
  };

  const list: Book[] = [];
  for (const r of rows) {
    if (!r || r.every((c) => String(c ?? "").trim() === "")) continue;

    const isbnRaw = normalizeIsbn(getCell(r, "ISBNコード"));
    const title = getCell(r, "タイトル");
    if (!isbnRaw && !title) continue;

    const b: Book = {
      ...emptyBook(),
      title,
      author: getCell(r, "著者"),
      isbn: isbnRaw,
      year: getCell(r, "年"),
      publisher: getCell(r, "出版社"),
      tags: parseTags(getCell(r, "タグ")),        // 旧CSVなら空配列
      location: getCell(r, "場所"),
      status: getCell(r, "状態") === "貸出中" ? "貸出中" : "所蔵",
      note: getCell(r, "メモ"),
      extras: {},
    };

    const magazine_code = getCell(r, "雑誌コード");
    const timestamp = getCell(r, "タイムスタンプ");
    const cover = getCell(r, "表紙");
    if (magazine_code) (b.extras as any).magazine_code = magazine_code;
    if (timestamp) (b.extras as any).timestamp = timestamp;
    if (cover) (b.extras as any).cover = cover;

    list.push(b);
  }
  return list;
}


function toCSV_JP(books: Book[]) {
  const head = JP_HEADERS.join(",");
  const lines = [head];
  for (const b of books) {
    const row = [
      csvEscape(b.isbn ?? ""),
      csvEscape(String(b.extras?.magazine_code ?? "")),
      csvEscape(b.title ?? ""),
      csvEscape(b.author ?? ""),
      csvEscape(b.publisher ?? ""),
      csvEscape(b.year ?? ""),                          // ← ここの余計な ')' を削除済み
      csvEscape(String(b.extras?.timestamp ?? "")),
      csvEscape(String(b.extras?.cover ?? "")),
      csvEscape(b.location ?? ""),
      csvEscape(b.status ?? "所蔵"),
      csvEscape(b.note ?? ""),
      csvEscape((b.tags || []).join(";")),
    ].join(",");
    lines.push(row);
  }
  return lines.join("\n");
}


/* ======================== 列表示設定 ======================== */
type ColumnKey =
  | "isbn" | "title" | "author" | "publisher" | "year"
  | "location" | "status" | "tags" | "note"
  | "extra:cover" | "extra:magazine_code" | "extra:timestamp";

type ColumnConfig = { key: ColumnKey; label: string; visible: boolean };
const COL_STORAGE_KEY = "books.columns.jp-only";

const APP_DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: "isbn",      label: "ISBN",           visible: true },
  { key: "title",     label: "タイトル",       visible: true },
  { key: "author",    label: "著者",           visible: true },
  { key: "publisher", label: "出版社",         visible: true },
  { key: "year",      label: "発行年",         visible: true },
  { key: "location",  label: "場所",           visible: true },
  { key: "status",    label: "状態",           visible: true },
  { key: "tags",      label: "タグ",           visible: true }, // タグ列を表示
  { key: "note",      label: "メモ",           visible: true },
  { key: "extra:cover",         label: "表紙",           visible: false },
  { key: "extra:magazine_code", label: "雑誌コード",     visible: false },
  { key: "extra:timestamp",     label: "タイムスタンプ", visible: false },
];

function loadColumns(): ColumnConfig[] | null {
  try { return JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || "null"); }
  catch { return null; }
}
function saveColumns(cols: ColumnConfig[]) {
  localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(cols));
}

/* ======================== UI本体 ======================== */
export default function LibraryApp() {
  // タブタイトルを統一
  useEffect(() => {
    document.title = "沼田真一研究室 蔵書検索アプリ";
  }, []);

  const [books, setBooks] = useState<Book[]>(() => load("books.jp-only", []));
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"title" | "author" | "year" | "location" | "status">("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "所蔵" | "貸出中">("all");
  const [editing, setEditing] = useState<Book | null>(null);

  const [columns, setColumns] = useState<ColumnConfig[]>(
    () => loadColumns() ?? APP_DEFAULT_COLUMNS
  );
  const show = (k: ColumnKey) => columns.find((c) => c.key === k)?.visible ?? true;

  // 複数選択（削除用）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelected = (id: string) => selectedIds.has(id);
  const selectedCount = selectedIds.size;
  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // 保存
  useEffect(() => { save("books.jp-only", books); }, [books]);

  // タグ集計
  const allTags = useMemo(() => {
    const s = new Set<string>();
    books.forEach((b) => (b.tags || []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [books]);

  // フィルタ・並べ替え
  const filtered = useMemo(() => {
    const q = normalize(query);
    let res = books.filter((b) => {
      const hay = [
        b.title, b.author, b.isbn, b.year, b.publisher,
        (b.tags || []).join(" "),
        b.location, b.status, b.note,
        b.extras?.magazine_code ?? "", b.extras?.timestamp ?? "", b.extras?.cover ?? "",
      ].map((x) => normalize(String(x ?? ""))).join(" ");
      const qOk = q ? hay.includes(q) : true;
      const tOk = tagFilter ? (b.tags || []).includes(tagFilter) : true;
      const sOk = statusFilter === "all" ? true : b.status === statusFilter;
      return qOk && tOk && sOk;
    });
    res.sort((a, b) => {
      const av = normalize(String(a[sortBy] ?? ""));
      const bv = normalize(String(b[sortBy] ?? ""));
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return res;
  }, [books, query, tagFilter, statusFilter, sortBy, sortDir]);

  // 表示中を全選択/解除
  const allFilteredSelected = useMemo(() => {
    if (!filtered.length) return false;
    return filtered.every(b => selectedIds.has(b.id));
  }, [filtered, selectedIds]);
  function toggleSelectAllFiltered() {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const everySelected = filtered.every(b => next.has(b.id));
      if (everySelected) {
        filtered.forEach(b => next.delete(b.id));
      } else {
        filtered.forEach(b => next.add(b.id));
      }
      return next;
    });
  }
  function removeSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`選択した ${selectedIds.size} 冊を削除します。よろしいですか？`)) return;
    setBooks(prev => prev.filter(b => !selectedIds.has(b.id)));
    clearSelection();
  }

  // CSV 書き出し（英語ファイル名）
  function handleExport() {
    const today = new Date().toISOString().slice(0, 10);
    download(`NumataLab_Books_${today}.csv`, toCSV_JP(books));
  }

  // CSV 読み込み（新旧ヘッダ対応）
  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const txt = String(reader.result || "");
        const incoming = fromCSV_JP(txt);
        if (!incoming.length) return alert("CSVに行がありません");

        setBooks((prev) => {
          const byIsbn = new Map<string, Book>();
          const byId = new Map<string, Book>();
          for (const b of prev) {
            if (b.isbn) byIsbn.set(normalizeIsbn(b.isbn), b);
            byId.set(b.id, b);
          }
          let added = 0, updated = 0;

          for (const inc of incoming) {
            const keyIsbn = normalizeIsbn(inc.isbn);
            const target = keyIsbn ? byIsbn.get(keyIsbn) : null;

            if (!target) {
              const newRec: Book = {
                ...emptyBook(),
                ...inc,
                id: inc.id || uuid(),
                isbn: keyIsbn || inc.isbn,
                status: inc.status === "貸出中" ? "貸出中" : "所蔵",
              };
              if (newRec.isbn) byIsbn.set(newRec.isbn, newRec);
              byId.set(newRec.id, newRec);
              added++;
            } else {
              const merged: Book = {
                ...target,
                title: inc.title,
                author: inc.author,
                isbn: keyIsbn || inc.isbn,
                year: inc.year,
                publisher: inc.publisher,
                tags: inc.tags || [],
                location: inc.location,
                status: inc.status,
                note: inc.note,
                extras: { ...(target.extras || {}), ...(inc.extras || {}) },
              };
              byId.set(merged.id, merged);
              if (merged.isbn) byIsbn.set(merged.isbn, merged);
              updated++;
            }
          }
          alert(`取り込み：新規 ${added} / 上書き ${updated}`);
          return Array.from(byId.values());
        });
      } catch (e: any) {
        alert("CSV読込に失敗: " + (e?.message ?? e));
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // 1冊更新/追加・1冊削除
  function upsertBook(book: Book) {
    setBooks((prev) => {
      const i = prev.findIndex((x) => x.id === book.id);
      if (i === -1) return [book, ...prev];
      const copy = [...prev];
      copy[i] = book;
      return copy;
    });
  }
  function removeBook(id: string) {
    if (!confirm("削除してよいですか？")) return;
    setBooks((prev) => prev.filter((b) => b.id !== id));
  }

  // サンプル追加
  function handleSample() {
    const sample: Book[] = [
      {
        ...emptyBook(),
        title: "消費社会の神話と構造",
        author: "ジャン・ボードリヤール",
        isbn: "9784480090474",
        year: "1970/2008",
        publisher: "ちくま学芸文庫",
        tags: ["社会学", "理論"],
        location: "研究室A-3",
        status: "所蔵",
        note: "付箋多数",
        extras: {
          magazine_code: "",
          timestamp: new Date().toISOString(),
          cover: "https://cover.openbd.jp/9784480090474.jpg",
        },
      },
      {
        ...emptyBook(),
        title: "音楽・メディア論集",
        author: "T.W. アドルノ",
        isbn: "",
        year: "1998",
        publisher: "平凡社",
        tags: ["メディア論", "音楽"],
        location: "自宅書斎B-2",
        status: "所蔵",
        note: "講義用資料",
        extras: { magazine_code: "", timestamp: new Date().toISOString(), cover: "" },
      },
      {
        ...emptyBook(),
        title: "現代思想 2023年9月号 特集＝生活史／エスノグラフィー",
        author: "編集部",
        isbn: "4910032930934",
        year: "2023/09",
        publisher: "青土社",
        tags: ["生活史", "エスノグラフィー"],
        location: "PDF/クラウド",
        status: "貸出中",
        note: "学生貸出中（佐藤さん）",
        extras: { magazine_code: "4910032930934", timestamp: new Date().toISOString(), cover: "" },
      },
    ];
    setBooks(prev => [...sample, ...prev]);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-3">
            沼田真一研究室 蔵書検索アプリ
            <span className="text-sm text-slate-500">
              {filtered.length} / {books.length} 冊
            </span>
          </h1>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              type="text"
              placeholder="検索：タイトル・著者・ISBN・タグ・場所・メモ…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-72 md:w-96 rounded-xl border border-slate-300 px-4 py-2 focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-400"
            />
            <button onClick={() => setEditing(emptyBook())} className="rounded-xl bg-indigo-600 text-white px-4 py-2 shadow hover:bg-indigo-700">+ 追加</button>

            <label className="rounded-xl border border-slate-300 px-4 py-2 bg-white cursor-pointer hover:bg-slate-50">
              CSV読み込み
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImport(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
            <button onClick={handleExport} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">CSV書出</button>
            <button onClick={handleSample} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">サンプル追加</button>

            {/* 複数選択操作 */}
            <button
              onClick={toggleSelectAllFiltered}
              className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50"
              disabled={filtered.length === 0}
              title="現在の検索・フィルタで表示中を全選択/解除"
            >
              {allFilteredSelected ? "表示中の選択を解除" : "表示中を全選択"}
            </button>
            <button
              onClick={removeSelected}
              className={`rounded-xl px-4 py-2 border ${selectedCount ? "border-rose-300 text-rose-700 bg-white hover:bg-rose-50" : "border-slate-200 text-slate-300 bg-white cursor-not-allowed"}`}
              disabled={selectedCount === 0}
              title="選択した本を削除"
            >
              選択削除（{selectedCount}）
            </button>

            {/* 表示カラム */}
            <details className="rounded-xl border border-slate-300 px-3 py-2 bg-white">
              <summary className="cursor-pointer select-none">表示カラム</summary>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
                {columns.map((c, i) => (
                  <label key={String(c.key)} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={c.visible}
                      onChange={() => {
                        const next = columns.map((x, j) => j === i ? { ...x, visible: !x.visible } : x);
                        setColumns(next); saveColumns(next);
                      }}
                    />
                    {c.label}
                  </label>
                ))}
                <button
                  type="button"
                  className="mt-2 px-2 py-1 border rounded text-xs"
                  onClick={() => { setColumns(APP_DEFAULT_COLUMNS); saveColumns(APP_DEFAULT_COLUMNS); }}
                >
                  既定に戻す
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* フィルタ群 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="col-span-1 flex flex-col gap-2 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
            <h2 className="font-semibold">フィルタ</h2>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">タグ：</label>
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 bg-white"
              >
                <option value="">（すべて）</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">状態：</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 bg-white"
              >
                <option value="all">（すべて）</option>
                <option value="所蔵">所蔵</option>
                <option value="貸出中">貸出中</option>
              </select>
            </div>
          </div>

          <div className="col-span-1 md:col-span-2 flex flex-col gap-2 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
            <h2 className="font-semibold">並べ替え</h2>
            <div className="grid grid-cols-2 gap-2">
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="rounded-xl border border-slate-300 px-3 py-2 bg-white">
                <option value="title">タイトル</option>
                <option value="author">著者</option>
                <option value="year">年</option>
                <option value="location">場所</option>
                <option value="status">状態</option>
              </select>
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value as any)} className="rounded-xl border border-slate-300 px-3 py-2 bg-white">
                <option value="asc">昇順</option>
                <option value="desc">降順</option>
              </select>
            </div>
          </div>
        </div>

        {/* 一覧 */}
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((b) => (
            <li
              key={b.id}
              className={`bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow transition ${isSelected(b.id) ? "ring-2 ring-indigo-200" : ""}`}
            >
              <div className="space-y-3">
                {/* 選択チェック */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected(b.id)}
                    onChange={() => toggleSelect(b.id)}
                    className="w-4 h-4 accent-indigo-600"
                    aria-label="選択"
                  />
                  <span className="text-xs text-slate-400">{isSelected(b.id) ? "選択中" : ""}</span>
                </div>

                {/* 上段：メタ＋操作 */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    {show("title") && (
                      <div className="text-lg font-semibold leading-snug break-words">
                        {b.title || <span className="text-slate-400">（無題）</span>}
                      </div>
                    )}
                    {(show("author") || show("year")) && (
                      <div className="text-slate-600 mt-0.5">
                        {show("author") && b.author}
                        {show("year") && b.year && <span className="ml-2">（{b.year}）</span>}
                      </div>
                    )}
                    {(show("publisher") || show("isbn")) && (
                      <div className="text-slate-600 text-sm mt-1 break-words">
                        {show("publisher") && b.publisher}
                        {show("isbn") && b.isbn && <span className="ml-2">ISBN: {b.isbn}</span>}
                      </div>
                    )}

                    {/* タグ */}
                    {show("tags") && (b.tags?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {(b.tags || []).map((t) => (
                          <button
                            key={t}
                            onClick={() => setTagFilter(t)}
                            className={`text-xs px-2 py-1 rounded-full border ${
                              tagFilter === t
                                ? "bg-slate-800 text-white border-slate-800"
                                : "bg-slate-50 text-slate-700 border-slate-200"
                            }`}
                          >
                            #{t}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* 追加情報（テキスト） */}
                    {show("extra:magazine_code") && b.extras?.magazine_code && (
                      <div className="text-sm text-slate-700 mt-1">雑誌コード：{b.extras.magazine_code}</div>
                    )}
                    {show("extra:timestamp") && b.extras?.timestamp && (
                      <div className="text-sm text-slate-700 mt-1">タイムスタンプ：{b.extras.timestamp}</div>
                    )}
                    {show("note") && b.note && (
                      <div className="text-sm text-slate-700 mt-1"><span className="text-slate-500">メモ：</span>{b.note}</div>
                    )}
                    {show("location") && b.location && (
                      <div className="text-sm text-slate-700 mt-1"><span className="text-slate-500">場所：</span>{b.location}</div>
                    )}
                  </div>

                  <div className="flex items-start gap-3">
                    {/* 表紙サムネ（右上） */}
                    {show("extra:cover") && b.extras?.cover && (
                      <a href={b.extras.cover} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={b.extras.cover}
                          alt="cover"
                          className="w-16 h-24 object-cover rounded-md border border-slate-200"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      </a>
                    )}
                    <div className="flex flex-col items-end gap-2">
                      {show("status") && (
                        <span
                          className={
                            "text-xs px-2 py-1 rounded-full border " +
                            (b.status === "所蔵"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200")
                          }
                        >
                          {b.status}
                        </span>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditing(b)}
                          className="text-indigo-700 hover:bg-indigo-50 px-3 py-1 rounded-lg border border-indigo-200"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => removeBook(b.id)}
                          className="text-rose-700 hover:bg-rose-50 px-3 py-1 rounded-lg border border-rose-200"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            </li>
          ))}
        </ul>
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-8 text-xs text-slate-500">
        <p>
          <strong>沼田真一研究室 蔵書検索アプリ</strong> のデータは
          この端末の <strong>localStorage</strong> に保存されます。ブラウザを変えると別データになります。
          共有する場合はCSVを書き出して他端末で取り込んでください。
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer">CSVの列仕様（クリックで開く）</summary>
          <pre className="mt-2 bg-slate-100 rounded-xl p-3 overflow-auto">{`
ヘッダ（固定・順序厳守）:
${JP_HEADERS.join(", ")}

- 「タグ」は「;」区切り（例: 社会学;理論;講義用）
- 「状態」は「所蔵」または「貸出中」
- 「表紙」はURL（任意）
- 旧CSV（タグなし）も読み込み可（書き出しは常にタグあり）
          `}</pre>
        </details>
      </footer>

      {/* 編集ダイアログ */}
      {editing && (
        <EditDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(b) => { upsertBook(b); setEditing(null); }}
        />
      )}
    </div>
  );
}

/* ======================== 編集ダイアログ ======================== */
function EditDialog({ initial, onClose, onSave }: { initial: any; onClose: () => void; onSave: (b: any) => void; }) {
  const [b, setB] = useState<any>({ ...initial });
  const [scanOpen, setScanOpen] = useState(false);
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  function set<K extends keyof typeof b>(key: K, val: (typeof b)[K]) {
    setB((prev: any) => ({ ...prev, [key]: val }));
  }

  return (
    <dialog ref={ref} className="backdrop:bg-black/40 rounded-2xl p-0 border-0 w-11/12 md:w-2/3 lg:w-1/2">
      <form
        method="dialog"
        className="bg-white rounded-2xl overflow-hidden border border-slate-200"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...b,
            isbn: normalizeIsbn(b.isbn || ""),
            tags: parseTags(Array.isArray(b.tags) ? b.tags.join(";") : b.tags),
          });
        }}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold">書誌情報</h3>
          <button onClick={onClose} className="text-slate-600 hover:bg-slate-100 px-3 py-1 rounded-lg">閉じる</button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[70vh] overflow-auto">
          <Field label="タイトル">
            <input value={b.title} onChange={(e) => set("title", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" required />
          </Field>
          <Field label="著者">
            <input value={b.author} onChange={(e) => set("author", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" />
          </Field>

          <Field label="ISBN">
            <div className="flex gap-2">
              <input value={b.isbn} onChange={(e) => set("isbn", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="978…" inputMode="numeric" />
              <button type="button" onClick={() => setScanOpen(true)} className="shrink-0 rounded-xl border border-slate-300 px-3 py-2 bg-white hover:bg-slate-50" title="カメラでスキャン">📷</button>
            </div>
          </Field>

          <Field label="発行年">
            <input value={b.year} onChange={(e) => set("year", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="1997 / 2008 など" />
          </Field>
          <Field label="出版社・媒体">
            <input value={b.publisher} onChange={(e) => set("publisher", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" />
          </Field>
          <Field label="タグ（; 区切り）">
            <input value={Array.isArray(b.tags) ? b.tags.join(";") : b.tags} onChange={(e) => set("tags", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="社会学;理論;講義用" />
          </Field>
          <Field label="場所">
            <input value={b.location} onChange={(e) => set("location", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="研究室A-3 / 自宅B-2 など" />
          </Field>
          <Field label="状態">
            <select value={b.status} onChange={(e) => set("status", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white">
              <option value="所蔵">所蔵</option>
              <option value="貸出中">貸出中</option>
            </select>
          </Field>
          <Field label="メモ" span>
            <textarea value={b.note} onChange={(e) => set("note", e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 min-h-[80px]" />
          </Field>

          <Field label="雑誌コード">
            <input
              value={b.extras?.magazine_code ?? ""}
              onChange={(e) => set("extras", { ...(b.extras || {}), magazine_code: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </Field>
          <Field label="タイムスタンプ">
            <input
              value={b.extras?.timestamp ?? ""}
              onChange={(e) => set("extras", { ...(b.extras || {}), timestamp: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="YYYY-MM-DD HH:mm:ss 等"
            />
          </Field>
          <Field label="表紙URL（クリックで表示）" span>
            <input
              value={b.extras?.cover ?? ""}
              onChange={(e) => set("extras", { ...(b.extras || {}), cover: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="https://…"
            />
            {b.extras?.cover && (
              <a href={b.extras.cover} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <img
                  src={b.extras.cover}
                  className="w-24 h-36 object-cover rounded-md border border-slate-200"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              </a>
            )}
          </Field>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2 bg-slate-50">
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">キャンセル</button>
          <button type="submit" className="rounded-xl bg-indigo-600 text-white px-4 py-2 shadow hover:bg-indigo-700">保存</button>
        </div>
      </form>

      {scanOpen && (
        <ScanDialog
          onClose={() => setScanOpen(false)}
          onDetected={(code) => {
            const cleaned = (code || "").replace(/[^0-9]/g, "");
            if (cleaned) setB((prev: any) => ({ ...prev, isbn: cleaned }));
            setScanOpen(false);
          }}
        />
      )}
    </dialog>
  );
}

/* ======================== スキャナ ======================== */
function ScanDialog({ onClose, onDetected }: { onClose: () => void; onDetected: (code: string) => void; }) {
  const ref = React.useRef<HTMLDialogElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    ref.current?.showModal();
    const reader = new BrowserMultiFormatReader();
    (async () => {
      try {
        await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current!,
          (result, _e, controls) => {
            if (result) {
              const cleaned = result.getText().replace(/[^0-9]/g, "");
              if (cleaned) {
                controls.stop();
                stopStream();
                onDetected(cleaned);
              }
            }
          }
        );
      } catch (e: any) {
        setErr("カメラ起動に失敗: " + (e?.message || String(e)));
      }
    })();
    return () => { stopStream(); };

    function stopStream() {
      const v = videoRef.current;
      if (v?.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      }
    }
  }, [onDetected]);

  function stopStream() {
    const v = videoRef.current;
    if (v?.srcObject) {
      (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
  }

  return (
    <dialog ref={ref} className="backdrop:bg-black/40 rounded-2xl p-0 border-0 w-11/12 md:w-2/3">
      <div className="bg-white rounded-2xl overflow-hidden border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold">ISBNをスキャン</h3>
          <button onClick={() => { stopStream(); onClose(); }} className="text-slate-600 hover:bg-slate-100 px-3 py-1 rounded-lg">閉じる</button>
        </div>
        <div className="p-4">
          <video ref={videoRef} className="w-full rounded-xl bg-black aspect-video" autoPlay muted playsInline />
          {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
        </div>
      </div>
    </dialog>
  );
}

/* ======================== 汎用 Field ======================== */
function Field({ label, children, span = false }: any) {
  return (
    <label className={`flex flex-col gap-1 ${span ? "md:col-span-2" : ""}`}>
      <span className="text-sm text-slate-600">{label}</span>
      {children}
    </label>
  );
}
