/** Read-only OpenSearch probe. This is NOT a library-holdings verdict. */
import { env } from "node:process";

export const config = { maxDuration: 30 };
const ORIGIN = "https://lib.kuwasawa.ac.jp";
const LIMIT = 5;
const MAX_BYTES = 1_000_000;
const CACHE_MS = 600_000;
const validId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
class ProbeError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ProbeError(code, status); };

/** Preserve ISBN-10's X check digit; use an ISBN-13 cache/search key. */
export function normalizeIsbn(value) {
  if (typeof value !== "string" || value.length > 40) fail("INVALID_ISBN", 400);
  const s = value.normalize("NFKC").toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]/g, "");
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((n, c, i) => n + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11 !== 0) fail("INVALID_ISBN", 400);
    const head = `978${s.slice(0, 9)}`;
    const total = [...head].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
    return head + ((10 - total % 10) % 10);
  }
  if (!/^(978|979)\d{10}$/.test(s) || [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 !== 0) {
    fail("INVALID_ISBN", 400);
  }
  return s;
}

export function buildRequest(query = {}) {
  if (!object(query) || Object.keys(query).some(k => !["isbn", "scope", "bibid"].includes(k))) fail("INVALID_QUERY", 400);
  if ((query.isbn !== undefined) === (query.bibid !== undefined)) fail("ISBN_OR_BIBID_REQUIRED", 400);
  if (query.bibid !== undefined) {
    if (!validId(query.bibid) || query.scope !== undefined) fail("INVALID_BIBID", 400);
    const url = new URL("/opac/api/open_search_details/", ORIGIN);
    url.search = new URLSearchParams({ bibid: query.bibid, format: "json" });
    return { mode: "detail", bibid: query.bibid, url: url.href };
  }
  const isbn = normalizeIsbn(query.isbn);
  const scope = query.scope ?? "all";
  if (!["all", "zokei"].includes(scope)) fail("INVALID_SCOPE", 400);
  const url = new URL("/opac/api/open_search/", ORIGIN);
  url.search = new URLSearchParams({ isbn, format: "json", count: String(LIMIT), p: "1" });
  // Parameter is documented; this institution's actual value is NOT yet verified.
  if (scope === "zokei") url.searchParams.set("dpmc", "東京造形大学");
  return { mode: "search", isbn, scope, scopeVerified: false, url: url.href };
}

/** Never follow arbitrary URLs or remote JSON-LD @context documents. */
function bibidFromUrl(raw) {
  if (typeof raw !== "string") fail("OPAC_INVALID_LINK");
  let url;
  try { url = new URL(raw.replaceAll("&amp;", "&"), ORIGIN); } catch { fail("OPAC_INVALID_LINK"); }
  if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "lib.kuwasawa.ac.jp" || url.port || url.username || url.password) fail("OPAC_INVALID_LINK");
  const path = url.pathname;
  let id;
  if (["/opac/opac_details/", "/opac/api/open_search_details/"].includes(path)) {
    if (url.searchParams.getAll("bibid").length !== 1) fail("OPAC_INVALID_LINK");
    id = url.searchParams.get("bibid");
  } else {
    id = path.match(/^\/opac\/opac_link\/bibid\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1];
  }
  if (!validId(id)) fail("OPAC_INVALID_LINK");
  return id;
}
function recordId(item) {
  const urls = [item["rdfs:seeAlso"]?.["@id"], item.link?.["@id"], item["@id"]].filter(v => v !== undefined);
  const ids = new Set(urls.map(bibidFromUrl));
  if (ids.size !== 1) fail("OPAC_INVALID_LINK");
  return [...ids][0];
}
function links(bibid) {
  return { opacUrl: `${ORIGIN}/opac/opac_link/bibid/${encodeURIComponent(bibid)}`, detailApiUrl: buildRequest({ bibid }).url };
}
const text = (v) => typeof v === "string" ? v : object(v) && typeof v["@value"] === "string" ? v["@value"] : "";
function graphRoot(data) {
  if (!object(data) || !Array.isArray(data["@graph"]) || data["@graph"].length !== 1 || !object(data["@graph"][0])) fail("OPAC_UNEXPECTED_FORMAT");
  return data["@graph"][0];
}
export function parseSearch(data, isbn) {
  const channel = graphRoot(data);
  const total = channel["opensearch:totalResults"];
  if (channel["@type"] !== "channel" || !["number", "string"].includes(typeof total) || !/^\d+$/.test(String(total)) || !Number.isSafeInteger(Number(total))) fail("OPAC_UNEXPECTED_FORMAT");
  if (!object(channel.items) || channel.items["@type"] !== "rdf:Seq") fail("OPAC_UNEXPECTED_FORMAT");
  const rows = channel.items["rdf:li"] ?? [];
  if (!Array.isArray(rows) || rows.length > LIMIT || rows.length > Number(total) || (Number(total) > 0 && rows.length === 0)) fail("OPAC_UNEXPECTED_FORMAT");
  const candidates = rows.map(item => {
    if (!object(item)) fail("OPAC_UNEXPECTED_FORMAT");
    const bibid = recordId(item);
    const isbns = (Array.isArray(item["dcterms:hasPart"]) ? item["dcterms:hasPart"] : []).flatMap(part => {
      const raw = part?.["@id"];
      if (typeof raw !== "string" || !raw.startsWith("urn:isbn:")) return [];
      try { return [normalizeIsbn(raw.slice(9))]; } catch { return []; }
    });
    return { bibid, title: text(item.title), ...links(bibid), isbns, isbnMatched: isbns.includes(isbn) };
  });
  return {
    status: Number(total) ? "bibliography-found" : "not-found",
    holdingStatus: "unconfirmed", totalResults: Number(total),
    returnedCount: candidates.length, truncated: Number(total) > candidates.length, candidates,
  };
}
export function parseDetail(data, bibid) {
  const record = graphRoot(data);
  if (bibidFromUrl(record["@id"]) !== bibid) fail("OPAC_ID_MISMATCH");
  // Inspect returned fields rather than inventing a holdings field or verdict.
  return { status: "detail-received", holdingStatus: "unconfirmed", bibid, ...links(bibid), recordKeys: Object.keys(record), raw: data };
}

