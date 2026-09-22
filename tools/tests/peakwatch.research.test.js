// Unit tests for tools/peakwatch.research.js — Node's built-in test runner, no dependencies.
// Run from the repo root:  node --test --experimental-test-coverage tools/tests/peakwatch.research.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../peakwatch.research.js");

/* ---------- helpers ---------- */
const G = (id, syms) => ({ id, title: id, promptLabel: id + " label", companies: syms.map(s => ({ key: s.toLowerCase(), symbol: s, company: s + " Inc" })) });
const MAG = G("mag7", ["AAPL", "MSFT"]);
const SEMI = G("semi", ["AMD", "MU"]);
const entry = (t) => ({ pe: 30.1, fwdPe: 25.2, peg: "1.1", pb: "~5x", roic: "~20%", fcf: "$1B", earningsGrowth: "EG " + t, peHistory: "PEH " + t, pullbackNote: "PB " + t, outlookNote: "OL " + t });
const groupRes = (g, n) => ({ pullbackOverall: "po", outlookOverall: "oo", companies: Object.fromEntries(g.companies.slice(0, n === undefined ? g.companies.length : n).map(c => [c.symbol, entry(c.symbol)])) });
const jsonRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) });
const geminiOk = (text, extra) => jsonRes(200, { candidates: [Object.assign({ content: { parts: [{ text }] }, finishReason: "STOP" }, extra || {})] });

/* ---------- fetchJsonDirect / Twelve Data ---------- */
test("fetchJsonDirect returns parsed JSON on success and calls only the given URL", async () => {
  const seen = [];
  const out = await R.fetchJsonDirect("https://api.twelvedata.com/quote?x=1", "Twelve Data", async (u) => { seen.push(u); return jsonRes(200, { a: 1 }); });
  assert.deepEqual(out, { a: 1 });
  assert.deepEqual(seen, ["https://api.twelvedata.com/quote?x=1"]);
});

test("fetchJsonDirect never retries through a proxy when the network call throws", async () => {
  const seen = [];
  await assert.rejects(
    R.fetchJsonDirect("https://api.twelvedata.com/quote", "Twelve Data", async (u) => { seen.push(u); throw new Error("Failed to fetch"); }),
    (e) => e.kind === "network" && /never retries through a third-party proxy/.test(e.message)
  );
  assert.equal(seen.length, 1, "exactly one request, no proxy fallback");
});

test("fetchJsonDirect surfaces HTTP errors with status and body", async () => {
  await assert.rejects(R.fetchJsonDirect("u", "X", async () => jsonRes(500, "boom")), (e) => e.status === 500 && /HTTP 500 — boom/.test(e.message));
  // body read failure is tolerated
  await assert.rejects(R.fetchJsonDirect("u", "X", async () => ({ ok: false, status: 502, text: async () => { throw new Error("x"); } })), (e) => e.message === "HTTP 502");
});

test("fetchJsonDirect uses global fetch when no implementation is passed", async () => {
  const orig = global.fetch;
  global.fetch = async () => jsonRes(200, { g: true });
  try { assert.deepEqual(await R.fetchJsonDirect("u", "X"), { g: true }); } finally { global.fetch = orig; }
});

test("buildQuoteUrl targets Twelve Data only and encodes inputs", () => {
  const u = R.buildQuoteUrl("BRK.B", "k&y");
  assert.equal(u, "https://api.twelvedata.com/quote?symbol=BRK.B&apikey=k%26y");
});

