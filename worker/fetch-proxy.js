/**
 * Organic Labs tools: page fetcher (Cloudflare Worker)
 *
 * The free tools on organiclabs.ai call this to read a public web page,
 * because browsers don't let a page read other websites (same-origin policy / CORS).
 *
 *   GET /fetch?url=https://example.com/page[&ua=gptbot]
 *   ->  { ok, status, url, finalUrl, contentType, headers, body, truncated, bytes, ms }
 *
 * Safety:
 *   - Only answers requests coming from the sites in ALLOWED_ORIGINS.
 *   - Only fetches public http(s) pages on ports 80/443; blocks localhost, private and reserved IPs.
 *   - 10 second timeout, 2 MB cap on the page it returns, text/HTML/XML/JSON only.
 *   - Best-effort limit of 20 fetches per visitor per hour (add a Cloudflare rate limiting rule for a hard limit).
 */

const ALLOWED_ORIGINS = [
  "https://organiclabs.ai",
  "https://www.organiclabs.ai",
  "https://akilavaruman.github.io",
];

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const HOURLY_LIMIT = 20;

const USER_AGENTS = {
  default: "Mozilla/5.0 (compatible; OrganicLabsTools/1.0; +https://organiclabs.ai/tools)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  perplexitybot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
};

const PASS_HEADERS = ["content-type", "x-robots-tag", "link", "last-modified", "cache-control", "server"];

// Best-effort per-visitor counter (per Worker instance; resets when the instance restarts).
const hits = new Map();

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed
      ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" }
      : {};

    if (request.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return json({ ok: false, error: "This service only works from organiclabs.ai." }, 403, cors);
    if (request.method !== "GET") return json({ ok: false, error: "Use GET." }, 405, cors);

    const reqUrl = new URL(request.url);
    if (reqUrl.pathname !== "/fetch") return json({ ok: false, error: "Not found." }, 404, cors);

    // rate limit
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
    if (list.length >= HOURLY_LIMIT) {
      return json({ ok: false, error: `Limit reached: ${HOURLY_LIMIT} checks per hour. Try again later.` }, 429, cors);
    }
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) hits.clear();

    // validate target
    let target;
    try {
      target = checkTarget(reqUrl.searchParams.get("url") || "");
    } catch (e) {
      return json({ ok: false, error: e.message }, 400, cors);
    }
    const uaKey = (reqUrl.searchParams.get("ua") || "default").toLowerCase();
    const ua = USER_AGENTS[uaKey] || USER_AGENTS.default;

    // fetch
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(target.toString(), {
        headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5" },
        redirect: "follow",
        signal: ctrl.signal,
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === "AbortError" ? "The site took longer than 10 seconds to respond." : "Couldn't reach that site.";
      return json({ ok: false, error: msg }, 502, cors);
    }

    try {
      checkTarget(res.url || target.toString()); // re-check after redirects
    } catch (e) {
      clearTimeout(timer);
      return json({ ok: false, error: "The page redirected to an address we can't fetch." }, 400, cors);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType && !/(text\/|html|xml|json)/i.test(contentType)) {
      clearTimeout(timer);
      return json({ ok: false, error: `That URL returns ${contentType.split(";")[0]}, not a web page.`, status: res.status }, 415, cors);
    }

    // read up to MAX_BYTES
    let bytes = 0, truncated = false;
    const chunks = [];
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > MAX_BYTES) {
          chunks.push(value.slice(0, MAX_BYTES - bytes));
          bytes = MAX_BYTES; truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value); bytes += value.byteLength;
      }
    } catch (e) {
      clearTimeout(timer);
      return json({ ok: false, error: "The page stopped loading before it finished." }, 502, cors);
    }
    clearTimeout(timer);

    const buf = new Uint8Array(bytes);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    const headers = {};
    for (const h of PASS_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }

    return json({
      ok: res.ok, status: res.status, url: target.toString(), finalUrl: res.url || target.toString(),
      contentType, headers, body, truncated, bytes, ms: Date.now() - started, ua: uaKey in USER_AGENTS ? uaKey : "default",
    }, 200, { ...cors, "Cache-Control": "no-store" });
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function checkTarget(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error("Enter a full URL, starting with https://"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http and https URLs can be checked.");
  if (u.username || u.password) throw new Error("URLs with a username or password can't be checked.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("Only standard web ports (80 and 443) can be checked.");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) throw new Error("Enter a public website address.");
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) throw new Error("Only public websites can be checked.");
  if (isBlockedIp(host)) throw new Error("Only public websites can be checked.");
  return u;
}

function isBlockedIp(host) {
  // IPv4
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  // IPv6 (any literal IPv6 address is rejected; public sites use hostnames)
  if (host.includes(":")) return true;
  // decimal / hex encoded IPv4 tricks
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  return false;
}
