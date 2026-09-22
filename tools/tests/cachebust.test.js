// Unit tests for tools/cachebust.js — Node's built-in test runner, no dependencies.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../cachebust.js");

test("makeStamp: base-36 of the given time, or of now", () => {
  assert.equal(C.makeStamp(0), "0");
  assert.equal(C.makeStamp(36), "10");
  const before = Date.now();
  const s = parseInt(C.makeStamp(), 36);
  assert.ok(s >= before && s <= Date.now());
});

test("isSameSiteRelative: only same-site relative links qualify", () => {
  for (const ok of ["tools/peakwatch.html", "./a.html", "../index.html", "/tools/x.html", "a.html?mode=hdb"]) assert.equal(C.isSameSiteRelative(ok), true, ok);
  for (const no of ["", "  ", "#top", "//cdn.example/x.js", "https://example.com", "http://x", "mailto:a@b.c", "tel:123", "javascript:alert(1)", null, undefined, 42]) assert.equal(C.isSameSiteRelative(no), false, String(no));
});

test("withVersion: adds a stamp to a plain link", () => {
  assert.equal(C.withVersion("tools/peakwatch.html", "abc"), "tools/peakwatch.html?v=abc");
});

test("withVersion: keeps existing parameters and the fragment", () => {
  assert.equal(C.withVersion("tools/resalewatch.html?mode=hdb", "abc"), "tools/resalewatch.html?mode=hdb&v=abc");
  assert.equal(C.withVersion("a.html?x=1&y=2#sec", "abc"), "a.html?x=1&y=2&v=abc#sec");
  assert.equal(C.withVersion("a.html#sec", "abc"), "a.html?v=abc#sec");
});

test("withVersion: replaces an old stamp instead of adding a second one", () => {
  assert.equal(C.withVersion("a.html?v=old&mode=private", "new"), "a.html?mode=private&v=new");
  assert.equal(C.withVersion("a.html?v", "new"), "a.html?v=new");
  assert.equal(C.withVersion("a.html?&&mode=1&", "n"), "a.html?mode=1&v=n");
  assert.equal(C.withVersion("a.html?view=1", "n"), "a.html?view=1&v=n", "a parameter merely starting with v is kept");
});

test("withVersion: encodes the stamp and leaves non-qualifying links untouched", () => {
  assert.equal(C.withVersion("a.html", "a b&c"), "a.html?v=a%20b%26c");
  for (const h of ["https://example.com/x", "#top", "mailto:a@b.c", "", null]) assert.equal(C.withVersion(h, "s"), h);
});

function fakeDoc(hrefs) {
  const links = hrefs.map((href) => ({ href, getAttribute() { return this.href; }, setAttribute(_n, v) { this.href = v; } }));
  return { links, lastSelector: null, querySelectorAll(sel) { this.lastSelector = sel; return links; } };
}

test("applyToLinks: stamps qualifying links, counts changes, uses the default selector", () => {
  const doc = fakeDoc(["tools/a.html", "https://ext.example", "tools/b.html?mode=x", "#top"]);
  assert.equal(C.applyToLinks(doc, "s1"), 2);
  assert.equal(doc.lastSelector, "a[href]");
  assert.deepEqual(doc.links.map((l) => l.href), ["tools/a.html?v=s1", "https://ext.example", "tools/b.html?mode=x&v=s1", "#top"]);
  assert.equal(C.applyToLinks(doc, "s1", "a.space"), 0, "same stamp again changes nothing");
  assert.equal(doc.lastSelector, "a.space");
});

test("install: stamps now, and re-stamps only on back/forward-cache restores", () => {
  const doc = fakeDoc(["tools/a.html"]);
  const handlers = {};
  const win = { addEventListener(type, fn) { handlers[type] = fn; } };
  let t = 36;
  assert.equal(C.install(doc, win, () => t), 1);
  assert.equal(doc.links[0].href, "tools/a.html?v=10");
  t = 72;
  handlers.pageshow({ persisted: false });
  assert.equal(doc.links[0].href, "tools/a.html?v=10", "normal load: no re-stamp");
  handlers.pageshow(undefined);
  assert.equal(doc.links[0].href, "tools/a.html?v=10");
  handlers.pageshow({ persisted: true });
  assert.equal(doc.links[0].href, "tools/a.html?v=20", "restored from bfcache: fresh stamp");
});

test("install: uses the real clock when no clock is passed", () => {
  const doc = fakeDoc(["tools/a.html"]);
  const handlers = {};
  C.install(doc, { addEventListener(t, fn) { handlers[t] = fn; } });
  assert.match(doc.links[0].href, /^tools\/a\.html\?v=[0-9a-z]+$/);
  handlers.pageshow({ persisted: true });
  assert.match(doc.links[0].href, /^tools\/a\.html\?v=[0-9a-z]+$/);
});

test("browser build exposes window.CacheBust", () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "cachebust.js"), "utf8"), sandbox);
  assert.equal(typeof sandbox.self.CacheBust.install, "function");
});