test("parseTwelveDataQuote handles success, provider errors and malformed data", () => {
  assert.deepEqual(R.parseTwelveDataQuote({ close: "90", percent_change: "-1.5", fifty_two_week: { high: "100" } }, "X"), { price: 90, changePct: -1.5, athValue: 100 });
  assert.equal(R.parseTwelveDataQuote({ close: "90", percent_change: "n/a", fifty_two_week: { high: "100" } }, "X").changePct, 0);
  assert.throws(() => R.parseTwelveDataQuote({ status: "error", message: "bad symbol" }, "X"), /bad symbol/);
  assert.throws(() => R.parseTwelveDataQuote({ status: "error" }, "X"), /returned an error for X/);
  assert.throws(() => R.parseTwelveDataQuote(null, "X"), /No quote returned/);
  assert.throws(() => R.parseTwelveDataQuote({ close: "90" }, "X"), /Couldn't parse/);
});

test("fetchQuoteWithHigh maps 401 / apikey errors to a clear message and passes others through", async () => {
  const q = await R.fetchQuoteWithHigh("AAPL", "k", async () => jsonRes(200, { close: "1", percent_change: "0", fifty_two_week: { high: "2" } }));
  assert.equal(q.athValue, 2);
  await assert.rejects(R.fetchQuoteWithHigh("AAPL", "k", async () => jsonRes(401, "nope")), /isn't valid for Twelve Data/);
  await assert.rejects(R.fetchQuoteWithHigh("AAPL", "k", async () => jsonRes(400, "invalid apikey")), /isn't valid for Twelve Data/);
  await assert.rejects(R.fetchQuoteWithHigh("AAPL", "k", async () => jsonRes(500, "down")), /HTTP 500/);
});

/* ---------- prompt / parsing ---------- */
test("buildResearchPrompt includes date, every group id and ticker, and the JSON shape", () => {
  const p = R.buildResearchPrompt([MAG, SEMI], "September 22, 2026");
  assert.match(p, /Today is September 22, 2026/);
  for (const s of ["mag7", "semi", "AAPL Inc (AAPL)", "MU Inc (MU)", "pullbackNote", "outlookNote", "peHistory", "earningsGrowth", "fwdPe"]) assert.ok(p.includes(s), s);
  assert.match(R.buildResearchPrompt([MAG]), /Today is \w+ \d+, \d{4}/); // default date path
});

test("todayLabel formats a given date", () => {
  assert.equal(R.todayLabel(new Date(2026, 8, 22)), "September 22, 2026");
});

test("parseRetryDelay extracts seconds or returns null", () => {
  assert.equal(R.parseRetryDelay('{"retryDelay": "42s"}'), "42");
  assert.equal(R.parseRetryDelay("nothing"), null);
  assert.equal(R.parseRetryDelay(undefined), null);
});

test("extractJsonObject tolerates fences, prose and trailing commas", () => {
  assert.deepEqual(R.extractJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(R.extractJsonObject("Here you go: {\"a\":[1,2,],} thanks"), { a: [1, 2] });
});

test("extractJsonObject rejects empty, missing and broken JSON with kind=parse", () => {
  for (const bad of ["", "   ", null, "no braces here", "} {", "{\"a\": }"]) {
    assert.throws(() => R.extractJsonObject(bad), (e) => e.kind === "parse", String(bad));
  }
});

test("extractSources keeps only https links, dedupes, defaults titles and caps the count", () => {
  const chunks = [
    { web: { uri: "https://a.example", title: " A " } },
    { web: { uri: "https://a.example", title: "A" } },            // duplicate
    { web: { uri: "javascript:alert(1)", title: "EVIL" } },       // rejected
    { web: { uri: "http://insecure.example", title: "HTTP" } },   // rejected
    { web: { uri: "https://b.example" } },                         // default title
    { web: { uri: 42 } }, {}, null
  ];
  assert.deepEqual(R.extractSources({ groundingMetadata: { groundingChunks: chunks } }), [
    { uri: "https://a.example", title: "A" }, { uri: "https://b.example", title: "Source" }
  ]);
  const many = Array.from({ length: 20 }, (_, i) => ({ web: { uri: "https://x" + i + ".example", title: "t" + i } }));
  assert.equal(R.extractSources({ groundingMetadata: { groundingChunks: many } }).length, R.MAX_SOURCES);
  assert.deepEqual(R.extractSources(undefined), []);
  assert.deepEqual(R.extractSources({ groundingMetadata: { groundingChunks: "nope" } }), []);
});

test("classifyGeminiHttpError maps statuses to kinds", () => {
  assert.equal(R.classifyGeminiHttpError(404, '{"error":{"message":"not found"}}', "m").kind, "model");
  assert.equal(R.classifyGeminiHttpError(400, "model is not supported", "m").kind, "model");
  assert.equal(R.classifyGeminiHttpError(400, "bad", "m").kind, "auth");
  assert.equal(R.classifyGeminiHttpError(403, "", "m").kind, "auth");
  const rate = R.classifyGeminiHttpError(429, '{"retryDelay":"30s"}', "m");
  assert.equal(rate.kind, "rate"); assert.match(rate.message, /retry in 30s/);
  assert.match(R.classifyGeminiHttpError(429, "", "m").message, /wait a minute/);
  assert.equal(R.classifyGeminiHttpError(503, "", "m").kind, "server");
  assert.equal(R.classifyGeminiHttpError(418, "teapot", "m").kind, "http");
  assert.match(R.classifyGeminiHttpError(500, '{"error":{"message":"Internal"}}', "m").message, /Internal/);
});

test("buildGeminiRequest caps thinking only on 2.5 Flash models and always enables search", () => {
  const a = R.buildGeminiRequest("gemini-2.5-flash", "p");
  assert.deepEqual(a.generationConfig, { maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 2048 } });
  assert.deepEqual(a.tools, [{ google_search: {} }]);
  assert.equal(R.buildGeminiRequest("gemini-3.5-flash", "p").generationConfig.thinkingConfig, undefined);
});

/* ---------- callGemini ---------- */
test("callGemini sends the key in a header (not the URL) to Google only", async () => {
  let seenUrl, seenInit;
  const out = await R.callGemini("SECRET", "gemini-2.5-flash", "p", async (u, init) => { seenUrl = u; seenInit = init; return geminiOk("{}", { groundingMetadata: { groundingChunks: [{ web: { uri: "https://s.example", title: "S" } }] } }); });
  assert.match(seenUrl, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.ok(!seenUrl.includes("SECRET"));
  assert.equal(seenInit.headers["x-goog-api-key"], "SECRET");
  assert.equal(out.text, "{}"); assert.equal(out.finishReason, "STOP"); assert.equal(out.sources.length, 1);
});

test("callGemini handles network failure, HTTP errors, blocks and odd payloads", async () => {
  await assert.rejects(R.callGemini("k", "m", "p", async () => { throw new Error("offline"); }), (e) => e.kind === "network");
  await assert.rejects(R.callGemini("k", "m", "p", async () => jsonRes(429, "{}")), (e) => e.kind === "rate");
  await assert.rejects(R.callGemini("k", "m", "p", async () => ({ ok: false, status: 500, text: async () => { throw new Error("x"); } })), (e) => e.kind === "server");
  await assert.rejects(R.callGemini("k", "m", "p", async () => jsonRes(200, { promptFeedback: { blockReason: "SAFETY" } })), (e) => e.kind === "blocked");
  const empty = await R.callGemini("k", "m", "p", async () => jsonRes(200, {}));
  assert.equal(empty.text, ""); assert.deepEqual(empty.sources, []);
  const noParts = await R.callGemini("k", "m", "p", async () => jsonRes(200, { candidates: [{ content: {} }] }));
  assert.equal(noParts.text, "");
  const nullPart = await R.callGemini("k", "m", "p", async () => jsonRes(200, { candidates: [{ content: { parts: [null, { text: "a" }] } }] }));
  assert.equal(nullPart.text, "\na");
});

test("callGemini uses global fetch when none is passed", async () => {
  const orig = global.fetch;
  global.fetch = async () => geminiOk("hi");
  try { assert.equal((await R.callGemini("k", "m", "p")).text, "hi"); } finally { global.fetch = orig; }
});

/* ---------- createResearcher ---------- */
test("researchGroups parses a good response and reports model + sources", async () => {
  const r = R.createResearcher({ fetchImpl: async () => geminiOk(JSON.stringify({ asOf: "Sep 22", groups: { mag7: groupRes(MAG) } })), today: "T" });
  const out = await r.researchGroups("k", [MAG]);
  assert.equal(out.asOf, "Sep 22"); assert.equal(out.model, R.GEMINI_MODEL); assert.ok(out.groups.mag7);
  assert.equal(r.getModel(), R.GEMINI_MODEL);
});

test("researchGroups falls back once to the fallback model on 'model' errors and remembers it", async () => {
  const urls = [];
  const r = R.createResearcher({ fetchImpl: async (u) => { urls.push(u); return urls.length === 1 ? jsonRes(404, "not found") : geminiOk('{"groups":{}}'); } });
  const out = await r.researchGroups("k", [MAG]);
  assert.equal(out.model, R.GEMINI_FALLBACK_MODEL); assert.equal(out.asOf, null);
  assert.match(urls[1], /gemini-3\.5-flash/);
  await r.researchGroups("k", [MAG]);
  assert.match(urls[2], /gemini-3\.5-flash/, "fallback sticks");
});

test("researchGroups does not loop when the fallback model is also unavailable, and rethrows other errors", async () => {
  const r = R.createResearcher({ model: "x", fallbackModel: "x", fetchImpl: async () => jsonRes(404, "not found") });
  await assert.rejects(r.researchGroups("k", [MAG]), (e) => e.kind === "model");
  const r2 = R.createResearcher({ fetchImpl: async () => jsonRes(401, "bad key") });
  await assert.rejects(r2.researchGroups("k", [MAG]), (e) => e.kind === "auth");
});

test("researchGroups maps MAX_TOKENS to truncated, bad JSON to parse, and missing groups to parse", async () => {
  const logs = [];
  const trunc = R.createResearcher({ log: (m) => logs.push(m), fetchImpl: async () => geminiOk('{"groups":{"mag7":', { finishReason: "MAX_TOKENS" }) });
  await assert.rejects(trunc.researchGroups("k", [MAG]), (e) => e.kind === "truncated");
  assert.equal(logs.length, 1);
  const bad = R.createResearcher({ fetchImpl: async () => geminiOk("not json") });
  await assert.rejects(bad.researchGroups("k", [MAG]), (e) => e.kind === "parse");
  const noGroups = R.createResearcher({ fetchImpl: async () => geminiOk('{"asOf":"x"}') });
  await assert.rejects(noGroups.researchGroups("k", [MAG]), /didn't include group data/);
  const nullGroups = R.createResearcher({ fetchImpl: async () => geminiOk('{"groups":null}') });
  await assert.rejects(nullGroups.researchGroups("k", [MAG]), (e) => e.kind === "parse");
  const noOpts = R.createResearcher();
  assert.equal(noOpts.getModel(), R.GEMINI_MODEL);
});

/* ---------- merging ---------- */
test("groupIsUsable requires at least half the tickers", () => {
  assert.equal(R.groupIsUsable(MAG, groupRes(MAG)), true);
  assert.equal(R.groupIsUsable(MAG, groupRes(MAG, 1)), true);   // 1 of 2 = half
  assert.equal(R.groupIsUsable(SEMI, groupRes(SEMI, 0)), false);
  assert.equal(R.groupIsUsable(MAG, null), false);
  assert.equal(R.groupIsUsable(MAG, { companies: null }), false);
  assert.equal(R.groupIsUsable(MAG, { companies: "x" }), false);
});

test("cleanResearchValue type-checks, trims, drops placeholders and caps length", () => {
  assert.equal(R.cleanResearchValue(12.5), 12.5);
  assert.equal(R.cleanResearchValue(Infinity), null);
  assert.equal(R.cleanResearchValue(NaN), null);
  assert.equal(R.cleanResearchValue("  hi  "), "hi");
  for (const v of ["", "   ", "...", "…", null, undefined, {}, ["a"], true]) assert.equal(R.cleanResearchValue(v), null);
  const long = R.cleanResearchValue("x".repeat(2000));
  assert.equal(long.length, R.MAX_FIELD_CHARS); assert.ok(long.endsWith("…"));
  assert.equal(R.cleanResearchValue("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "kept as plain text; React renders it escaped");
});

const SNAP = { asOf: "Sep 21", metricsAsOf: "Sep 18 close", groups: { mag7: { pullbackOverall: "spo", outlookOverall: "soo", data: { AAPL: { pe: 38.6, peHistory: "snap AAPL" }, MSFT: { pe: 27.5, peHistory: "snap MSFT" } } } } };

test("snapshotGroupState marks every row as not-live and copies group text", () => {
  const s = R.snapshotGroupState(SNAP, "mag7");
  assert.equal(s.source, "snapshot"); assert.equal(s.metricsAsOf, "Sep 18 close");
  assert.equal(s.companies.AAPL.live, false); assert.equal(s.pullbackOverall, "spo");
  assert.notEqual(s.companies.AAPL, SNAP.groups.mag7.data.AAPL, "copies, doesn't alias snapshot data");
});

test("mergeLiveGroup overlays returned fields, keeps snapshot values for gaps, and tags live rows", () => {
  const prev = R.snapshotGroupState(SNAP, "mag7");
  const gr = { pullbackOverall: "  ", companies: { AAPL: { pe: 40.1, peHistory: "", pullbackNote: "live PB", junk: "ignored" }, MSFT: "not-an-object" } };
  const m = R.mergeLiveGroup(prev, MAG, gr, { asOf: "Sep 22", sources: [{ uri: "https://s", title: "s" }], model: "gm" });
  assert.equal(m.source, "live"); assert.equal(m.asOf, "Sep 22"); assert.equal(m.model, "gm"); assert.equal(m.sources.length, 1);
  assert.equal(m.companies.AAPL.pe, 40.1); assert.equal(m.companies.AAPL.peHistory, "snap AAPL"); assert.equal(m.companies.AAPL.pullbackNote, "live PB");
  assert.equal(m.companies.AAPL.junk, undefined); assert.equal(m.companies.AAPL.live, true);
  assert.equal(m.companies.MSFT.live, false, "row not returned stays on snapshot");
  assert.equal(m.pullbackOverall, "spo"); assert.equal(m.outlookOverall, "soo");
  assert.equal(prev.companies.AAPL.pe, 38.6, "does not mutate previous state");
});

test("mergeLiveGroup handles new tickers and missing meta", () => {
  const prev = { companies: {}, pullbackOverall: "a", outlookOverall: "b" };
  const m = R.mergeLiveGroup(prev, MAG, { outlookOverall: "new oo", companies: { AAPL: entry("AAPL") } }, {}, "Today");
  assert.equal(m.asOf, "Today"); assert.deepEqual(m.sources, []); assert.equal(m.model, null);
  assert.equal(m.outlookOverall, "new oo"); assert.equal(m.companies.AAPL.earningsGrowth, "EG AAPL");
  assert.match(R.mergeLiveGroup(prev, MAG, { companies: {} }, {}).asOf, /\d{4}/);
});

/* ---------- refresh orchestration ---------- */
function harness(responses) {
  const calls = [], results = [], statuses = [];
  let i = 0;
  const researchGroups = async (key, groups) => {
    calls.push(groups.map(g => g.id));
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    calls, results, statuses,
    run: () => R.runResearchRefresh({ apiKey: "k", groups: [MAG, SEMI], researchGroups, onGroupResult: (g) => results.push(g.id), onGroupStatus: (ids, s) => statuses.push([ids, s]) })
  };
}
const err = (kind) => Object.assign(new Error("E-" + kind), { kind });

test("refresh: one call when the combined response covers every table", async () => {
  const h = harness([{ groups: { mag7: groupRes(MAG), semi: groupRes(SEMI) } }]);
  const out = await h.run();
  assert.deepEqual(out, { calls: 1, stoppedOn: null });
  assert.deepEqual(h.results, ["mag7", "semi"]);
});

test("refresh: retries only the missing table", async () => {
  const h = harness([{ groups: { mag7: groupRes(MAG) } }, { groups: { semi: groupRes(SEMI) } }]);
  const out = await h.run();
  assert.equal(out.calls, 2); assert.deepEqual(h.calls, [["mag7", "semi"], ["semi"]]);
  assert.deepEqual(h.results, ["mag7", "semi"]);
  assert.match(h.statuses.at(-1)[1].notice, /follow-up call/);
});

test("refresh: a still-unusable retry keeps previous values with an error", async () => {
  const h = harness([{ groups: {} }, { groups: {} }, { groups: { semi: groupRes(SEMI) } }]);
  await h.run();
  assert.deepEqual(h.results, ["semi"]);
  assert.match(h.statuses.find(s => s[0][0] === "mag7")[1].error, /didn't return usable data/);
});

test("refresh: truncated/parse combined replies retry every table", async () => {
  for (const kind of ["truncated", "parse"]) {
    const h = harness([err(kind), { groups: { mag7: groupRes(MAG) } }, { groups: { semi: groupRes(SEMI) } }]);
    const out = await h.run();
    assert.equal(out.calls, 3, kind); assert.deepEqual(h.results, ["mag7", "semi"]);
  }
});

test("refresh: key / rate / network errors on the combined call stop immediately", async () => {
  for (const kind of ["auth", "rate", "network", "server", "model"]) {
    const h = harness([err(kind)]);
    const out = await h.run();
    assert.deepEqual(out, { calls: 1, stoppedOn: kind });
    assert.deepEqual(h.statuses[0][0], ["mag7", "semi"]);
  }
});

test("refresh: a rate limit during retries stops the remaining retries", async () => {
  const h = harness([err("truncated"), err("rate")]);
  const out = await h.run();
  assert.deepEqual(out, { calls: 2, stoppedOn: "rate" });
  assert.deepEqual(h.statuses.at(-1)[0], ["mag7", "semi"]);
});

test("refresh: other retry errors are reported per table and the loop continues", async () => {
  const h = harness([err("parse"), err("server"), { groups: { semi: groupRes(SEMI) } }]);
  const out = await h.run();
  assert.deepEqual(out, { calls: 3, stoppedOn: null });
  assert.match(h.statuses.find(s => s[0][0] === "mag7")[1].error, /E-server Showing the previous values/);
  assert.deepEqual(h.results, ["semi"]);
});

/* ---------- display helpers ---------- */
test("formatPe", () => {
  assert.equal(R.formatPe(38.567), "38.6");
  assert.equal(R.formatPe("n/m"), "n/m");
  for (const v of [null, undefined, ""]) assert.equal(R.formatPe(v), null);
});

test("drawdownFor", () => {
  assert.equal(R.drawdownFor({ quote: { price: 90, athValue: 100 } }), -10);
  for (const s of [null, {}, { quote: null }, { quote: { price: NaN, athValue: 100 } }, { quote: { price: 1, athValue: 0 } }, { quote: { price: 1, athValue: Infinity } }]) assert.equal(R.drawdownFor(s), null);
});

test("browser build exposes the API on the global object", () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "peakwatch.research.js"), "utf8");
  const sandbox = { self: {} };
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.self.PeakWatchResearch.runResearchRefresh, "function");
});