export async function fetchJson(url, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/ld+json, application/json;q=0.9", "User-Agent": "my-library-app-opensearch-probe/0.1" },
      signal: AbortSignal.timeout(12_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(response.status === 403 || response.status === 401 ? "OPAC_ACCESS_DENIED" : response.status === 429 ? "OPAC_RATE_LIMITED" : "OPAC_HTTP_ERROR");
    }
    if (!/\bapplication\/(?:ld\+)?json\b/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel(); fail("OPAC_NOT_JSON");
    }
    const reader = response.body?.getReader();
    if (!reader) fail("OPAC_EMPTY_RESPONSE");
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); fail("OPAC_RESPONSE_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("OPAC_INVALID_JSON"); }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (["TimeoutError", "AbortError"].includes(error?.name)) fail("OPAC_TIMEOUT", 504);
    if (["ENOTFOUND", "EAI_AGAIN"].includes(error?.cause?.code)) fail("OPAC_DNS_ERROR");
    fail("OPAC_CONNECTION_FAILED");
  }
}

/** Per-instance limits only: a preview probe, not a bulk lookup service. */
export function createHandler({ fetchImpl = globalThis.fetch, now = Date.now, environment = env.VERCEL_ENV } = {}) {
  const cache = new Map(); let busy = false; let nextAllowed = 0;
  return async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!["preview", "development"].includes(environment)) return response.status(403).json({ status: "disabled", error: "PREVIEW_ONLY", holdingStatus: "unconfirmed" });
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return response.status(405).json({ status: "unavailable", error: "METHOD_NOT_ALLOWED", holdingStatus: "unconfirmed" });
    }
    let query;
    try { query = buildRequest(request.query); }
    catch (e) { return response.status(e.status || 400).json({ status: "invalid-request", error: e.code || "INVALID_QUERY", holdingStatus: "unconfirmed" }); }
    const hit = cache.get(query.url);
    if (hit && now() - hit.at < CACHE_MS) return response.status(200).json({ ...hit.data, cached: true });
    if (busy || now() < nextAllowed) {
      response.setHeader("Retry-After", String(Math.max(2, Math.ceil((nextAllowed - now()) / 1000))));
      return response.status(429).json({ status: "unavailable", error: "PROBE_RATE_LIMITED", holdingStatus: "unconfirmed" });
    }
    busy = true;
    try {
      const data = await fetchJson(query.url, fetchImpl);
      const parsed = query.mode === "search" ? parseSearch(data, query.isbn) : parseDetail(data, query.bibid);
      const result = { ...parsed, query, checkedAt: new Date(now()).toISOString(), cached: false, diagnosticOnly: true };
      if (cache.size >= 50) cache.delete(cache.keys().next().value);
      cache.set(query.url, { at: now(), data: result });
      return response.status(200).json(result);
    } catch (e) {
      if (["OPAC_RATE_LIMITED", "OPAC_ACCESS_DENIED"].includes(e.code)) nextAllowed = now() + 60_000;
      return response.status(e.status || 502).json({ status: "unavailable", error: e.code || "OPAC_CONNECTION_FAILED", holdingStatus: "unconfirmed", query });
    } finally { busy = false; nextAllowed = Math.max(nextAllowed, now() + 2000); }
  };
}
export default createHandler();
