import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/**
 * 蔵書検索ミニアプリ
 * - 端末ローカル（localStorage）に保存
 * - 検索窓でタイトル/著者/ISBN/タグ/場所/メモを横断検索
 * - CSVのインポート/エクスポート
 * - 書誌の追加・編集・削除
 * - ソート、タグでの絞り込み、貸出管理（所蔵/貸出中）
 *
 * 提案CSV列（ヘッダ）
 * id,title,author,isbn,year,publisher,tags,location,status,note
 * 例）
 * 1,『消費社会の神話と構造』,ボードリヤール,9784480090474,1970,ちくま学芸文庫,"社会学;理論",研究室A-3,所蔵,付箋多数
 */

// 型定義
const emptyBook = () => ({
  id: crypto.randomUUID(),
  title: "",
  author: "",
  isbn: "",
  year: "",
  publisher: "",
  tags: [] as string[],
  location: "",
  status: "所蔵" as "所蔵" | "貸出中",
  note: "",
});

function normalize(s: string) {
  return (s || "")
    .toString()
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

function parseTags(input: string | string[]) {
  if (Array.isArray(input)) return input.map((t) => normalize(t)).filter(Boolean);
  return input
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
  } catch (e) {
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

function toCSV(books: any[]) {
  const header = [
    "id",
    "title",
    "author",
    "isbn",
    "year",
    "publisher",
    "tags",
    "location",
    "status",
    "note",
  ];
  const lines = [header.join(",")];
  for (const b of books) {
    const row = [
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
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function fromCSV(text: string) {
  // シンプルCSVパーサ（カンマ区切り・ダブルクォート対応）
  const rows: string[][] = [];
  let cur = "";
  let inQ = false;
  let row: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const header = rows.shift() || [];
  const idx = (k: string) => header.indexOf(k);
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const b = emptyBook();
      const get = (k: string) => (idx(k) >= 0 ? r[idx(k)] : "");
      b.id = get("id") || crypto.randomUUID();
      b.title = get("title");
      b.author = get("author");
      b.isbn = get("isbn");
      b.year = get("year");
      b.publisher = get("publisher");
      b.tags = parseTags(get("tags"));
      b.location = get("location");
      b.status = (get("status") as any) || "所蔵";
      b.note = get("note");
      return b;
    });
}

export default function LibraryApp() {
  const [books, setBooks] = useState<any[]>(() => load("books", []));
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<
    "title" | "author" | "year" | "location" | "status"
  >("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "所蔵" | "貸出中">
    ("all")
  ;
  const [editing, setEditing] = useState<any | null>(null);

  useEffect(() => {
    save("books", books);
  }, [books]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    books.forEach((b) => (b.tags || []).forEach((t: string) => s.add(t)));
    return Array.from(s).sort();
  }, [books]);

  const filtered = useMemo(() => {
    const q = normalize(query);
    let res = books.filter((b) => {
      const hay = [
        b.title,
        b.author,
        b.isbn,
        b.year,
        b.publisher,
        (b.tags || []).join(" "),
        b.location,
        b.status,
        b.note,
      ]
        .map((x: any) => normalize(String(x ?? "")))
        .join(" ");
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

  function upsertBook(book: any) {
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

  function handleExport() {
    download(`books_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(books));
  }

  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const txt = String(reader.result || "");
        const rows = fromCSV(txt);
        if (!rows.length) return alert("CSVに行がありません");
        // id衝突を避けつつマージ
        setBooks((prev) => {
          const map = new Map(prev.map((b) => [b.id, b] as const));
          for (const r of rows) {
            if (map.has(r.id)) {
              // 既存は上書き
              map.set(r.id, r);
            } else {
              map.set(r.id, r);
            }
          }
          return Array.from(map.values());
        });
        alert(`${rows.length}件を取り込みました`);
      } catch (e: any) {
        alert("CSV読込に失敗: " + e?.message);
      }
    };
    reader.readAsText(file, "utf-8");
  }

  function handleSample() {
    const sample = [
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
        status: "所蔵" as const,
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
        status: "貸出中" as const,
        note: "学生貸出中（佐藤さん）",
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
            <button
              onClick={() => setEditing(emptyBook())}
              className="rounded-xl bg-indigo-600 text-white px-4 py-2 shadow hover:bg-indigo-700"
            >
              + 追加
            </button>
            <label className="rounded-xl border border-slate-300 px-4 py-2 bg-white cursor-pointer hover:bg-slate-50">
              CSV取込
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
              />
            </label>
            <button
              onClick={handleExport}
              className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50"
            >
              CSV書出
            </button>
            <button
              onClick={handleSample}
              className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50"
            >
              サンプル追加
            </button>
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
                {allTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
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
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="rounded-xl border border-slate-300 px-3 py-2 bg-white"
              >
                <option value="title">タイトル</option>
                <option value="author">著者</option>
                <option value="year">年</option>
                <option value="location">場所</option>
                <option value="status">状態</option>
              </select>
              <select
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value as any)}
                className="rounded-xl border border-slate-300 px-3 py-2 bg-white"
              >
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
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold leading-snug">
                    {b.title || <span className="text-slate-400">（無題）</span>}
                  </div>
                  <div className="text-slate-600 mt-0.5">
                    {b.author} {b.year && <span className="ml-2">（{b.year}）</span>}
                  </div>
                  <div className="text-slate-600 text-sm mt-1">
                    {b.publisher} {b.isbn && <span className="ml-2">ISBN: {b.isbn}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
              <div className="flex flex-wrap gap-2 mt-3">
                {(b.tags || []).map((t: string) => (
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
              {(b.location || b.note) && (
                <div className="mt-3 text-sm text-slate-700">
                  {b.location && (
                    <div>
                      <span className="text-slate-500">場所：</span>
                      {b.location}
                    </div>
                  )}
                  {b.note && (
                    <div className="mt-1">
                      <span className="text-slate-500">メモ：</span>
                      {b.note}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        {filtered.length === 0 && (
          <div className="text-center text-slate-500 py-16">
            ヒットなし。検索語やフィルタを変更してください。
          </div>
        )}
      </main>

      {editing && (
        <EditDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(b) => {
            upsertBook(b);
            setEditing(null);
          }}
        />
      )}

      <footer className="max-w-5xl mx-auto px-4 py-8 text-xs text-slate-500">
        <p>
          データはこの端末の<strong>localStorage</strong>に保存されます。ブラウザを変えると別データになります。
          共有する場合はCSVを書き出して他端末で取り込んでください。
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer">CSVの列仕様（クリックで開く）</summary>
          <pre className="mt-2 bg-slate-100 rounded-xl p-3 overflow-auto">{`
ヘッダ: id,title,author,isbn,year,publisher,tags,location,status,note
- tags は「;」区切り（例: 社会学;理論）
- status は「所蔵」か「貸出中」
          `}</pre>
        </details>
      </footer>
    </div>
  );
}

function EditDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: any;
  onClose: () => void;
  onSave: (b: any) => void;
}) {
  const [b, setB] = useState<any>({ ...initial });
  const [scanOpen, setScanOpen] = useState(false);
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

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
          onSave({ ...b, tags: parseTags(Array.isArray(b.tags) ? b.tags.join(";") : b.tags) });
        }}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold">書誌情報</h3>
          <button
            onClick={onClose}
            className="text-slate-600 hover:bg-slate-100 px-3 py-1 rounded-lg"
          >
            閉じる
          </button>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[70vh] overflow-auto">
          <Field label="タイトル">
            <input
              value={b.title}
              onChange={(e) => set("title", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              required
            />
          </Field>
          <Field label="著者">
            <input
              value={b.author}
              onChange={(e) => set("author", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </Field>
          <Field label="ISBN">
            <div className="flex gap-2">
              <input
                value={b.isbn}
                onChange={(e) => set("isbn", e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                placeholder="978…"
                inputMode="numeric"
              />
              <button
                type="button"
                onClick={() => setScanOpen(true)}
                className="shrink-0 rounded-xl border border-slate-300 px-3 py-2 bg-white hover:bg-slate-50"
                title="カメラでスキャン"
              >
                📷
              </button>
            </div>
          </Field>
          <Field label="発行年">
            <input
              value={b.year}
              onChange={(e) => set("year", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="1997 / 2008 など"
            />
          </Field>
          <Field label="出版社・媒体">
            <input
              value={b.publisher}
              onChange={(e) => set("publisher", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </Field>
          <Field label="タグ（; 区切り）">
            <input
              value={Array.isArray(b.tags) ? b.tags.join(";") : b.tags}
              onChange={(e) => set("tags", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="社会学;理論;講義用"
            />
          </Field>
          <Field label="場所">
            <input
              value={b.location}
              onChange={(e) => set("location", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="研究室A-3 / 自宅B-2 など"
            />
          </Field>
          <Field label="状態">
            <select
              value={b.status}
              onChange={(e) => set("status", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white"
            >
              <option value="所蔵">所蔵</option>
              <option value="貸出中">貸出中</option>
            </select>
          </Field>
          <Field label="メモ" span>
            <textarea
              value={b.note}
              onChange={(e) => set("note", e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 min-h-[80px]"
            />
          </Field>
        </div>
        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2 bg-white hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="rounded-xl bg-indigo-600 text-white px-4 py-2 shadow hover:bg-indigo-700"
          >
            保存
          </button>
        </div>
      </form>

      {scanOpen && (
        <ScanDialog
          onClose={() => setScanOpen(false)}
          onDetected={(code) => {
            const cleaned = (code || "").replace(/[^0-9]/g, "");
            if (cleaned) set("isbn", cleaned);
            setScanOpen(false);
          }}
        />
      )}
    </dialog>
  );
}

function ScanDialog({
  onClose,
  onDetected,
}: {
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const ref = React.useRef<HTMLDialogElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    ref.current?.showModal();
    const reader = new BrowserMultiFormatReader();
    (async () => {
      try {
        await reader.decodeFromVideoDevice(null, videoRef.current!, (result, _e, controls) => {
          if (result) {
            const cleaned = result.getText().replace(/[^0-9]/g, "");
            if (cleaned) {
              controls.stop();
              stopStream();
              onDetected(cleaned);
            }
          }
        });
      } catch (e: any) {
        setErr("カメラ起動に失敗: " + (e?.message || String(e)));
      }
    })();
    return () => { stopStream(); };
  }, []);

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

function Field({ label, children, span = false }: any) {
  return (
    <label className={`flex flex-col gap-1 ${span ? "md:col-span-2" : ""}`}>
      <span className="text-sm text-slate-600">{label}</span>
      {children}
    </label>
  );
}
