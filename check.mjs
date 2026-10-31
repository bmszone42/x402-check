#!/usr/bin/env node
/**
 * /x402-check — unpaid quotes and optional paid OCP door calls.
 * Never prints private keys. Never sends telemetry. No USDC unless --yes
 * and a standard x402 client is already configured.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const DESK = "https://openclawproductions.com";
const USDC_DECIMALS = 1_000_000;
const USER_AGENT = "x402-check/1.5";
const FETCH_MS = 15_000;
const SELLER_DOOR_CAP = 8;
/** Hard cap on the target seller's one paid call. OCP doors are quoted separately. */
export const DEFAULT_MAX_USDC = 0.05;

/** Same weights as GET /api/v1/leaderboard GRADE_FORMULA. */
export const GRADE_FORMULA = {
  paid_ok_pts: 30,
  settled_pts: 30,
  real_content_pts: 25,
  latency_pts: 10,
  uptime_streak_pts: 5,
  latency_cap_ms: 2000,
  streak_cap_days: 5,
  content_y: 1,
  content_partial: 0.5,
  content_n: 0,
};

export const GRADE_FORMULA_TEXT =
  "grade 0-100 = round(30*paid_ok + 30*settled + 25*content + 10*latency + 5*min(streak,5)/5). " +
  "Unread parts are omitted from the sum (not zeroed). Streak is unread unless ping-ledger/leaderboard history exists.";

/** Default paid doors for one run. Prices copied from the OCP catalog (atomic USDC). */
export const PAID_DOORS = [
  {
    id: "livegrade",
    title: "Live Grade",
    path: "/api/v1/livegrade",
    samplePath: "/api/v1/livegrade/sample",
    amountAtomic: 40000,
    why: "on-demand grade of any public origin from live unpaid checks. Unmeasurable formula parts stay unread. Includes cheapest working listed door.",
    query: (t) => ({ origin: t.origin }),
    localOk: true,
  },
  {
    id: "pipecheck",
    title: "Pipe Check",
    path: "/api/v1/pipecheck",
    samplePath: "/api/v1/pipecheck/sample",
    amountAtomic: 20000,
    why: "live 402 class plus measured elapsed_ms and http_status for the target URL. Never invents settles.",
    query: (t) => ({ url: t.endpoint }),
    localOk: false,
  },
  {
    id: "settleproof",
    title: "Settle Proof",
    path: "/api/v1/settleproof",
    samplePath: null,
    amountAtomic: 20000,
    why: "last on-chain USDC settles for a payTo (or origin-resolved payTo). Empty is an empty set, not a fake tx.",
    query: (t) => ({ origin: t.origin }),
    localOk: false,
  },
];

/** Documented extras. Not in the default quote. */
export const OPTIONAL_DOORS = [
  {
    id: "x402verify",
    title: "X402 Verify",
    path: "/api/v1/x402verify",
    samplePath: "/api/v1/x402verify/sample",
    amountAtomic: 40000,
    why: "well-known + unpaid 402 shape. Live Grade already reads well-known for listed doors.",
  },
  {
    id: "doorhealth",
    title: "Door Health",
    path: "/api/v1/doorhealth",
    samplePath: "/api/v1/doorhealth/sample",
    amountAtomic: 10000,
    why: "nightly unpaid-check latency/streak. Unknown host returns 404 and is not charged.",
  },
  {
    id: "find-price-meters",
    title: "Find Price Meters",
    path: "/api/v1/find-price-meters",
    samplePath: "/api/v1/find-price-meters/sample",
    amountAtomic: 30000,
    why: "find + price + meters together. SIT when unread. MATCH is not a live door.",
  },
];

export const FREE_LEADERBOARD = `${DESK}/api/v1/leaderboard`;
export const CLAIM_URL = `${DESK}/claim`;

const TUNNEL_RE = /ngrok|loca\.lt|serveo/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function atomicToUsd(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n) || n < 0) return null;
  return n / USDC_DECIMALS;
}

