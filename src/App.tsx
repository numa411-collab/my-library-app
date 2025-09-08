import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { createClient } from "@supabase/supabase-js";

/* -------- Supabase -------- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
// env 未設定でもアプリは落ちないようにする（ボタンで警告）
const supabase = (supabaseUrl && supabaseAnon)
  ? createClient(supabaseUrl, supabaseAnon)
  : ({} as any);

/* -------- 型定義 -------- */
export type Book = {
  id: string;
  title: string;
  author: string;
  isbn: string;
  year: string;
  publisher: string;
  tags: string[];
  location: string;
  status: "所蔵" | "貸出中";
  note: string;
  // CSVにある拡張列はここに保持
  extras?: Record<string, string>;
};

/* -------- ユーティリティ -------- */
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

const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

function normalizeIsbn(raw: string) {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 13) return d;
  if (d.length === 10) {
    const core12 = "978" + d.slice(0, 9);
    return core12 + ean13CheckDigit(core12);
  }
  return "";
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

function mergeFillBlanks(existing: Book, incoming: Book): Book {
  const out: Book = { ...existing };
  out.id = existing.id;

  // tags は和集合
  const incTags = Array.isArray(incoming.tags)
    ? incoming.tags
    : parseTags((incoming as any).tags ?? "");
  const tagSet = new Set([...(existing.tags || []), ...(incTags || [])]);
  out.tags = Array.from(tagSet);

  // 文字列フィールドは空欄だけ埋める
  (["title", "author", "isbn", "year", "publisher", "location", "note"] as const).forEach((k) => {
    const inc = incoming[k] ?? "";
    if (isEmpty(out[k]) && !isEmpty(inc)) (out as any)[k] = inc;
  });

  // extras も空欄だけ埋める
  if ((incoming.extras && Object.keys(incoming.extras).length) || (existing.extras && Object.keys(existing.extras!).length)) {
    const ex: Record<string, string> = { ...(existing.extras || {}) };
    for (const [k, v] of Object.entries(incoming.extras || {})) {
      if (isEmpty(ex[k]) && !isEmpty(v)) ex[k] = String(v);
    }
    if (Object.keys(ex).length) out.extras = ex;
  }

  if (!isEmpty(incoming.status)) out.status = incoming.status;
  if (!isEmpty(out.isbn)) out.isbn = normalizeIsbn(out.isbn);
  return out;
}

function normalize(s: string) {
  return (s || "").toString().normalize("NFKC").toLowerCase().trim();
}
function parseTags(input: string | string[]) {
  if (Array.isArray(input)) return input.map((t) => t.trim()).filter(Boolean);
  return String(input || "")
    .split(/[;,、\s]+/)
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
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function toCSV(books: Book[]) {
  const header = ["id", "title", "author", "isbn", "year", "publisher", "tags", "location", "status", "note"];
  // すべての extras キーを収集（出力に含めたい場合）
  const extraKeys = Array.from(
    books.reduce((set, b) => {
      Object.keys(b.extras || {}).forEach((k) => set.add(k));
      return set;
    }, new Set<string>())
  );
  const lines = [[...header, ...extraKeys].join(",")];

  for (const b of books) {
    const rowCore = [
      b.id,
      b.title,
      b.author,
      b.isbn,
      b.year,
      b.publisher,
      (b.tags || []).join(";"),
      b.location,
      b.status,
      b.note,
    ].map((v) => csvEscape(String(v ?? "")));
    const rowExtra = extraKeys.map((k) => csvEscape(String(b.extras?.[k] ?? "")));
    lines.push([...rowCore, ...rowExtra].join(","));
  }
  return lines.join("\n");
}

/* -------- CSV 読み込み（extras対応） -------- */
function fromCSV(text: string): Book[] {
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

  const header = rows.shift() || [];
  const idx = (k: string) => header.indexOf(k);
  const std = new Set(["id","title","author","isbn","year","publisher","tags","location","status","note"]);

  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const b = emptyBook();
      const get = (k: string) => (idx(k) >= 0 ? r[idx(k)] : "");
      b.id = get("id") || uuid();
      b.title = get("title");
      b.author = get("author");
      b.isbn = normalizeIsbn(get("isbn"));
      b.year = get("year");
      b.publisher = get("publisher");
      b.tags = parseTags(get("tags"));
      b.location = get("location");
      b.status = get("status") === "貸出中" ? "貸出中" : "所蔵";
      b.note = get("note");

      // extras
      const extras: Record<string, string> = {};
      for (const key of header) {
        if (!std.has(key) && idx(key) >= 0) extras[key] = String(r[idx(key)] ?? "");
      }
      if (Object.keys(extras).length) b.extras = extras;

      return b;
    })
    .filter((b) => !!b.isbn || !!b.title);
}

