// Synthetic fixtures based on the supplied 2026-09-16 specification; NOT live OPAC data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIsbn, buildRequest, parseSearch, parseDetail, fetchJson, createHandler } from '../api/zokei-opensearch.js';
const ISBN = '9784533076930';
const BASE = 'https://lib.kuwasawa.ac.jp';
const item = (id = '1000176925') => ({
  '@id': `${BASE}/opac/opac_details/?lang=0&amode=11&bibid=${id}`, '@type': 'item', title: '仕様準拠のテスト書誌（実データではない）',
  'link': { '@id': `${BASE}/opac/opac_details/?lang=0&amode=11&bibid=${id}` },
  'rdfs:seeAlso': { '@id': `${BASE}/opac/api/open_search_details/?bibid=${id}&format=json` },
  'dcterms:hasPart': [{ '@id': `urn:isbn:${ISBN}` }],
});
const fixture = (total = 1, rows = [item()]) => ({ '@context': {}, '@graph': [{ '@type': 'channel', 'opensearch:totalResults': total, items: { '@type': 'rdf:Seq', 'rdf:li': rows } }] });
const response = (data = fixture(), status = 200, type = 'application/ld+json') => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': type } });
const request = (query = { isbn: ISBN }, method = 'GET') => ({ method, query });
const recorder = () => ({ headers: {}, statusCode: 0, body: null, setHeader(k,v) { this.headers[k] = v; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; } });