export function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "unread";
  const rounded = Math.round(n * USDC_DECIMALS) / USDC_DECIMALS;
  return `$${rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function quotePaidDoors(doors = PAID_DOORS) {
  const totalAtomic = doors.reduce((sum, d) => sum + d.amountAtomic, 0);
  return {
    doors: doors.map((d) => ({
      id: d.id,
      title: d.title,
      path: d.path,
      amountAtomic: d.amountAtomic,
      priceUsd: formatUsd(atomicToUsd(d.amountAtomic)),
    })),
    totalAtomic,
    totalUsd: formatUsd(atomicToUsd(totalAtomic)),
  };
}

export function parseMaxUsdc(raw, fallback = DEFAULT_MAX_USDC) {
  if (raw == null || raw === "") return fallback;
  const n = Number(String(raw).trim().replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function quoteFullRun({ ocpDoors = PAID_DOORS, seller = null, maxUsdc = DEFAULT_MAX_USDC } = {}) {
  const ocp = quotePaidDoors(ocpDoors);
  const sellerAtomic = seller?.amountAtomic != null && /^\d+$/.test(String(seller.amountAtomic)) ? Number(seller.amountAtomic) : null;
  const sellerUsd = sellerAtomic == null ? null : atomicToUsd(sellerAtomic);
  const overCap = sellerUsd != null && sellerUsd > maxUsdc;
  const wouldPaySeller = Boolean(seller?.url) && sellerAtomic != null && !overCap;
  const sellerInTotal = wouldPaySeller ? sellerAtomic : 0;
  const totalAtomic = ocp.totalAtomic + sellerInTotal;
  return {
    ocp,
    seller: seller
      ? {
          url: seller.url,
          amountAtomic: sellerAtomic,
          priceUsd: formatUsd(sellerUsd),
          payTo: seller.payTo ?? null,
        }
      : null,
    maxUsdc,
    maxUsdcLabel: formatUsd(maxUsdc),
    overCap,
    wouldPaySeller,
    refused_reason: !seller
      ? "no working listed door to pay"
      : overCap
        ? `cheapest door ${formatUsd(sellerUsd)} is over --max-usdc ${formatUsd(maxUsdc)}; will not pay the target`
        : null,
    totalAtomic,
    totalUsd: formatUsd(atomicToUsd(totalAtomic)),
  };
}

export function classifyPaidContent(input) {
  const status = input?.status;
  const type = String(input?.contentType ?? "").toLowerCase();
  const text = typeof input?.bodyText === "string" ? input.bodyText : "";
  const rec = input?.body && typeof input.body === "object" ? input.body : null;
  if (status == null) {
    return { class: null, status: "unread", why: "no paid response captured" };
  }
  if (status === 402) return { class: "n", status: "measured", why: "still HTTP 402 after pay" };
  if (status >= 500) return { class: "n", status: "measured", why: `HTTP ${status}` };
  if (status !== 200 && status !== 201) return { class: "n", status: "measured", why: `HTTP ${status}` };
  if (type.includes("text/html")) return { class: "n", status: "measured", why: "HTML, not paid content" };
  if (!text.trim() && !rec) return { class: "n", status: "measured", why: "empty body" };
  if (rec) {
    const keys = Object.keys(rec);
    if (keys.length === 0) return { class: "n", status: "measured", why: "empty JSON object" };
    if (rec.error && rec.ok !== true) return { class: "n", status: "measured", why: "JSON error object" };
    if (/placeholder|lorem ipsum|coming soon|todo\b/i.test(text) && text.length < 120) {
      return { class: "n", status: "measured", why: "placeholder text" };
    }
    return { class: "y", status: "measured", why: "non-empty JSON HTTP 200" };
  }
  if (text.trim().length < 8) return { class: "partial", status: "measured", why: "tiny non-JSON body" };
  return { class: "partial", status: "measured", why: "non-JSON HTTP 200 with a body" };
}

export function parsePaidWrapper(stdout, stderr, exitCode) {
  const blob = `${stdout ?? ""}\n${stderr ?? ""}`;
  let json = null;
  const trimmed = String(stdout ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  if (!json) {
    const match = blob.match(/\{[\s\S]*"transaction"[\s\S]*\}/);
    if (match) {
      try {
        json = JSON.parse(match[0]);
      } catch {
        json = null;
      }
    }
  }
  const rec = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const nested = rec.transaction && typeof rec.transaction === "object" ? rec.transaction : rec;
  const txRaw =
    nested.transaction ??
    rec.tx_hash ??
    rec.txHash ??
    rec.hash ??
    rec?.["payment-response"]?.transaction ??
    rec?._meta?.["x402/payment-response"]?.transaction;
  const tx = typeof txRaw === "string" && /^0x[a-fA-F0-9]{64}$/.test(txRaw) ? txRaw : null;
  const successFlag = rec.success === true || rec.settled === true || nested.success === true;
  const failedFlag =
    rec.success === false ||
    rec.settled === false ||
    /settle_failed|payment verification failed/i.test(blob);
  let http =
    typeof rec.http_status === "number"
      ? rec.http_status
      : typeof rec.status === "number" && rec.status >= 100 && rec.status < 600
        ? rec.status
        : null;
  if (http == null) {
    const m = blob.match(/\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i);
    if (m) http = Number(m[1]);
  }
  let settled = { status: "unread", value: null, why: "wrapper did not report a tx hash" };
  if (tx && (successFlag || exitCode === 0)) {
    settled = { status: "measured", value: true, why: "wrapper reported success plus tx hash", tx_hash: tx };
  } else if (failedFlag) {
    settled = { status: "measured", value: false, why: "wrapper reported settle failure", tx_hash: tx };
  } else if (tx) {
    settled = { status: "measured", value: true, why: "wrapper returned a 32-byte tx hash", tx_hash: tx };
  }
  const picked = pickPaidLatency({ wrapperJson: rec, nested });
  return {
    exitCode,
    http_status: http,
    tx_hash: tx,
    settled,
    elapsed_ms: picked.ms,
    latency_source: picked.source,
    latency_field: picked.field,
    body: rec,
    bodyText: trimmed.slice(0, 8000),
  };
}

/** Paid-request duration fields a fetch client should emit (ms, paid HTTP only). */
export const PAID_LATENCY_FIELDS = [
  "paid_request_ms",
  "paid_elapsed_ms",
  "request_ms",
  "response_ms",
  "ttfb_ms",
  "elapsed_ms",
  "latency_ms",
];

function positiveMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function firstLatencyField(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ms: null, field: null };
  for (const field of PAID_LATENCY_FIELDS) {
    const ms = positiveMs(rec[field]);
    if (ms != null) return { ms, field };
  }
  return { ms: null, field: null };
}

/**
 * Seller paid-response time for the grade. Never uses wrapper wall-clock
 * (node startup, wallet load, unsigned 402, signing).
 */
export function pickPaidLatency({ wrapperJson = null, nested = null, unpaidProbeMs = null } = {}) {
  const bags = [
    wrapperJson,
    nested && nested !== wrapperJson ? nested : null,
    wrapperJson?.timing,
    wrapperJson?.metrics,
    wrapperJson?.stats,
    wrapperJson?._meta,
    nested?.timing,
  ];
  for (const bag of bags) {
    const hit = firstLatencyField(bag);
    if (hit.ms != null) return { ms: hit.ms, source: "wrapper_json", field: hit.field };
  }
  const probe = positiveMs(unpaidProbeMs);
  if (probe != null) return { ms: probe, source: "unpaid_402_probe", field: null };
  return { ms: null, source: "unread", field: null };
}

export function streakFromLeaderboard(row) {
  const days = row?.components?.uptime_streak_days ?? row?.uptime_streak_days;
  if (typeof days === "number" && Number.isFinite(days) && days >= 0) return days;
  return null;
}

export function computeGrade(input) {
  const unread = (why) => ({ status: "unread", pts: null, value: null, why });
  const paid =
    input?.paid_ok === true || input?.paid_ok === false
      ? {
          status: "measured",
          pts: input.paid_ok ? GRADE_FORMULA.paid_ok_pts : 0,
          value: input.paid_ok,
          why: input.paid_ok ? "paid call returned success" : "paid call did not succeed",
        }
      : unread("seller not paid this run");
  const settled =
    input?.settled === true || input?.settled === false
      ? {
          status: "measured",
          pts: input.settled ? GRADE_FORMULA.settled_pts : 0,
          value: input.settled,
          why: input.settled_why ?? (input.settled ? "tx hash from wrapper" : "settle failed"),
          tx_hash: input.tx_hash ?? null,
        }
      : unread("no tx hash or on-chain confirmation this run");
  let content;
  if (input?.content === "y" || input?.content === "partial" || input?.content === "n") {
    const mul =
      input.content === "y"
        ? GRADE_FORMULA.content_y
        : input.content === "partial"
          ? GRADE_FORMULA.content_partial
          : GRADE_FORMULA.content_n;
    content = {
      status: "measured",
      pts: GRADE_FORMULA.real_content_pts * mul,
      value: input.content,
      why: input.content_why ?? `content class ${input.content}`,
    };
  } else {
    content = unread("paid body not captured");
  }
  let latency;
  if (typeof input?.latency_ms === "number" && Number.isFinite(input.latency_ms) && input.latency_ms >= 0) {
    const capped = Math.min(input.latency_ms, GRADE_FORMULA.latency_cap_ms);
    latency = {
      status: "measured",
      pts: GRADE_FORMULA.latency_pts * (1 - capped / GRADE_FORMULA.latency_cap_ms),
      value: input.latency_ms,
      why: "seller paid-response ms (not wrapper wall-clock), 2000ms cap",
    };
  } else {
    latency = unread("paid-call latency not captured");
  }
  let streak;
  if (typeof input?.streak_days === "number" && Number.isFinite(input.streak_days) && input.streak_days >= 0) {
    const mul = Math.min(input.streak_days, GRADE_FORMULA.streak_cap_days) / GRADE_FORMULA.streak_cap_days;
    streak = {
      status: "measured",
      pts: GRADE_FORMULA.uptime_streak_pts * mul,
      value: input.streak_days,
      why: "leaderboard ping-ledger streak for this host",
    };
  } else {
    streak = unread("streak needs ping-ledger history; not invented");
  }
  const components = { paid_ok: paid, settled, real_content: content, latency, uptime_streak: streak };
  const measured = Object.values(components).filter((row) => row.status === "measured");
  const omitted = Object.entries(components)
    .filter(([, row]) => row.status === "unread")
    .map(([key]) => key);
  const pts = measured.reduce((sum, row) => sum + (typeof row.pts === "number" ? row.pts : 0), 0);
  return {
    formula: GRADE_FORMULA,
    grade: measured.length === 0 ? null : Math.max(0, Math.min(100, Math.round(pts))),
    measured_pts: measured.length === 0 ? null : pts,
    omitted,
    note:
      omitted.length > 0
        ? `grade is round(sum of measured pts). unread omitted (${omitted.join(", ")}), not zeroed.`
        : "all five formula parts measured.",
    components,
  };
}

export function parseTarget(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "pass an https origin or door URL" };
  let url;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "only http(s) URLs" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "missing host" };
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || IPV4_RE.test(host)) {
    return { ok: false, error: "localhost and IPs are rejected" };
  }
  if (TUNNEL_RE.test(host)) return { ok: false, error: "tunnel origins are rejected" };
  const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  const endpoint = url.pathname && url.pathname !== "/" ? url.toString() : origin;
  return { ok: true, host, origin, endpoint, input: trimmed };
}

export function parse402Quote(body, status) {
  const rec = body && typeof body === "object" ? body : {};
  const accepts = Array.isArray(rec.accepts) ? rec.accepts : [];
  const first = accepts[0] && typeof accepts[0] === "object" ? accepts[0] : {};
  const amount =
    first.amount != null
      ? String(first.amount)
      : first.maxAmountRequired != null
        ? String(first.maxAmountRequired)
        : null;
  const usd = amount != null ? atomicToUsd(amount) : null;
  return {
    http_status: status,
    x402Version: rec.x402Version ?? null,
    serviceName: rec.serviceName ?? rec.resource?.serviceName ?? rec.resource?.title ?? null,
    amountAtomic: amount,
    priceUsd: formatUsd(usd),
    network: first.network ?? null,
    scheme: first.scheme ?? null,
    facilitator: rec.facilitator ?? first.facilitator ?? first.extra?.facilitator ?? null,
    payTo: typeof first.payTo === "string" ? first.payTo : null,
  };
}

export function listedPaidDoors(origin, body) {
  const rec = body && typeof body === "object" ? body : {};
  const rows = [...(Array.isArray(rec.resources) ? rec.resources : []), ...(Array.isArray(rec.items) ? rec.items : []), ...(Array.isArray(rec.skus) ? rec.skus : [])];
  const out = [];
  const seen = new Set();
  const base = String(origin ?? "").replace(/\/$/, "");
  for (const row of rows) {
    const item = row && typeof row === "object" ? row : {};
    if (item.price === null || item.priceUsd === null) continue;
    const accepts = Array.isArray(item.accepts) ? item.accepts : [];
    const priced = accepts.length > 0 || typeof item.priceUsd === "number" || (typeof item.price === "string" && item.price.length > 0);
    if (!priced) continue;
    const raw = item.resource ?? item.resourceUrl ?? item.url;
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (raw.endsWith("/sample")) continue;
    const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `${base}${raw.startsWith("/") ? raw : `/${raw}`}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const method = typeof item.method === "string" && item.method.trim() ? item.method.trim().toUpperCase() : "GET";
    out.push({ url, method });
  }
  return out;
}

