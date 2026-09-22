/* Cache refresh for the utility directory.
 *
 * GitHub Pages doesn't let a site set its own Cache-Control headers, so a browser (or the CDN in
 * front of Pages) can keep serving an old copy of a tool after a deploy. Adding a one-time
 * version stamp (?v=<timestamp>) to each same-site link makes every click request a URL that has
 * never been cached, so the latest file is always fetched.
 *
 * Loaded by index.html. Classic script in the browser (window.CacheBust); CommonJS in Node for the
 * unit tests in tools/tests/cachebust.test.js. No dependencies, no network calls of its own.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CacheBust = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PARAM = "v";

  // Base-36 timestamp: short, unique per millisecond, and sortable.
  function makeStamp(now) {
    return (typeof now === "number" ? now : Date.now()).toString(36);
  }

  // External (scheme or protocol-relative), in-page (#) and empty links are left alone.
  function isSameSiteRelative(href) {
    if (typeof href !== "string" || !href.trim()) return false;
    var h = href.trim();
    if (h.charAt(0) === "#") return false;
    if (/^\/\//.test(h)) return false;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(h)) return false;
    return true;
  }

  // Adds or replaces ?v=<stamp>, keeping any other query parameters and the #fragment.
  function withVersion(href, stamp) {
    if (!isSameSiteRelative(href)) return href;
    var hashAt = href.indexOf("#");
    var hash = hashAt === -1 ? "" : href.slice(hashAt);
    var beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
    var queryAt = beforeHash.indexOf("?");
    var path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
    var query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
    var kept = query.split("&").filter(function (part) {
      return part && part.split("=")[0] !== PARAM;
    });
    kept.push(PARAM + "=" + encodeURIComponent(stamp));
    return path + "?" + kept.join("&") + hash;
  }

  // Stamps every matching link. Returns how many links were changed.
  function applyToLinks(doc, stamp, selector) {
    var links = doc.querySelectorAll(selector || "a[href]");
    var changed = 0;
    for (var i = 0; i < links.length; i++) {
      var current = links[i].getAttribute("href");
      var next = withVersion(current, stamp);
      if (next !== current) {
        links[i].setAttribute("href", next);
        changed++;
      }
    }
    return changed;
  }

  // Stamps links now, and again whenever the page is restored from the back/forward cache,
  // so returning to the index and clicking again still gets a fresh URL.
  function install(doc, win, now) {
    var count = applyToLinks(doc, makeStamp(now ? now() : undefined));
    win.addEventListener("pageshow", function (evt) {
      if (evt && evt.persisted) applyToLinks(doc, makeStamp(now ? now() : undefined));
    });
    return count;
  }

  return {
    PARAM: PARAM,
    makeStamp: makeStamp,
    isSameSiteRelative: isSameSiteRelative,
    withVersion: withVersion,
    applyToLinks: applyToLinks,
    install: install
  };
});
