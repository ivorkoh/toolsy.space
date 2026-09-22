/* PeakWatch research + data-access logic.
 *
 * Kept free of React and the DOM so every branch can be unit-tested in Node
 * (tools/tests/peakwatch.research.test.js). Loaded in the browser as a classic
 * script that exposes window.PeakWatchResearch; in Node it's a CommonJS module.
 *
 * Security rules this file enforces:
 *  - API keys only ever go to their own provider (Twelve Data, Google Gemini).
 *    There is NO third-party proxy fallback — if a direct call fails, it fails
 *    with a clear message instead of silently routing the key through someone
 *    else's server.
 *  - Model-supplied text is treated as data: values are type-checked and length
 *    capped, and only https:// source links survive.
 *
 * Gemini notes (checked against Google's docs, Sep 2026):
 *  - generationConfig.thinkingConfig.thinkingBudget is valid on gemini-2.5-flash
 *    (range 0–24576), and thinking tokens count against maxOutputTokens.
 *  - responseSchema is not reliably usable together with the google_search tool
 *    on 2.5 models, so JSON is requested in the prompt and parsed tolerantly.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.PeakWatchResearch = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  var TWELVE_DATA_QUOTE = "https://api.twelvedata.com/quote";
  var GEMINI_MODEL = "gemini-2.5-flash";
  // Only tried if the primary model answers "not found". Listed on Google's deprecations page
  // with no shutdown date as of Sep 2026; free-tier availability is NOT verified.
  var GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";
  var METRIC_FIELDS = ["pe", "fwdPe", "peg", "pb", "roic", "fcf"];
  var NOTE_FIELDS = ["earningsGrowth", "peHistory", "pullbackNote", "outlookNote"];
  var MAX_FIELD_CHARS = 700;
  var MAX_SOURCES = 12;

  function ResearchError(message, kind) {
    var err = new Error(message);
    err.name = "ResearchError";
    err.kind = kind;
    return err;
  }

  function todayLabel(date) {
    return (date || new Date()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  /* ---------------- Direct fetch (no proxy, ever) ---------------- */

  // `providerName` is only used in messages. A thrown fetch() means the browser couldn't reach
  // the provider at all (offline, DNS, or a CORS block) — we say so and stop.
  async function fetchJsonDirect(url, providerName, fetchImpl, init) {
    var doFetch = fetchImpl || fetch;
    var res;
    try {
      res = await doFetch(url, init);
    } catch (networkErr) {
      throw ResearchError(
        "Couldn't reach " + providerName + " (" + networkErr.message + "). This is usually a network problem or the browser " +
        "blocking a cross-origin request. For your key's safety, PeakWatch never retries through a third-party proxy.",
        "network"
      );
    }
    if (!res.ok) {
      var body = "";
      try { body = await res.text(); } catch (_e) { body = ""; }
      var err = ResearchError("HTTP " + res.status + (body ? " — " + body.slice(0, 220) : ""), "http");
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* ---------------- Twelve Data ---------------- */

  function buildQuoteUrl(symbol, apiKey) {
    return TWELVE_DATA_QUOTE + "?symbol=" + encodeURIComponent(symbol) + "&apikey=" + encodeURIComponent(apiKey);
  }

  // One /quote call returns price, today's change and the trailing 52-week high.
  function parseTwelveDataQuote(data, symbol) {
    if (data && data.status === "error") {
      throw new Error(data.message || ("Twelve Data returned an error for " + symbol + "."));
    }
    if (!data || data.close === undefined) {
      throw new Error("No quote returned for " + symbol + ".");
    }
    var price = parseFloat(data.close);
    var changePct = parseFloat(data.percent_change);
    var athValue = data.fifty_two_week ? parseFloat(data.fifty_two_week.high) : NaN;
    if (isNaN(price) || isNaN(athValue)) {
      throw new Error("Couldn't parse price/52-week-high for " + symbol + " from the response.");
    }
    return { price: price, changePct: isNaN(changePct) ? 0 : changePct, athValue: athValue };
  }

  async function fetchQuoteWithHigh(symbol, apiKey, fetchImpl) {
    var data;
    try {
      data = await fetchJsonDirect(buildQuoteUrl(symbol, apiKey), "Twelve Data", fetchImpl);
    } catch (e) {
      if (e.status === 401 || /apikey/i.test(e.message)) {
        throw new Error("This API key isn't valid for Twelve Data — it needs to be a Twelve Data key (twelvedata.com/pricing), not a key from a different provider. Click \"Change API key\" above to re-enter it.");
      }
      throw e;
    }
    return parseTwelveDataQuote(data, symbol);
  }

  /* ---------------- Gemini prompt + parsing ---------------- */

  function buildResearchPrompt(groups, today) {
    var sections = groups.map(function (g) {
      return "Group id \"" + g.id + "\" (" + g.promptLabel + "): " +
        g.companies.map(function (c) { return c.company + " (" + c.symbol + ")"; }).join(", ");
    }).join("\n");

    return "You are an institutional equity research analyst. Today is " + (today || todayLabel()) + ". Use Google Search to find the LATEST publicly available information for every ticker below.\n\n" +
      sections + "\n\n" +
      "For EACH ticker return:\n" +
      "- \"pe\": trailing P/E as a number, or a short string like \"n/m (GAAP loss)\" if not meaningful. ETFs: the fund's P/E if published.\n" +
      "- \"fwdPe\": forward P/E as a number, or null if unavailable.\n" +
      "- \"peg\", \"pb\", \"roic\", \"fcf\": short strings (e.g. \"1.2\", \"~8x\", \"~25%\", \"$58B TTM\"). Use \"n/a\" if not found — never guess.\n" +
      "- \"earningsGrowth\": the most recent REPORTED quarter only. Include the fiscal quarter label and report date, EPS YoY % (say GAAP or adjusted), revenue YoY %, and flag any one-time items that distort EPS. If the next report is within 14 days, append \"Next report: <date>\". ETFs: \"N/A — ETF\". Max 45 words.\n" +
      "- \"peHistory\": how today's P/E compares with the company's OWN multi-year average or typical range (state the range and whether it is above, in line, or below). If history is too short, say so. Max 45 words.\n" +
      "- \"pullbackNote\": what is behind the stock's recent move versus its 52-week high — cite specific dated events (earnings reactions, guidance, macro, sector news). If it is near its high, say so. Max 45 words.\n" +
      "- \"outlookNote\": contributing factors and the forward outlook — the next catalyst and the key risk. Max 45 words.\n\n" +
      "For EACH group also return:\n" +
      "- \"pullbackOverall\": 1–2 sentences on what is driving the group's recent drawdown.\n" +
      "- \"outlookOverall\": 1–2 sentences on the group's forward outlook.\n\n" +
      "Rules: prefer primary sources (company press releases, SEC filings) for earnings figures. Be factual and neutral; no investment advice; no invented numbers. Keep it concise.\n\n" +
      "Respond with ONLY one valid JSON object — no markdown fences, no text before or after — in exactly this shape:\n" +
      "{\"asOf\":\"<today's date>\",\"groups\":{\"<group id>\":{\"pullbackOverall\":\"...\",\"outlookOverall\":\"...\",\"companies\":{\"<TICKER>\":{\"pe\":0,\"fwdPe\":0,\"peg\":\"\",\"pb\":\"\",\"roic\":\"\",\"fcf\":\"\",\"earningsGrowth\":\"\",\"peHistory\":\"\",\"pullbackNote\":\"\",\"outlookNote\":\"\"}}}}}\n" +
      "Include every group id and every ticker exactly as given.";
  }

  function parseRetryDelay(errorBody) {
    var match = String(errorBody || "").match(/"retryDelay"\s*:\s*"(\d+)s"/);
    return match ? match[1] : null;
  }

  // Strips fences/prose around the object, then retries once with trailing commas removed.
  function extractJsonObject(text) {
    if (!text || !String(text).trim()) throw ResearchError("Gemini returned an empty response.", "parse");
    var unfenced = String(text).replace(/```(?:json)?/gi, "");
    var start = unfenced.indexOf("{");
    var end = unfenced.lastIndexOf("}");
    if (start === -1 || end <= start) throw ResearchError("No JSON object found in Gemini's response.", "parse");
    var candidate = unfenced.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (firstErr) {
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch (_secondErr) {
        throw ResearchError("Gemini's response wasn't valid JSON (" + firstErr.message + ").", "parse");
      }
    }
  }

  // Grounding sources arrive as redirect links; only https URLs are kept.
  function extractSources(candidate) {
    var meta = candidate && candidate.groundingMetadata;
    var chunks = (meta && Array.isArray(meta.groundingChunks)) ? meta.groundingChunks : [];
    var seen = {};
    var out = [];
    chunks.forEach(function (ch) {
      var web = ch && ch.web;
      if (!web || typeof web.uri !== "string" || !/^https:\/\//i.test(web.uri)) return;
      var title = (typeof web.title === "string" && web.title.trim()) ? web.title.trim().slice(0, 120) : "Source";
      var key = title + "|" + web.uri;
      if (seen[key] || out.length >= MAX_SOURCES) return;
      seen[key] = true;
      out.push({ uri: web.uri, title: title });
    });
    return out;
  }

  function classifyGeminiHttpError(status, body, model) {
    var msg = "Gemini HTTP " + status;
    try {
      var parsed = JSON.parse(body);
      if (parsed.error && parsed.error.message) msg += " — " + parsed.error.message;
    } catch (_e) {
      if (body) msg += " — " + String(body).slice(0, 200);
    }
    if (status === 404 || (status === 400 && /not found|not supported|unknown model/i.test(body))) {
      return ResearchError(msg + " (model \"" + model + "\" unavailable)", "model");
    }
    if (status === 400 || status === 401 || status === 403) {
      return ResearchError(msg + " (check that your Gemini API key is correct and active)", "auth");
    }
    if (status === 429) {
      var retrySec = parseRetryDelay(body);
      return ResearchError(msg + (retrySec ? " (free-tier rate limit — retry in " + retrySec + "s)" : " (free-tier rate limit — wait a minute and try again)"), "rate");
    }
    return ResearchError(msg, status >= 500 ? "server" : "http");
  }

  function buildGeminiRequest(model, prompt) {
    var generationConfig = { maxOutputTokens: 32768 };
    if (/^gemini-2\.5-flash/.test(model)) {
      // Cap thinking so it can't starve the JSON output of tokens.
      generationConfig.thinkingConfig = { thinkingBudget: 2048 };
    }
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: generationConfig
    };
  }

  async function callGemini(apiKey, model, prompt, fetchImpl) {
    var doFetch = fetchImpl || fetch;
    var res;
    try {
      res = await doFetch(GEMINI_ENDPOINT + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(buildGeminiRequest(model, prompt))
      });
    } catch (e) {
      throw ResearchError("Couldn't reach the Gemini API (" + e.message + "). Check your connection and try again.", "network");
    }
    if (!res.ok) {
      var body = "";
      try { body = await res.text(); } catch (_e) { body = ""; }
      throw classifyGeminiHttpError(res.status, body, model);
    }
    var data = await res.json();
    if (data && data.promptFeedback && data.promptFeedback.blockReason) {
      throw ResearchError("Gemini blocked the request (" + data.promptFeedback.blockReason + ").", "blocked");
    }
    var candidate = (data && data.candidates || [])[0];
    var text = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts.map(function (p) { return (p && p.text) || ""; }).join("\n")
      : "";
    return { text: text, finishReason: candidate && candidate.finishReason, sources: extractSources(candidate) };
  }

  // Holds which model is currently working, so a fallback sticks for the rest of the session.
  function createResearcher(options) {
    var opts = options || {};
    var fetchImpl = opts.fetchImpl;
    var state = { model: opts.model || GEMINI_MODEL };
    var fallback = opts.fallbackModel || GEMINI_FALLBACK_MODEL;
    var log = opts.log || function () {};

    async function researchGroups(apiKey, groups) {
      var prompt = buildResearchPrompt(groups, opts.today);
      var raw;
      try {
        raw = await callGemini(apiKey, state.model, prompt, fetchImpl);
      } catch (e) {
        if (e.kind === "model" && state.model !== fallback) {
          state.model = fallback;
          raw = await callGemini(apiKey, state.model, prompt, fetchImpl);
        } else {
          throw e;
        }
      }
      var parsed;
      try {
        parsed = extractJsonObject(raw.text);
      } catch (e) {
        log("Gemini research JSON parse failed", { finishReason: raw.finishReason, raw: raw.text });
        if (raw.finishReason === "MAX_TOKENS") throw ResearchError("Gemini's response was cut off (token limit).", "truncated");
        throw e;
      }
      if (!parsed || typeof parsed.groups !== "object" || parsed.groups === null) {
        throw ResearchError("Gemini's response didn't include group data.", "parse");
      }
      return {
        asOf: typeof parsed.asOf === "string" ? parsed.asOf.slice(0, 40) : null,
        groups: parsed.groups,
        sources: raw.sources,
        model: state.model
      };
    }

    return { researchGroups: researchGroups, getModel: function () { return state.model; } };
  }

  /* ---------------- Merging live research over the snapshot ---------------- */

  function groupIsUsable(group, groupResult) {
    if (!groupResult || typeof groupResult.companies !== "object" || !groupResult.companies) return false;
    var hits = group.companies.filter(function (c) { return groupResult.companies[c.symbol]; }).length;
    return hits >= Math.ceil(group.companies.length / 2);
  }

  function cleanResearchValue(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v !== "string") return null;
    var t = v.trim();
    if (!t || t === "..." || t === "…") return null;
    return t.length > MAX_FIELD_CHARS ? t.slice(0, MAX_FIELD_CHARS - 1) + "…" : t;
  }

  function snapshotGroupState(snapshot, groupId) {
    var g = snapshot.groups[groupId];
    var companies = {};
    Object.keys(g.data).forEach(function (sym) {
      companies[sym] = Object.assign({}, g.data[sym], { live: false });
    });
    return {
      source: "snapshot",
      asOf: snapshot.asOf,
      metricsAsOf: snapshot.metricsAsOf,
      pullbackOverall: g.pullbackOverall,
      outlookOverall: g.outlookOverall,
      companies: companies,
      sources: [],
      model: null
    };
  }

  // Live values replace snapshot values only where the model returned something; each ticker is
  // flagged so the UI can tag rows that are still on the snapshot.
  function mergeLiveGroup(prev, group, groupResult, meta, today) {
    var companies = Object.assign({}, prev.companies);
    group.companies.forEach(function (c) {
      var entry = groupResult.companies[c.symbol];
      if (!entry || typeof entry !== "object") return;
      var merged = Object.assign({}, companies[c.symbol] || {});
      METRIC_FIELDS.concat(NOTE_FIELDS).forEach(function (f) {
        var v = cleanResearchValue(entry[f]);
        if (v !== null) merged[f] = v;
      });
      merged.live = true;
      companies[c.symbol] = merged;
    });
    return {
      source: "live",
      asOf: meta.asOf || today || todayLabel(),
      metricsAsOf: null,
      pullbackOverall: cleanResearchValue(groupResult.pullbackOverall) || prev.pullbackOverall,
      outlookOverall: cleanResearchValue(groupResult.outlookOverall) || prev.outlookOverall,
      companies: companies,
      sources: meta.sources || [],
      model: meta.model || null
    };
  }

  /* ---------------- Refresh orchestration ---------------- */

  // 1 combined call; then one call per table only for tables that came back unusable (or all
  // tables if the combined reply was truncated/unparseable). Key, rate-limit and network errors
  // stop immediately — retrying them only burns free-tier quota.
  async function runResearchRefresh(args) {
    var groups = args.groups;
    var researchGroups = args.researchGroups;
    var onResult = args.onGroupResult;
    var onStatus = args.onGroupStatus;
    var calls = 0;
    var retryGroups = [];

    try {
      calls++;
      var combined = await researchGroups(args.apiKey, groups);
      groups.forEach(function (group) {
        var gr = combined.groups[group.id];
        if (groupIsUsable(group, gr)) {
          onResult(group, gr, combined);
          onStatus([group.id], { refreshing: false, error: null, notice: null });
        } else {
          retryGroups.push(group);
        }
      });
    } catch (e) {
      if (e.kind === "parse" || e.kind === "truncated") {
        retryGroups = groups.slice();
      } else {
        onStatus(groups.map(function (g) { return g.id; }), { refreshing: false, error: e.message, notice: null });
        return { calls: calls, stoppedOn: e.kind };
      }
    }

    for (var i = 0; i < retryGroups.length; i++) {
      var group = retryGroups[i];
      try {
        calls++;
        var single = await researchGroups(args.apiKey, [group]);
        var gr = single.groups[group.id];
        if (groupIsUsable(group, gr)) {
          onResult(group, gr, single);
          onStatus([group.id], { refreshing: false, error: null, notice: "Refreshed via a follow-up call (the combined response was incomplete)." });
        } else {
          onStatus([group.id], { refreshing: false, error: "Gemini didn't return usable data for this table — showing the previous values. Try Refresh Research again.", notice: null });
        }
      } catch (e) {
        if (e.kind === "rate" || e.kind === "auth" || e.kind === "network") {
          onStatus(retryGroups.slice(i).map(function (g) { return g.id; }), { refreshing: false, error: e.message, notice: null });
          return { calls: calls, stoppedOn: e.kind };
        }
        onStatus([group.id], { refreshing: false, error: e.message + " Showing the previous values.", notice: null });
      }
    }
    return { calls: calls, stoppedOn: null };
  }

  /* ---------------- Display helpers ---------------- */

  function formatPe(v) {
    if (v === null || v === undefined || v === "") return null;
    return typeof v === "number" ? v.toFixed(1) : String(v);
  }

  function drawdownFor(quoteState) {
    if (!quoteState || !quoteState.quote) return null;
    var price = quoteState.quote.price, athValue = quoteState.quote.athValue;
    if (!isFinite(price) || !isFinite(athValue) || athValue <= 0) return null;
    return ((price - athValue) / athValue) * 100;
  }

  return {
    GEMINI_MODEL: GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL: GEMINI_FALLBACK_MODEL,
    METRIC_FIELDS: METRIC_FIELDS,
    NOTE_FIELDS: NOTE_FIELDS,
    MAX_FIELD_CHARS: MAX_FIELD_CHARS,
    MAX_SOURCES: MAX_SOURCES,
    ResearchError: ResearchError,
    todayLabel: todayLabel,
    fetchJsonDirect: fetchJsonDirect,
    buildQuoteUrl: buildQuoteUrl,
    parseTwelveDataQuote: parseTwelveDataQuote,
    fetchQuoteWithHigh: fetchQuoteWithHigh,
    buildResearchPrompt: buildResearchPrompt,
    parseRetryDelay: parseRetryDelay,
    extractJsonObject: extractJsonObject,
    extractSources: extractSources,
    classifyGeminiHttpError: classifyGeminiHttpError,
    buildGeminiRequest: buildGeminiRequest,
    callGemini: callGemini,
    createResearcher: createResearcher,
    groupIsUsable: groupIsUsable,
    cleanResearchValue: cleanResearchValue,
    snapshotGroupState: snapshotGroupState,
    mergeLiveGroup: mergeLiveGroup,
    runResearchRefresh: runResearchRefresh,
    formatPe: formatPe,
    drawdownFor: drawdownFor
  };
});