export function listedPaidDoorUrls(origin, body) {
  return listedPaidDoors(origin, body).map((row) => row.url);
}

function scalarParam(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function bazaarInputFrom402(body) {
  const rec = body && typeof body === "object" ? body : {};
  const bazaar = rec.extensions?.bazaar ?? rec.bazaar ?? null;
  const info = bazaar?.info && typeof bazaar.info === "object" ? bazaar.info : bazaar;
  const input = info?.input && typeof info.input === "object" ? info.input : null;
  const method = typeof input?.method === "string" ? input.method.toUpperCase() : null;
  const queryParams = {};
  if (input?.queryParams && typeof input.queryParams === "object" && !Array.isArray(input.queryParams)) {
    for (const [key, value] of Object.entries(input.queryParams)) {
      const scalar = scalarParam(value);
      if (scalar != null) queryParams[key] = scalar;
    }
  }
  const postBody = input?.body && typeof input.body === "object" ? input.body : null;
  const schemaQp =
    bazaar?.schema?.properties?.input?.properties?.queryParams ??
    info?.inputSchema?.properties?.queryParams ??
    info?.inputSchema;
  const requiredQuery = Array.isArray(schemaQp?.required) ? schemaQp.required.map(String) : [];
  return {
    method,
    queryParams: Object.keys(queryParams).length ? queryParams : null,
    body: postBody,
    requiredQuery,
  };
}

export function openapiSamplesForPath(spec, doorUrl) {
  let pathname = "";
  try {
    pathname = new URL(doorUrl).pathname;
  } catch {
    return { method: null, queryParams: null, requiredQuery: [] };
  }
  const rec = spec && typeof spec === "object" ? spec : {};
  const paths = rec.paths && typeof rec.paths === "object" ? rec.paths : {};
  const item = paths[pathname] && typeof paths[pathname] === "object" ? paths[pathname] : null;
  if (!item) return { method: null, queryParams: null, requiredQuery: [] };
  const methodName = ["get", "head", "post", "put", "patch", "delete"].find((m) => item[m]);
  const op = methodName && typeof item[methodName] === "object" ? item[methodName] : null;
  const params = Array.isArray(op?.parameters) ? op.parameters : [];
  const queryParams = {};
  const requiredQuery = [];
  for (const raw of params) {
    const p = raw && typeof raw === "object" ? raw : {};
    if (p.in !== "query" || typeof p.name !== "string") continue;
    if (p.required) requiredQuery.push(p.name);
    const example = scalarParam(p.example) ?? scalarParam(p.schema?.example) ?? scalarParam(p.schema?.default);
    if (example != null) queryParams[p.name] = example;
  }
  return {
    method: methodName ? methodName.toUpperCase() : null,
    queryParams: Object.keys(queryParams).length ? queryParams : null,
    requiredQuery,
  };
}

export function sameDoorPath(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

export function applyQueryParams(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!u.searchParams.has(key) && value != null) u.searchParams.set(key, String(value));
  }
  return u.toString();
}