/* -------- API（OpenBD / Google Books） -------- */
async function fetchFromOpenBD(isbn: string) {
  const clean = (isbn || "").replace(/\D/g, "");
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${clean}`);
  if (!res.ok) return null;
  const arr = await res.json();
  const item = arr?.[0];
  if (!item) return null;
  const s = item.summary || {};
  let year = "";
  if (typeof s.pubdate === "string" && /^\d{4}/.test(s.pubdate)) {
    year = s.pubdate.length >= 6 ? `${s.pubdate.slice(0, 4)}/${s.pubdate.slice(4, 6)}` : s.pubdate.slice(0, 4);
  }
  return {
    title: s.title || "",
    author: s.author || "",
    publisher: s.publisher || "",
    year,
    isbn: clean,
  };
}
async function fetchBookByISBN(isbn: string) {
  const clean = (isbn || "").replace(/\D/g, "");
  if (!clean) throw new Error("ISBNが空です");

  let g: any = null;
  try {
    const q = encodeURIComponent(`isbn:${clean}`);
    const url = `https://www.googleapis.com/books/v1/volumes?q=${q}`;
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      const item = json?.items?.[0];
      const v = item?.volumeInfo;
      if (v) {
        g = {
          title: v.title || "",
          author: Array.isArray(v.authors) ? v.authors.join(", ") : v.authors || "",
          publisher: v.publisher || "",
          year: (v.publishedDate || "").replace(/-0?/, "/"),
          isbn: clean,
        };
      }
    }
  } catch { /* ignore */ }

  let o: any = null;
  try { o = await fetchFromOpenBD(clean); } catch { /* ignore */ }

  const merged = {
    title: g?.title || o?.title || "",
    author: g?.author || o?.author || "",
    publisher: g?.publisher || o?.publisher || "",
    year: g?.year || o?.year || "",
    isbn: clean,
  };
  if (!merged.title && !merged.author && !merged.publisher && !merged.year) {
    throw new Error("書誌情報が見つかりませんでした");
  }
  return merged;
}

/* -------- 列表示設定（表示/非表示） -------- */
type ColumnKey =
  | "isbn" | "title" | "author" | "publisher" | "year"
  | "location" | "status" | "tags" | "note"
  | `extra:${string}`;

type ColumnConfig = { key: ColumnKey; label: string; visible: boolean };
const COL_STORAGE_KEY = "books.columns";


// ==== 列設定（表示/非表示） ====
// 既定
const APP_DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: "isbn",      label: "ISBN",     visible: true },
  { key: "title",     label: "タイトル", visible: true },
  { key: "author",    label: "著者",     visible: true },
  { key: "publisher", label: "出版社",   visible: true },
  { key: "year",      label: "出版年",   visible: true },
  { key: "location",  label: "場所",     visible: true },
  { key: "status",    label: "状態",     visible: true },
  { key: "tags",      label: "タグ",     visible: true },  // 必要に応じて true/false
  { key: "note",      label: "メモ",     visible: true },
];