for (const [value, expected] of [[ISBN,ISBN], ['4-533-07693-9',ISBN], ['0-8044-2957-X','9780804429573'], ['９７８－４５３３０７６９３０',ISBN]]) {
  test(`ISBN normalizes ${value}`, () => assert.equal(normalizeIsbn(value), expected));
}
for (const bad of ['9784533076931', '1234567890128', '0804429571', 'ISBN:9784533076930', ['9784533076930'], 9784533076930, '', '9'.repeat(100)]) {
  test(`invalid ISBN rejected: ${JSON.stringify(bad)}`, () => assert.throws(() => normalizeIsbn(bad), { code: 'INVALID_ISBN' }));
}
test('unscoped query has a bounded first page and no institution assumption', () => {
  const q = buildRequest({ isbn: ISBN }); const u = new URL(q.url);
  assert.equal(u.searchParams.get('count'), '5'); assert.equal(u.searchParams.get('p'), '1'); assert.equal(u.searchParams.has('dpmc'), false); assert.equal(q.scopeVerified, false);
});
test('dpmc experiment is explicit and unverified', () => {
  const q = buildRequest({ isbn: ISBN, scope: 'zokei' }); assert.equal(new URL(q.url).searchParams.get('dpmc'), '東京造形大学'); assert.equal(q.scopeVerified, false);
});
test('ambiguous or arbitrary upstream queries rejected', () => {
  for (const q of [{}, { isbn: ISBN, bibid: '1' }, { bibid: '../secret' }, { isbn: ISBN, scope: ['all'] }, { isbn: ISBN, url: 'https://example.com' }]) assert.throws(() => buildRequest(q));
});
test('JSON-LD search returns a bibid and safe OPAC/detail links, never held', () => {
  const r = parseSearch(fixture(), ISBN); assert.equal(r.status,'bibliography-found'); assert.equal(r.holdingStatus,'unconfirmed'); assert.equal(r.candidates[0].bibid,'1000176925'); assert.equal(r.candidates[0].isbnMatched,true);
});
test('zero matches means not-found, not not-held', () => {
  const r = parseSearch(fixture('0',[]),ISBN); assert.equal(r.status,'not-found'); assert.equal(r.holdingStatus,'unconfirmed');
});
test('missing optional rdf:li is valid only for zero results', () => {
  const data = fixture(0,[]); delete data['@graph'][0].items['rdf:li']; assert.equal(parseSearch(data,ISBN).totalResults,0);
  data['@graph'][0]['opensearch:totalResults']=1; assert.throws(() => parseSearch(data,ISBN));
});
test('multiple candidates are retained and truncation is explicit', () => {
  const r = parseSearch(fixture(8,Array.from({length:5},(_,i)=>item(`BB${i}`))),ISBN); assert.equal(r.candidates.length,5); assert.equal(r.truncated,true);
});
test('missing/invalid result counts cannot silently become zero', () => {
  for (const n of [undefined,null,'',true,-1,1.5,'unavailable']) { const data=fixture(); data['@graph'][0]['opensearch:totalResults']=n; assert.throws(() => parseSearch(data,ISBN)); }
});
test('inconsistent or unrecognized result structures are errors', () => {
  for (const v of [{},fixture(0,[item()]),fixture(1,[]),fixture(6,Array.from({length:6},()=>item()))]) assert.throws(() => parseSearch(v,ISBN));
});
test('untrusted/credentialed links and conflicting bibids are rejected', () => {
  for (const link of ['https://example.com/opac/opac_details/?bibid=1','http://127.0.0.1/opac/opac_details/?bibid=1',`${BASE}:444/opac/opac_details/?bibid=1`,'javascript:alert(1)',`${BASE}/opac/opac_details/?bibid=another`,'https://a:b@lib.kuwasawa.ac.jp/opac/opac_details/?bibid=1']) {
    const row = item(); row['rdfs:seeAlso']['@id']=link; assert.throws(() => parseSearch(fixture(1,[row]),ISBN));
  }
});
test('http and escaped ampersands produce canonical https links', () => {
  const row = item(); delete row.link; delete row['rdfs:seeAlso']; row['@id']=row['@id'].replace('https:','http:').replaceAll('&','&amp;'); assert.ok(parseSearch(fixture(1,[row]),ISBN).candidates[0].opacUrl.startsWith('https:'));
});
test('detail returns fields for inspection, not guessed holdings', () => {
  const raw = {'@graph':[{'@id':item()['@id'],'dc:title':[{'@value':'テスト'}],'example:holding':'未検証'}]};
  const r = parseDetail(raw,'1000176925'); assert.equal(r.holdingStatus,'unconfirmed'); assert.ok(r.recordKeys.includes('example:holding')); assert.throws(()=>parseDetail(raw,'2'),{code:'OPAC_ID_MISMATCH'});
});
test('fetch requests JSON with a timeout and does not follow redirects', async () => {
  const r = await fetchJson(buildRequest({isbn:ISBN}).url,async (url,options)=> { assert.equal(new URL(url).hostname,'lib.kuwasawa.ac.jp'); assert.equal(options.redirect,'error'); assert.ok(options.signal); return response(); }); assert.deepEqual(r,fixture());
});
for (const [status,code] of [[403,'OPAC_ACCESS_DENIED'],[401,'OPAC_ACCESS_DENIED'],[429,'OPAC_RATE_LIMITED'],[503,'OPAC_HTTP_ERROR']]) {
  test(`HTTP ${status} is a failure, not zero matches`,async()=>assert.rejects(fetchJson(BASE,async()=>response({},status)),{code}));
}
test('HTML and malformed JSON rejected', async()=>{
  await assert.rejects(fetchJson(BASE,async()=>response('<html>blocked</html>',200,'text/html')),{code:'OPAC_NOT_JSON'});
  await assert.rejects(fetchJson(BASE,async()=>response('{broken')),{code:'OPAC_INVALID_JSON'});
});
test('response body size bounded',async()=>assert.rejects(fetchJson(BASE,async()=>response('x'.repeat(1_000_001))),{code:'OPAC_RESPONSE_TOO_LARGE'}));
test('network errors and timeouts stay distinguishable',async()=>{
  await assert.rejects(fetchJson(BASE,async()=>{throw new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}});}),{code:'OPAC_DNS_ERROR'});
  await assert.rejects(fetchJson(BASE,async()=>{throw new DOMException('timeout','TimeoutError');}),{code:'OPAC_TIMEOUT'});
});
test('production endpoint disabled without calling upstream',async()=>{
  const h=createHandler({environment:'production',fetchImpl:()=>assert.fail('network call')});const r=recorder();await h(request(),r);assert.equal(r.statusCode,403);assert.equal(r.body.error,'PREVIEW_ONLY');
});
test('invalid requests and non-GET do not call upstream',async()=>{
  const h=createHandler({environment:'preview',fetchImpl:()=>assert.fail('network call')});for(const q of [request({isbn:'bad'}),request(undefined,'POST')]) {const r=recorder();await h(q,r);assert.ok([400,405].includes(r.statusCode));}
});
test('validated responses cached per key, scope kept separate',async()=>{
  let calls=0,clock=100_000;const h=createHandler({environment:'preview',now:()=>clock,fetchImpl:async()=>{calls++;return response();}});
  const a=recorder(),b=recorder();await h(request(),a);await h(request(),b);assert.equal(calls,1);assert.equal(b.body.cached,true);assert.equal(a.body.checkedAt,b.body.checkedAt);
  const c=recorder();await h(request({isbn:ISBN,scope:'zokei'}),c);assert.equal(c.statusCode,429);clock+=3000;await h(request({isbn:ISBN,scope:'zokei'}),recorder());assert.equal(calls,2);
});
test('errors not cached as not-found and retries are not automatic',async()=>{
  let calls=0,clock=100_000;const h=createHandler({environment:'preview',now:()=>clock,fetchImpl:async()=>{calls++;return calls===1?response({},503):response();}});
  const a=recorder();await h(request(),a);assert.equal(calls,1);assert.equal(a.body.status,'unavailable');clock+=3000;const b=recorder();await h(request(),b);assert.equal(calls,2);assert.equal(b.body.status,'bibliography-found');
});
test('simultaneous requests cannot fan out within one instance',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});let calls=0;
  const h=createHandler({environment:'preview',fetchImpl:async()=>{calls++;return pending;}});const a=recorder();const work=h(request(),a);const b=recorder();await h(request(),b);assert.equal(b.statusCode,429);assert.equal(calls,1);resolve(response());await work;
});
test('access denials trigger a cooldown and never cookie/header bypass',async()=>{
  let calls=0,clock=100_000;const h=createHandler({environment:'preview',now:()=>clock,fetchImpl:async(_u,o)=>{calls++;assert.equal(o.headers.Cookie,undefined);assert.equal(o.headers.Referer,undefined);return response({},403);}});
  await h(request(),recorder());clock+=3000;const b=recorder();await h(request(),b);assert.equal(b.statusCode,429);assert.equal(calls,1);assert.ok(Number(b.headers['Retry-After'])>=57);
});

test('unknown environment is disabled by default',async()=>{const h=createHandler({environment:'unknown',fetchImpl:()=>assert.fail('network call')});const r=recorder();await h(request(),r);assert.equal(r.statusCode,403);});