export function mergeExactRequest({ doorUrl, listedMethod = "GET", bazaar = null, leaderboardUrl = null, openapi = null } = {}) {
  const from402 = bazaar ?? { method: null, queryParams: null, body: null, requiredQuery: [] };
  const fromSpec = openapi ? openapiSamplesForPath(openapi, doorUrl) : { method: null, queryParams: null, requiredQuery: [] };
  let method = (from402.method || fromSpec.method || listedMethod || "GET").toUpperCase();
  let url = doorUrl;
  let source = "listed";
  if (leaderboardUrl && sameDoorPath(leaderboardUrl, doorUrl)) {
    try {
      const lb = new URL(leaderboardUrl);
      if ([...lb.searchParams.keys()].length > 0) {
        url = leaderboardUrl;
        source = "leaderboard";
        method = "GET";
      }
    } catch {
      /* keep listed */
    }
  }
  const queryParams = { ...(fromSpec.queryParams ?? {}), ...(from402.queryParams ?? {}) };
  if (Object.keys(queryParams).length) {
    url = applyQueryParams(url, queryParams);
    source = source === "listed" ? (from402.queryParams ? "bazaar" : "openapi") : `${source}+samples`;
  }
  const body = method !== "GET" && method !== "HEAD" ? from402.body : null;
  if (body && source === "listed") source = "bazaar";
  const have = new URL(url).searchParams;
  const requiredQuery = [...new Set([...(from402.requiredQuery ?? []), ...(fromSpec.requiredQuery ?? [])])];
  const missing = requiredQuery.filter((name) => {
    if (have.has(name)) return false;
    if (body && body[name] != null) return false;
    return true;
  });
  return {
    ok: missing.length === 0,
    missing,
    url,
    method,
    body,
    source,
  };
}

export function isInvalidTargetStatus(status) {
  return status === 400 || status === 404 || status === 405 || status === 409 || status === 415 || status === 422;
}