function loadColumns(): ColumnConfig[] | null {
  try { return JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || "null"); }
  catch { return null; }
}
function saveColumns(cols: ColumnConfig[]) {
  localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(cols));
}
function ensureExtraColumns(cols: ColumnConfig[], books: Book[]): ColumnConfig[] {
  const have = new Set(cols.map((c) => c.key));
  const extras = new Set<string>();
  for (const b of books) {
    if (!b.extras) continue;
    Object.keys(b.extras).forEach((k) => extras.add(k));
  }
  const add: ColumnConfig[] = [];
  for (const k of extras) {
    const key = `extra:${k}` as ColumnKey;
    if (!have.has(key)) add.push({ key, label: k, visible: false });
  }
  return add.length ? [...cols, ...add] : cols;
}

/* -------- UI -------- */
export default function LibraryApp() {
  const [books, setBooks] = useState<Book[]>(() => load("books", []));
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"title" | "author" | "year" | "location" | "status">("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "所蔵" | "貸出中">("all");
  const [editing, setEditing] = useState<Book | null>(null);

  // 表示カラム
  const [columns, setColumns] = useState<ColumnConfig[]>(
    () => loadColumns() ?? APP_DEFAULT_COLUMNS
  );

  const show = (k: ColumnKey) =>
  columns.find((c) => c.key === k)?.visible ?? true;

  // Supabase 認証
  const [user, setUser] = useState<any>(null);
  useEffect(() => {
    if (!supabase?.auth) return;
    const { data: sub } = supabase.auth.onAuthStateChange((_e: any, session: any) => {
      setUser(session?.user ?? null);
    });
    supabase.auth.getSession?.().then(({ data }: any) => setUser(data?.session?.user ?? null));
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  async function signInWithEmail() {
    if (!supabase?.auth) {
      alert("環境変数 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です");
      return;
    }
    const email = prompt("メールアドレス（マジックリンクを送信します）");
    if (!email) return;
    const redirectTo = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
    });
    if (error) alert("送信失敗: " + error.message);
    else alert(`「${email}」宛にリンクを送りました。届いたメールのリンクを開いてください。`);
  }
  async function signOut() { await supabase?.auth?.signOut?.(); }

  async function pullFromCloud() {
    if (!supabase?.from) return alert("Supabase が未設定です");
    if (!user) return alert("先にサインインしてください");
    const { data, error } = await supabase.from("books").select("*").order("updated_at", { ascending: false });
    if (error) return alert("取得失敗: " + error.message);
    const rows = (data || []).map((r: any) => ({
      id: String(r.id),
      title: r.title, author: r.author, isbn: r.isbn, year: r.year,
      publisher: r.publisher, tags: Array.isArray(r.tags) ? r.tags : [],
      location: r.location, status: r.status === "貸出中" ? "貸出中" : "所蔵", note: r.note,
    })) as Book[];

    setBooks((prev) => {
      const map = new Map(prev.map((b) => [b.id, b] as const));
      for (const r of rows) map.set(r.id, r);
      return Array.from(map.values());
    });
    alert(`クラウドから ${rows.length} 件取り込みました`);
  }
  async function pushToCloud() {
    if (!supabase?.from) return alert("Supabase が未設定です");
    if (!user) return alert("先にサインインしてください");
    const payload = books.map((b) => ({
      id: b.id, user_id: user.id, title: b.title, author: b.author, isbn: b.isbn,
      year: b.year, publisher: b.publisher, tags: b.tags, location: b.location,
      status: b.status, note: b.note, updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from("books").upsert(payload, { onConflict: "id" });
    if (error) return alert("同期失敗: " + error.message);
    alert(`クラウドへ ${payload.length} 件同期しました`);
  }

  // books 保存
  useEffect(() => { save("books", books); }, [books]);

  // extras 列を列設定へ取り込み
  useEffect(() => {
    setColumns((prev) => {
      const next = ensureExtraColumns(prev, books);
      if (next !== prev) saveColumns(next);
      return next;
    });
  }, [books]);

  // 集計
  const allTags = useMemo(() => {
    const s = new Set<string>();
    books.forEach((b) => (b.tags || []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [books]);

  const filtered = useMemo(() => {
    const q = normalize(query);
    let res = books.filter((b) => {
      const hay = [
        b.title, b.author, b.isbn, b.year, b.publisher,
        (b.tags || []).join(" "), b.location, b.status, b.note,
        ...Object.values(b.extras || {}),
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

  // CSV
  function handleExport() {
    download(`books_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(books));
  }
  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const txt = String(reader.result || "");
        const incoming = fromCSV(txt);
        if (!incoming.length) return alert("CSVに行がありません");

        setBooks((prev) => {
          const byIsbn = new Map<string, Book>();
          const byId = new Map<string, Book>();
          for (const b of prev) {
            if (b.isbn) byIsbn.set(normalizeIsbn(b.isbn), b);
            byId.set(b.id, b);
          }
          let added = 0, updated = 0, skipped = 0;

          for (const inc of incoming) {
            const keyIsbn = normalizeIsbn(inc.isbn);
            let target = (keyIsbn && byIsbn.get(keyIsbn)) || byId.get(inc.id);

            if (!target) {
              const newRec: Book = {
                ...emptyBook(),
                ...inc,
                id: inc.id || uuid(),
                isbn: keyIsbn || inc.isbn,
                status: inc.status === "貸出中" ? "貸出中" : "所蔵",
                tags: Array.isArray(inc.tags) ? inc.tags : parseTags((inc as any).tags ?? ""),
              };
              if (!newRec.isbn && !newRec.title) { skipped++; continue; }
              if (newRec.isbn) byIsbn.set(newRec.isbn, newRec);
              byId.set(newRec.id, newRec);
              added++;
            } else {
              const merged = mergeFillBlanks(target, inc);
              if (JSON.stringify(target) !== JSON.stringify(merged)) {
                byId.set(merged.id, merged);
                if (merged.isbn) byIsbn.set(merged.isbn, merged);
                updated++;
              }
            }
          }
          alert(`取り込み完了：新規 ${added} / 既存更新 ${updated} / スキップ ${skipped}`);
          return Array.from(byId.values());
        });
      } catch (e: any) {
        alert("CSV読込に失敗: " + (e?.message ?? e));
      }
    };
    reader.readAsText(file, "utf-8");
  }

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
        note: "付箋多数",
        extras: { price: "1100 JPY" },
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
      },
      {
        ...emptyBook(),
        title: "Narrative Analysis",
        author: "Labov & Waletzky",
        year: "1997",
        publisher: "Journal of Narrative & Life History",
        tags: ["ナラティブ", "方法論"],
        location: "PDF/クラウド",
        status: "貸出中",
        note: "学生貸出中（佐藤さん）",
        extras: { cover: "https://example.com/cover.jpg" },
      },
    ];
    setBooks((prev) => [...sample, ...prev]);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h1 className="text-xl md:text-2xl font-bold">蔵書検索ミニアプリ</h1>
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
              CSV再読み込み（マージ）
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

            {/* 区切り */}
            <div className="w-px h-6 bg-slate-200 mx-1 hidden md:block" />

            {/* 認証＆同期 */}
            {supabase?.auth ? (
              <>
                {user ? (
                  <button onClick={signOut} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">Sign out</button>
                ) : (
                  <button onClick={signInWithEmail} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">Sign in</button>
                )}
                <button onClick={pullFromCloud} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">クラウド取込</button>
                <button onClick={pushToCloud} className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50">クラウドへ同期</button>
              </>
            ) : (
              <span className="text-xs text-slate-500">Supabase未設定</span>
            )}

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

        <div className="text-sm text-slate-600 mb-2">
          {filtered.length} / {books.length} 冊
        </div>

<ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
  {filtered.map((b) => (
    <li
      key={b.id}
      className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow transition"
    >
      <div className="space-y-3">
        {/* 上段：左=書誌、右=状態&操作 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            {show("title") && (
              <div className="text-lg font-semibold leading-snug">
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
              <div className="text-slate-600 text-sm mt-1">
                {show("publisher") && b.publisher}
                {show("isbn") && b.isbn && <span className="ml-2">ISBN: {b.isbn}</span>}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
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

        {show("tags") && (
          <div className="flex flex-wrap gap-2">
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

        {(show("location") || show("note")) && (b.location || b.note) && (
          <div className="text-sm text-slate-700">
            {show("location") && b.location && (
              <div><span className="text-slate-500">場所：</span>{b.location}</div>
            )}
            {show("note") && b.note && (
              <div className="mt-1"><span className="text-slate-500">メモ：</span>{b.note}</div>
            )}
          </div>
        )}

        {b.extras && Object.keys(b.extras).length > 0 && (
          <div className="text-sm text-slate-700">
            {Object.entries(b.extras).map(([k, v]) => {
              const key = `extra:${k}` as ColumnKey;
              if (!columns.find((c) => c.key === key)?.visible || !v) return null;
              return (
                <div key={k} className="flex gap-2">
                  <span className="text-slate-500">{k}：</span><span>{v}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </li>
  ))}
</ul>
      </main>




      <footer className="max-w-5xl mx-auto px-4 py-8 text-xs text-slate-500">
        <p>
          データはこの端末の<strong>localStorage</strong>に保存されます。ブラウザを変えると別データになります。
          共有する場合はCSVを書き出して他端末で取り込んでください。
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer">CSVの列仕様（クリックで開く）</summary>
          <pre className="mt-2 bg-slate-100 rounded-xl p-3 overflow-auto">{`
ヘッダ: id,title,author,isbn,year,publisher,tags,location,status,note,(任意の追加列…)
- tags は「;」区切り（例: 社会学;理論）
- status は「所蔵」か「貸出中」
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

/* -------- 編集ダイアログ -------- */
function EditDialog({ initial, onClose, onSave }: { initial: any; onClose: () => void; onSave: (b: any) => void; }) {
  const [b, setB] = useState<any>({ ...initial });
  const [scanOpen, setScanOpen] = useState(false);
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const [autoBusy, setAutoBusy] = useState(false);

  function set<K extends keyof typeof b>(key: K, val: (typeof b)[K]) {
    setB((prev: any) => ({ ...prev, [key]: val }));
  }

  async function autofillFromISBN() {
    try {
      setAutoBusy(true);
      const isbn = String(b.isbn || "").replace(/\D/g, "");
      if (!isbn) return alert("ISBNを入力（またはスキャン）してください");
      const info = await fetchBookByISBN(isbn);
      if (!info) return alert("該当データが見つかりませんでした");
      setB((prev: any) => ({
        ...prev,
        isbn,
        title: prev.title || info.title,
        author: prev.author || info.author,
        publisher: prev.publisher || info.publisher,
        year: prev.year || info.year,
      }));
    } catch (e: any) {
      alert("取得に失敗しました: " + (e?.message || String(e)));
    } finally {
      setAutoBusy(false);
    }
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
              <button type="button" onClick={() => { void autofillFromISBN(); }} disabled={autoBusy}
                className={`shrink-0 rounded-xl border border-slate-300 px-3 py-2 bg-white hover:bg-slate-50 text-rose-600 ${autoBusy ? "opacity-60 cursor-not-allowed" : ""}`}
                title="ISBNから自動取得">
                {autoBusy ? "取得中…" : "自動取得"}
              </button>
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

/* -------- スキャナ -------- */
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

/* -------- 汎用 Field -------- */
function Field({ label, children, span = false }: any) {
  return (
    <label className={`flex flex-col gap-1 ${span ? "md:col-span-2" : ""}`}>
      <span className="text-sm text-slate-600">{label}</span>
      {children}
    </label>
  );
}