export function invalidTargetReason({ status, bodyText } = {}) {
  const snippet = String(bodyText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (isInvalidTargetStatus(status)) {
    return `HTTP ${status} invalid target response${snippet ? ` (${snippet})` : ""}`;
  }
  if (/is required|missing required|invalid input/i.test(snippet)) {
    return `target rejected input (${snippet})`;
  }
  return null;
}

export function pickCheapestWorking(candidates) {
  const working = (candidates ?? []).filter((row) => row?.works && row.amountAtomic != null && /^\d+$/.test(String(row.amountAtomic)));
  if (working.length === 0) return null;
  const sorted = [...working].sort((a, b) => {
    const da = BigInt(String(a.amountAtomic));
    const db = BigInt(String(b.amountAtomic));
    if (da === db) return (a.elapsed_ms ?? 0) - (b.elapsed_ms ?? 0);
    return da < db ? -1 : 1;
  });
  return sorted[0] ?? null;
}

export function pickCheapestUsable(candidates) {
  const usable = (candidates ?? []).filter((row) => {
    if (!row?.usable) return false;
    const method = String(row.method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD";
  });
  return pickCheapestWorking(usable);
}

export function matchLeaderboardSeller(doc, host) {
  const sellers = Array.isArray(doc?.sellers) ? doc.sellers : [];
  const needle = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!needle) return null;
  return (
    sellers.find((row) => {
      const h = String(row?.host ?? "").toLowerCase().replace(/^www\./, "");
      return h === needle;
    }) ?? null
  );
}

export function plannedFormulaFill(fullQuote) {
  const pay = Boolean(fullQuote?.wouldPaySeller);
  const skip = fullQuote?.refused_reason ?? "seller not paid this run";
  return {
    paid_ok: pay
      ? { would: "measured", how: "one paid GET of the named cheapest working door" }
      : { would: "unread", how: skip },
    settled: pay
      ? { would: "measured", how: "wrapper success plus 32-byte tx hash, or settle_failed" }
      : { would: "unread", how: skip },
    real_content: pay
      ? { would: "measured", how: "paid body: non-empty, valid type/schema, not error/placeholder" }
      : { would: "unread", how: skip },
    latency: pay
      ? { would: "measured", how: "seller paid-response ms (paid_request_ms or unpaid 402 probe of the same URL), 2000ms cap" }
      : { would: "unread", how: skip },
    uptime_streak: {
      would: "measured if history",
      how: "leaderboard/ping-ledger uptime_streak_days; unread if absent, not invented",
    },
  };
}

export function plannedCalls(target, doors = PAID_DOORS, deskBase = DESK, opts = {}) {
  const quote = quotePaidDoors(doors);
  const fullQuote = quoteFullRun({
    ocpDoors: doors,
    seller: opts.seller ?? null,
    maxUsdc: opts.maxUsdc ?? DEFAULT_MAX_USDC,
  });
  const paid = doors.map((d) => {
    const q = new URLSearchParams(d.query(target));
    const base = d.localOk ? deskBase.replace(/\/$/, "") : DESK;
    return {
      id: d.id,
      title: d.title,
      method: "GET",
      url: `${base}${d.path}?${q.toString()}`,
      sampleUrl: d.samplePath ? `${base}${d.samplePath}` : null,
      amountAtomic: d.amountAtomic,
      priceUsd: formatUsd(atomicToUsd(d.amountAtomic)),
      why: d.why,
      desk: base !== DESK,
    };
  });
  return {
    target,
    deskBase,
    quote,
    fullQuote,
    formulaFill: plannedFormulaFill(fullQuote),
    maxUsdc: fullQuote.maxUsdc,
    free: [{ method: "GET", url: FREE_LEADERBOARD, why: "grades JSON. HTTP 200. No USDC. Only hosts already in the nightly set." }],
    paid,
    optional: OPTIONAL_DOORS.map((d) => ({
      id: d.id,
      url: `${DESK}${d.path}`,
      sampleUrl: d.samplePath ? `${DESK}${d.samplePath}` : null,
      priceUsd: formatUsd(atomicToUsd(d.amountAtomic)),
      why: d.why,
    })),
  };
}

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/0x[a-fA-F0-9]{64}/g, "0x[redacted-64]")
    .replace(/(PAYMENT-SIGNATURE|X-PAYMENT|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

async function getJson(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  const started = Date.now();
  const method = String(opts.method ?? "GET").toUpperCase();
  try {
    const headers = { accept: "application/json", "user-agent": USER_AGENT };
    let fetchBody;
    if (opts.body != null && method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json";
      fetchBody = JSON.stringify(opts.body);
    }
    const res = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      signal: ac.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { unread_json: true, text_len: text.length };
    }
    const header = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
    if (header) {
      try {
        const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        if (decoded && typeof decoded === "object") {
          const headerAccepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
          const bodyAccepts = body && typeof body === "object" && Array.isArray(body.accepts) ? body.accepts : [];
          const bodyObj = body && typeof body === "object" ? body : {};
          body = {
            ...decoded,
            ...bodyObj,
            accepts: headerAccepts.length > 0 ? headerAccepts : bodyAccepts,
            extensions: decoded.extensions ?? bodyObj.extensions,
          };
        }
      } catch {
        /* keep body */
      }
    }
    return { url, status: res.status, body, elapsed_ms: Math.max(0, Date.now() - started) };
  } catch (err) {
    return {
      url,
      status: null,
      error: err instanceof Error ? err.message : "fetch failed",
      body: null,
      elapsed_ms: Math.max(0, Date.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatGrade(grade) {
  if (!grade) return "grade=unread (nothing measured)";
  const lines = [
    `grade=${grade.grade ?? "unread"} measured_pts=${grade.measured_pts ?? "unread"} omitted=${grade.omitted.join(",") || "none"}`,
    GRADE_FORMULA_TEXT,
    grade.note,
  ];
  for (const [key, row] of Object.entries(grade.components)) {
    const pts = row.pts == null ? "unread" : String(row.pts);
    const val = row.value == null ? "unread" : String(row.value);
    const extra = row.tx_hash ? ` tx_hash=${row.tx_hash}` : "";
    lines.push(`  ${key}: ${row.status} pts=${pts} value=${val}${extra} (${row.why})`);
  }
  return lines.join("\n");
}

function printQuote(plan) {
  const full = plan.fullQuote ?? quoteFullRun({ ocpDoors: PAID_DOORS, seller: null, maxUsdc: plan.maxUsdc ?? DEFAULT_MAX_USDC });
  const deskNote =
    plan.deskBase && plan.deskBase !== DESK
      ? `Live Grade unpaid quotes use local desk ${plan.deskBase} (not deployed production). Other OCP doors still quote ${DESK}.`
      : "Live Grade is quoted at production; until overlay deploy that unpaid GET may be 404.";
  const sellerLines = [];
  if (full.seller?.url) {
    const include = full.wouldPaySeller ? "INCLUDED in total; one paid GET on --yes" : "NOT paid; not in total";
    sellerLines.push(
      `  - target cheapest ${full.seller.priceUsd} (${full.seller.amountAtomic}) GET ${full.seller.url} payTo=${full.seller.payTo ?? "unread"} [${include}]`,
    );
    if (full.refused_reason) sellerLines.push(`    refuse: ${full.refused_reason}`);
  } else {
    sellerLines.push(
      "  - target cheapest: none (no listed GET door with documented sample inputs that unpaid-probed 402). Not in total.",
    );
  }
  const fill = plan.formulaFill ?? plannedFormulaFill(full);
  const fillLines = Object.entries(fill).map(
    ([key, row]) => `  - ${key}: would ${row.would} — ${row.how}`,
  );
  const lines = [
    `/x402-check target ${plan.target.origin}`,
    `Price per run (quoted up front): ${full.totalUsd} USDC on Base (${full.totalAtomic} atomic) = OCP ${full.ocp.totalUsd} + target ${full.wouldPaySeller ? full.seller.priceUsd : "$0"}.`,
    `Hard cap --max-usdc ${full.maxUsdcLabel} applies to the target door only (not the OCP ${full.ocp.totalUsd}).`,
    "Breakdown (OCP doors):",
    ...full.ocp.doors.map((d) => `  - ${d.id} ${d.priceUsd} (${d.amountAtomic}) GET ${d.path}`),
    "Target seller (at most one paid call):",
    ...sellerLines,
    "Free (not in the total): GET /api/v1/leaderboard plus unpaid GETs of the seller's listed doors.",
    deskNote,
    "Formula parts this run would fill:",
    ...fillLines,
    "Pay only with --yes after this quote, using your own x402 client. This skill never asks for a private key. Never more than one target call.",
  ];
  return lines.join("\n");
}

export function formatDryRun(plan, hits, extra = {}) {
  const chunks = [
    printQuote(plan),
    "",
    "Dry-run: unpaid 402 quotes, seller listed-door comparison, and free GETs. No USDC. Does not pay the target or OCP.",
  ];
  for (const hit of hits) {
    chunks.push("");
    chunks.push(`## ${hit.label}`);
    chunks.push(`${hit.method} ${hit.url}`);
    if (hit.error) {
      chunks.push(`error: ${redact(hit.error)}`);
      continue;
    }
    chunks.push(`HTTP ${hit.status}${hit.elapsed_ms != null ? ` elapsed_ms=${hit.elapsed_ms}` : ""}`);
    if (hit.quote) {
      chunks.push(
        `402 quote: ${hit.quote.serviceName ?? "unread"} ${hit.quote.priceUsd} amount=${hit.quote.amountAtomic} network=${hit.quote.network} scheme=${hit.quote.scheme}`,
      );
    }
    if (hit.note) chunks.push(hit.note);
    if (hit.snippet) chunks.push(hit.snippet);
  }
  if (extra.not_graded) {
    chunks.push("");
    chunks.push(`## not graded: ${extra.not_graded}`);
  } else if (extra.grade) {
    chunks.push("");
    chunks.push("## dry-run grade (measured parts only; unpaid so paid_ok/settled/content/latency stay unread)");
    chunks.push(formatGrade(extra.grade));
  }
  chunks.push("");
  chunks.push("Gaps:");
  chunks.push("- This dry-run does not pay. paid_ok, settled, real_content, and paid-call latency stay unread until --yes.");
  chunks.push("- Target pay URL includes documented sample query params (402 bazaar, leaderboard ping URL, or OpenAPI). Unpaid exact probe must be 402 or the run aborts before any pay.");
  chunks.push("- Streak stays unread unless leaderboard/ping-ledger history exists; it is not invented.");
  chunks.push("- Invalid target 4xx is reported as not graded, never as a 0–100 score.");
  chunks.push("- Latency grades seller paid-response time: wrapper JSON paid_request_ms (or elapsed_ms/latency_ms), else the unpaid 402 probe of the same URL. Wrapper wall-clock is never graded.");
  chunks.push("- Production Live Grade is undeployed until overlay deploy; use --desk for a local unpublished door.");
  chunks.push(`Sellers: ${CLAIM_URL}`);
  return chunks.join("\n");
}

function snippetSeller(row) {
  if (!row) return "leaderboard: no row for this host (grade unread). listed=true is never invented.";
  return [
    `leaderboard grade=${row.grade ?? "unread"} rank=${row.rank ?? "unread"} host=${row.host}`,
    `settled=${row.settled ?? "unread"} paid_ok=${row.paid_ok ?? "unread"} latency_ms=${row.latency_ms ?? "unread"} quoted_price_usd=${row.quoted_price_usd ?? "unread"}`,
    `url=${row.url ?? "unread"}`,
  ].join("\n");
}

export async function compareSellerDoors(origin, opts = {}) {
  const wkUrl = `${origin}/.well-known/x402`;
  const wk = await getJson(wkUrl);
  const doors = listedPaidDoors(origin, wk.body).slice(0, SELLER_DOOR_CAP);
  const needOpenapi = true;
  let openapi = opts.openapi ?? null;
  if (!openapi && needOpenapi) {
    const specHit = await getJson(`${String(origin).replace(/\/$/, "")}/openapi.json`);
    openapi = specHit.status === 200 && specHit.body && typeof specHit.body === "object" ? specHit.body : null;
  }
  const leaderboardUrl = typeof opts.leaderboardUrl === "string" ? opts.leaderboardUrl : null;
  const candidates = [];
  for (const door of doors) {
    const hit = await getJson(door.url);
    const quote = hit.status === 402 ? parse402Quote(hit.body, hit.status) : null;
    const works = Boolean(quote && quote.payTo && quote.amountAtomic);
    const bazaar = bazaarInputFrom402(hit.body);
    const exact = mergeExactRequest({
      doorUrl: door.url,
      listedMethod: door.method,
      bazaar,
      leaderboardUrl,
      openapi,
    });
    let exactHit = null;
    const sameCall =
      exact.url === door.url && (exact.method === "GET" || exact.method === "HEAD") && exact.body == null;
    if (exact.ok && !sameCall) {
      exactHit = await getJson(exact.url, { method: exact.method, body: exact.body });
    } else if (exact.ok && sameCall) {
      exactHit = hit;
    }
    const exactStatus = exactHit?.status ?? null;
    const exactInvalid = exactHit ? invalidTargetReason({ status: exactStatus, bodyText: JSON.stringify(exactHit.body ?? "") }) : null;
    const usable = Boolean(
      works &&
      exact.ok &&
      exactStatus === 402 &&
      !exactInvalid &&
      (exact.method === "GET" || exact.method === "HEAD"),
    );
    let reason = hit.error ?? (works ? "HTTP 402 with payTo and amount" : `HTTP ${hit.status ?? "none"}`);
    if (!exact.ok) reason = `missing documented sample params: ${exact.missing.join(", ") || "required input"}`;
    else if (exactInvalid) reason = `unpaid exact probe: ${exactInvalid}`;
    else if (exact.ok && exactStatus !== 402) reason = `unpaid exact probe HTTP ${exactStatus ?? "none"} (need 402 before pay)`;
    else if (usable) reason = `HTTP 402 with sample inputs (${exact.source}) ${exact.url}`;
    candidates.push({
      url: exact.ok ? exact.url : door.url,
      listedUrl: door.url,
      method: exact.method,
      http_status: exactHit?.status ?? hit.status,
      elapsed_ms: exactHit?.elapsed_ms ?? hit.elapsed_ms,
      amountAtomic: quote?.amountAtomic ?? null,
      priceUsd: quote?.priceUsd ?? null,
      payTo: quote?.payTo ?? null,
      network: quote?.network ?? null,
      scheme: quote?.scheme ?? null,
      works,
      usable,
      exact,
      reason,
    });
  }
  const cheapest = pickCheapestUsable(candidates);
  return {
    wellKnown: wk,
    listed_n: listedPaidDoors(origin, wk.body).length,
    capped: listedPaidDoors(origin, wk.body).length > SELLER_DOOR_CAP,
    candidates,
    cheapest,
    abort_reason: cheapest
      ? null
      : "no listed GET door with documented sample inputs returned unpaid HTTP 402. Abort before any pay.",
  };
}

const WRAPPER_KEYS = new Set([
  "success",
  "settled",
  "transaction",
  "tx_hash",
  "txHash",
  "hash",
  "http_status",
  "payment-response",
  "_meta",
]);

export function paidBodyForContent(parsed) {
  const rec = parsed?.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body : null;
  const nested = rec && (rec.data ?? rec.result ?? rec.payload ?? rec.response);
  let body = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : rec;
  if (body && body === rec) {
    const copy = { ...rec };
    for (const key of WRAPPER_KEYS) delete copy[key];
    body = Object.keys(copy).length > 0 ? copy : null;
  }
  const failed = parsed?.settled?.value === false;
  const status = parsed?.http_status ?? (parsed?.exitCode === 0 && !failed && body ? 200 : parsed?.http_status);
  return {
    status,
    contentType: body ? "application/json" : "text/plain",
    bodyText: parsed?.bodyText ?? "",
    body,
  };
}

function runWrapper(bin, prefix, url, unpaidProbeMs = null) {
  const started = Date.now();
  const ran = spawnSync(bin, [...prefix, url], {
    encoding: "utf8",
    env: process.env,
    timeout: FETCH_MS,
  });
  const parsed = parsePaidWrapper(ran.stdout, ran.stderr, ran.status ?? 1);
  const wall = Math.max(0, Date.now() - started);
  const picked =
    parsed.elapsed_ms != null
      ? { ms: parsed.elapsed_ms, source: parsed.latency_source, field: parsed.latency_field }
      : pickPaidLatency({ unpaidProbeMs });
  return {
    ran,
    elapsed_ms: picked.ms,
    latency_source: picked.source,
    latency_field: picked.field ?? null,
    wrapper_wall_ms: wall,
    parsed,
  };
}

export function gradeFromPaidSeller({ parsed, elapsed_ms, streak_days }) {
  const invalid = invalidTargetReason({
    status: parsed.http_status,
    bodyText: parsed.bodyText,
  });
  if (invalid) {
    return {
      not_graded: true,
      reason: invalid,
      report: `not graded: ${invalid}`,
      grade: null,
    };
  }
  const paidOk =
    parsed.exitCode === 0 && parsed.http_status !== 402 && parsed.settled.value !== false
      ? true
      : parsed.http_status === 402 || parsed.exitCode !== 0 || parsed.settled.value === false
        ? false
        : null;
  const contentHit = classifyPaidContent(paidBodyForContent(parsed));
  const grade = computeGrade({
    paid_ok: paidOk,
    settled: parsed.settled.status === "measured" ? parsed.settled.value : null,
    settled_why: parsed.settled.why,
    tx_hash: parsed.tx_hash,
    content: contentHit.status === "measured" ? contentHit.class : null,
    content_why: contentHit.why,
    latency_ms: typeof elapsed_ms === "number" ? elapsed_ms : null,
    streak_days,
  });
  return { not_graded: false, reason: null, report: formatGrade(grade), grade };
}

export async function runDryRun(target, deskBase = DESK, maxUsdc = DEFAULT_MAX_USDC) {
  const hits = [];
  const board = await getJson(FREE_LEADERBOARD);
  const seller = matchLeaderboardSeller(board.body, target.host);
  hits.push({
    label: "free leaderboard",
    method: "GET",
    url: FREE_LEADERBOARD,
    status: board.status,
    error: board.error,
    elapsed_ms: board.elapsed_ms,
    note: board.body
      ? `seller_n=${board.body.seller_n ?? "unread"} last_run=${board.body.last_run ?? "unread"}`
      : null,
    snippet: snippetSeller(seller),
  });
  const compared = await compareSellerDoors(target.origin, {
    leaderboardUrl: typeof seller?.url === "string" ? seller.url : null,
  });
  hits.push({
    label: "seller well-known (unpaid, not an OCP door)",
    method: "GET",
    url: `${target.origin}/.well-known/x402`,
    status: compared.wellKnown.status,
    error: compared.wellKnown.error,
    elapsed_ms: compared.wellKnown.elapsed_ms,
    note: `listed paid doors=${compared.listed_n} probed=${compared.candidates.length}${compared.capped ? " (capped at 8)" : ""}`,
  });
  for (const cand of compared.candidates) {
    hits.push({
      label: `seller listed door ${cand.usable ? "USABLE" : cand.works ? "402-bare" : "no"}`,
      method: cand.method ?? "GET",
      url: cand.url,
      status: cand.http_status,
      elapsed_ms: cand.elapsed_ms,
      quote: cand.works
        ? {
            serviceName: null,
            priceUsd: cand.priceUsd,
            amountAtomic: cand.amountAtomic,
            network: cand.network,
            scheme: cand.scheme,
          }
        : null,
      note: cand.reason,
    });
  }
  const cheap = compared.cheapest;
  const plan = plannedCalls(target, PAID_DOORS, deskBase, { seller: cheap, maxUsdc });
  hits.push({
    label: "cheapest usable door (unpaid exact 402 with sample inputs)",
    method: cheap?.method ?? "GET",
    url: cheap?.url ?? "(none)",
    status: cheap?.http_status ?? null,
    snippet: cheap
      ? `cheapest=${cheap.priceUsd} amount=${cheap.amountAtomic} elapsed_ms=${cheap.elapsed_ms} payTo=${cheap.payTo} exact=${cheap.url}${plan.fullQuote.wouldPaySeller ? " — would pay once on --yes" : plan.fullQuote.refused_reason ? ` — ${plan.fullQuote.refused_reason}` : ""}`
      : compared.abort_reason ?? "no usable listed door. Empty set, not invented. Would not pay the target.",
  });
  for (const call of plan.paid) {
    const unpaid = await getJson(call.url);
    const quote = unpaid.status === 402 ? parse402Quote(unpaid.body, unpaid.status) : null;
    hits.push({
      label: `${call.desk ? "LOCAL unpublished" : "unpaid"} ${call.id}`,
      method: "GET",
      url: call.url,
      status: unpaid.status,
      error: unpaid.error,
      elapsed_ms: unpaid.elapsed_ms,
      quote,
      note: call.desk ? `Local unpublished Live Grade (${deskBase}). Not production. ${call.why}` : call.why,
    });
    if (call.sampleUrl) {
      const sample = await getJson(call.sampleUrl);
      hits.push({
        label: `${call.desk ? "LOCAL unpublished sample" : "free sample"} ${call.id}`,
        method: "GET",
        url: call.sampleUrl,
        status: sample.status,
        error: sample.error,
        elapsed_ms: sample.elapsed_ms,
        note: call.desk
          ? "Local unpublished sample. HTTP 200. No USDC. Shape only."
          : sample.status === 200
            ? "HTTP 200 sample. No USDC. Shape only, not this target's paid JSON."
            : null,
        snippet:
          sample.status === 200 && sample.body && typeof sample.body === "object"
            ? `keys=${Object.keys(sample.body).slice(0, 12).join(",")}`
            : null,
      });
    }
  }
  const streak_days = streakFromLeaderboard(seller);
  const not_graded = compared.abort_reason;
  const grade = not_graded ? null : computeGrade({ streak_days });
  return { plan, hits, compared, grade, text: formatDryRun(plan, hits, { grade, not_graded }) };
}

function parseArgs(argv) {
  let dryRun = false;
  let yes = false;
  let desk = process.env.X402_CHECK_DESK?.trim() || DESK;
  let maxUsdcRaw = process.env.X402_CHECK_MAX_USDC ?? "";
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--max-usdc") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        rest.push(arg);
      } else {
        maxUsdcRaw = next;
        i += 1;
      }
    } else if (arg === "--desk") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        rest.push(arg);
      } else {
        desk = next.replace(/\/$/, "");
        i += 1;
      }
    } else if (arg === "--help" || arg === "-h") rest.push(arg);
    else rest.push(arg);
  }
  return { dryRun, yes, desk, maxUsdcRaw, rest };
}

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error, exit: process.exit }) {
  const { dryRun, yes, desk, maxUsdcRaw, rest } = parseArgs(argv);
  if (rest.includes("--help") || rest.includes("--h") || rest.includes("-h") || rest.length === 0) {
    io.log(`Usage: node check.mjs [--dry-run|--yes] [--max-usdc ${DEFAULT_MAX_USDC}] [--desk http://127.0.0.1:4020] <https-origin-or-door>
Full per-run total = OCP ${quotePaidDoors().totalUsd} plus the target's cheapest working door (named), if under --max-usdc (default ${formatUsd(DEFAULT_MAX_USDC)} on the target door only).
--dry-run never pays. --yes required to pay. At most one target call. Sellers: ${CLAIM_URL}`);
    io.exit(rest.length === 0 ? 2 : 0);
    return;
  }
  const target = parseTarget(rest[0]);
  if (!target.ok) {
    io.error(target.error);
    io.exit(2);
    return;
  }
  const maxUsdc = parseMaxUsdc(maxUsdcRaw, DEFAULT_MAX_USDC);
  if (maxUsdc == null) {
    io.error("--max-usdc must be a non-negative number");
    io.exit(2);
    return;
  }
  if (dryRun && yes) {
    io.error("use either --dry-run or --yes, not both");
    io.exit(2);
    return;
  }
  if (dryRun) {
    const out = await runDryRun(target, desk, maxUsdc);
    io.log(out.text);
    io.exit(0);
    return;
  }
  const board = await getJson(FREE_LEADERBOARD);
  const boardRow = matchLeaderboardSeller(board.body, target.host);
  const compared = await compareSellerDoors(target.origin, {
    leaderboardUrl: typeof boardRow?.url === "string" ? boardRow.url : null,
  });
  const plan = plannedCalls(target, PAID_DOORS, desk, { seller: compared.cheapest, maxUsdc });
  io.log(printQuote(plan));
  if (!compared.cheapest) {
    io.error(`not graded: ${compared.abort_reason ?? "no usable target door"}. No USDC spent.`);
    io.exit(2);
    return;
  }
  if (!yes) {
    io.error("Refusing to pay. Re-run with --yes after you confirm the quote, or use --dry-run.");
    io.exit(2);
    return;
  }
  const cmd = process.env.X402_FETCH_COMMAND?.trim();
  if (!cmd) {
    io.error(
      "No standard x402 client. Set X402_FETCH_COMMAND to your existing x402 fetch wrapper (it must already hold the wallet). This skill does not accept or print private keys.",
    );
    io.exit(2);
    return;
  }
  const parts = cmd.split(/\s+/).filter(Boolean);
  const bin = parts[0];
  const prefix = parts.slice(1);
  if (!bin) {
    io.error("X402_FETCH_COMMAND is empty after split.");
    io.exit(2);
    return;
  }
  io.log("Paying with X402_FETCH_COMMAND (wallet stays in that client). At most one target call.");
  for (const call of plan.paid) {
    const { ran } = runWrapper(bin, prefix, call.url);
    io.log(`\n## paid ${call.id} wrapper exit=${ran.status}`);
    if (ran.stdout) io.log(redact(ran.stdout).slice(0, 4000));
    if (ran.stderr) io.error(redact(ran.stderr).slice(0, 1000));
  }
  let sellerPaid = null;
  if (plan.fullQuote.wouldPaySeller && compared.cheapest?.url) {
    io.log(`\n## paying target cheapest once: ${compared.cheapest.method ?? "GET"} ${compared.cheapest.url} ${compared.cheapest.priceUsd}`);
    sellerPaid = runWrapper(bin, prefix, compared.cheapest.url, compared.cheapest.elapsed_ms);
    io.log(
      `wrapper exit=${sellerPaid.ran.status} paid-call elapsed_ms=${sellerPaid.elapsed_ms ?? "unread"} source=${sellerPaid.latency_source}${sellerPaid.latency_field ? ` field=${sellerPaid.latency_field}` : ""} wrapper_wall_ms=${sellerPaid.wrapper_wall_ms} (wall is not graded)`,
    );
    if (sellerPaid.parsed.tx_hash) io.log(`tx_hash=${sellerPaid.parsed.tx_hash}`);
    io.log(`settled=${sellerPaid.parsed.settled.status} ${sellerPaid.parsed.settled.value ?? "unread"} (${sellerPaid.parsed.settled.why})`);
    if (sellerPaid.ran.stdout) io.log(redact(sellerPaid.ran.stdout).slice(0, 4000));
    if (sellerPaid.ran.stderr) io.error(redact(sellerPaid.ran.stderr).slice(0, 1000));
  } else {
    io.log(`\n## target not paid: ${plan.fullQuote.refused_reason ?? "no usable listed door"}`);
  }
  const streak_days = streakFromLeaderboard(boardRow);
  io.log("\n## client-side grade (published leaderboard formula; unread omitted, not zeroed)");
  if (!sellerPaid) {
    io.log(`not graded: target was not paid this run`);
    io.exit(0);
    return;
  }
  const graded = gradeFromPaidSeller({ parsed: sellerPaid.parsed, elapsed_ms: sellerPaid.elapsed_ms, streak_days });
  io.log(graded.report);
  io.exit(graded.not_graded ? 2 : 0);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "failed");
    process.exit(1);
  });
}
