#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  airports: "canada_fltplan_airports.txt",
  waypoints: "waypoints.csv",
  navaids: "navaids.csv",
  airportsCsv: "airports.csv",
  chartsJson: "fltplan_canada_charts.json",
  report: "canada_fltplan_procedures_report.json",
  batchSize: 20,
  delayMs: 300,
};

const NUMBER_WORDS = new Map([
  ["ZERO", 0], ["ONE", 1], ["TWO", 2], ["THREE", 3], ["FOUR", 4],
  ["FIVE", 5], ["SIX", 6], ["SEVEN", 7], ["EIGHT", 8], ["NINE", 9],
  ["TEN", 10], ["ELEVEN", 11], ["TWELVE", 12], ["THIRTEEN", 13],
  ["FOURTEEN", 14], ["FIFTEEN", 15], ["SIXTEEN", 16], ["SEVENTEEN", 17],
  ["EIGHTEEN", 18], ["NINETEEN", 19], ["TWENTY", 20], ["THIRTY", 30],
  ["FORTY", 40], ["FIFTY", 50], ["SIXTY", 60], ["SEVENTY", 70],
  ["EIGHTY", 80], ["NINETY", 90],
]);

const PROC_ORDER = ["SID", "STAR"];
const NAVAID_NAME_ALIASES = new Map([
  ["CYHU|STHUBERT", "ZHU"],
]);

function usage() {
  console.log(`Usage:
  node tools/import_fltplan_canada_procedures.mjs [options]

Options:
  --airports <file>       Airport list file (default: ${DEFAULTS.airports})
  --waypoints <file>      Waypoints CSV (default: ${DEFAULTS.waypoints})
  --navaids <file>        Navaids CSV (default: ${DEFAULTS.navaids})
  --airports-csv <file>   OurAirports CSV for fallback airport coordinates
  --charts-json <file>    Collected chart JSON cache/output
  --report <file>         Import report JSON output
  --collect-only          Collect FltPlan chart rows but do not update CSVs
  --merge-existing        When collecting, keep existing chart rows if they are richer
  --update-only           Update CSVs from --charts-json without network
  --dry-run               Report changes without writing CSVs
  --no-network            Do not call FltPlan
  --only <ICAO,...>       Limit to specific airports
  --limit <n>             Limit airport count for testing
  --batch-size <n>        Re-login after each batch (default: ${DEFAULTS.batchSize})
  --delay-ms <n>          Delay between airport requests (default: ${DEFAULTS.delayMs})
  --help                  Show this help

Credentials:
  Set FLTPLAN_USERNAME and FLTPLAN_PASSWORD in your local shell. They are only
  read by this process and are not written to disk.`);
}

function parseArgs(argv) {
  const args = {
    ...DEFAULTS,
    collectOnly: false,
    mergeExisting: false,
    updateOnly: false,
    dryRun: false,
    noNetwork: false,
    only: null,
    limit: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--collect-only") args.collectOnly = true;
    else if (arg === "--merge-existing") args.mergeExisting = true;
    else if (arg === "--update-only") args.updateOnly = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-network") args.noNetwork = true;
    else if (arg === "--airports") args.airports = requireValue(argv, ++i, arg);
    else if (arg === "--waypoints") args.waypoints = requireValue(argv, ++i, arg);
    else if (arg === "--navaids") args.navaids = requireValue(argv, ++i, arg);
    else if (arg === "--airports-csv") args.airportsCsv = requireValue(argv, ++i, arg);
    else if (arg === "--charts-json") args.chartsJson = requireValue(argv, ++i, arg);
    else if (arg === "--report") args.report = requireValue(argv, ++i, arg);
    else if (arg === "--only") args.only = requireValue(argv, ++i, arg).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === "--limit") args.limit = Number(requireValue(argv, ++i, arg));
    else if (arg === "--batch-size") args.batchSize = Number(requireValue(argv, ++i, arg));
    else if (arg === "--delay-ms") args.delayMs = Number(requireValue(argv, ++i, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.collectOnly && args.updateOnly) {
    throw new Error("--collect-only and --update-only cannot be used together");
  }
  return args;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function readAirportList(file) {
  const text = fs.readFileSync(file, "utf8");
  const seen = new Set();
  const airports = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/\b[A-Z0-9]{3,4}\b/i);
    if (!match) continue;
    const icao = match[0].toUpperCase();
    if (!seen.has(icao)) {
      seen.add(icao);
      airports.push(icao);
    }
  }
  return airports;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function stringifyCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function headerIndex(headers, names) {
  const lowered = headers.map(h => h.trim().toLowerCase());
  for (const name of names) {
    const idx = lowered.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  throw new Error(`Missing CSV column: ${names.join(" / ")}`);
}

function loadCsvFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${file} is empty`);
  return { text, rows, headers: rows[0] };
}

function makeWaypointIndexes(rows, headers) {
  const idx = {
    countryCode: headerIndex(headers, ["Country Code"]),
    countryName: headerIndex(headers, ["Country Name"]),
    ident: headerIndex(headers, ["Ident"]),
    latitude: headerIndex(headers, ["Latitude"]),
    longitude: headerIndex(headers, ["Longitude"]),
    procedures: headerIndex(headers, ["Procedures"]),
  };
  const byIdent = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row[idx.countryCode] || "").toUpperCase() !== "CA") continue;
    const ident = normalizeKey(row[idx.ident]);
    if (!ident) continue;
    if (!byIdent.has(ident)) byIdent.set(ident, []);
    byIdent.get(ident).push(i);
  }
  return { idx, byIdent };
}

function makeNavaidIndexes(rows, headers) {
  const idx = {
    ident: headerIndex(headers, ["ident"]),
    name: headerIndex(headers, ["name"]),
    type: headerIndex(headers, ["type"]),
    latitude: headerIndex(headers, ["latitude"]),
    longitude: headerIndex(headers, ["longitude"]),
    countryCode: headerIndex(headers, ["country code", "country_code"]),
    airport: headerIndex(headers, ["airport"]),
    procedures: headerIndex(headers, ["procedures"]),
  };
  const byIdent = new Map();
  const byName = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row[idx.countryCode] || "").toUpperCase() !== "CA") continue;
    const ident = normalizeKey(row[idx.ident]);
    if (ident && !byIdent.has(ident)) byIdent.set(ident, i);
    const name = normalizeCompact(row[idx.name]);
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(i);
    }
  }
  return { idx, byIdent, byName, rows };
}

function loadAirportCoords(file) {
  const csv = loadCsvFile(file);
  const headers = csv.headers;
  const idx = {
    ident: headerIndex(headers, ["ident"]),
    icao: headerIndex(headers, ["icao_code"]),
    gps: headerIndex(headers, ["gps_code"]),
    local: headerIndex(headers, ["local_code"]),
    lat: headerIndex(headers, ["latitude_deg"]),
    lon: headerIndex(headers, ["longitude_deg"]),
  };
  const coords = new Map();
  for (let i = 1; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const lat = Number(row[idx.lat]);
    const lon = Number(row[idx.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    for (const keyIdx of [idx.ident, idx.icao, idx.gps, idx.local]) {
      const key = (row[keyIdx] || "").trim().toUpperCase();
      if (key && !coords.has(key)) coords.set(key, { lat, lon });
    }
  }
  return coords;
}

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function parseProcedureField(field) {
  const out = new Map();
  for (const part of String(field || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const type = trimmed.slice(0, colon).trim().toUpperCase();
    const entries = trimmed.slice(colon + 1)
      .split("|")
      .map(s => s.trim().replace(/^(SID|STAR):/i, ""))
      .filter(Boolean);
    if (!out.has(type)) out.set(type, []);
    for (const entry of entries) {
      if (!out.get(type).includes(entry)) out.get(type).push(entry);
    }
  }
  return out;
}

function stringifyProcedureField(map) {
  const types = [...PROC_ORDER, ...[...map.keys()].filter(k => !PROC_ORDER.includes(k)).sort()];
  const sections = [];
  for (const type of types) {
    const entries = map.get(type) || [];
    if (entries.length) sections.push(`${type}:${entries.join("|")}`);
  }
  return sections.join(";");
}

function addProcedureToRow(row, procIdx, proc) {
  const map = parseProcedureField(row[procIdx]);
  if (!map.has(proc.type)) map.set(proc.type, []);
  const arr = map.get(proc.type);
  const entry = `${proc.displayName}~${proc.type === "SID" ? "DEPARTURE" : "ARRIVAL"}`;
  if (arr.includes(entry)) return false;
  arr.push(entry);
  row[procIdx] = stringifyProcedureField(map);
  return true;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setFromHeaders(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const first = value.split(";")[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=)/g).map(s => s.trim()).filter(Boolean);
}

async function request(url, options = {}, jar = new CookieJar(), redirects = 0) {
  const headers = { ...(options.headers || {}) };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  let body = options.body;
  if (body && !(body instanceof URLSearchParams) && typeof body === "object") {
    body = new URLSearchParams(body);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(url, {
    ...options,
    headers,
    body,
    redirect: "manual",
  });
  jar.setFromHeaders(res.headers);
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects > 10) throw new Error(`Too many redirects from ${url}`);
    const location = res.headers.get("location");
    if (!location) return { res, text: await res.text(), jar, url };
    const next = new URL(location, url).toString();
    const method = res.status === 303 ? "GET" : (options.method || "GET");
    return request(next, { ...options, method, body: method === "GET" ? undefined : body }, jar, redirects + 1);
  }
  return { res, text: await res.text(), jar, url };
}

function extractInputValue(html, name) {
  const re = new RegExp(`<input\\b[^>]*name\\s*=\\s*["']?${escapeRegExp(name)}["']?[^>]*>`, "i");
  const input = html.match(re)?.[0] || "";
  return input.match(/\bvalue\s*=\s*["']?([^"'\s>]+)/i)?.[1] || "";
}

async function loginFltPlan(username, password) {
  const jar = new CookieJar();
  await request("https://www.fltplan.com/index.htm", { method: "GET" }, jar);
  const login = await request("https://www.fltplan.com/AwRegUserCk.exe?a=1", {
    method: "POST",
    headers: { "User-Agent": "Mozilla/5.0" },
    body: {
      username,
      password,
      Browser: "Mozilla/5.0",
    },
  }, jar);
  if (/login=0|Incorrect username or password|temporarily locked/i.test(login.text)) {
    throw new Error("FltPlan login failed");
  }
  const crn10 = extractInputValue(login.text, "CRN10") || "1";
  const carryUname = extractInputValue(login.text, "CARRYUNAME") || username;
  return { jar, crn10, carryUname };
}

async function collectCharts(airports, args) {
  const username = process.env.FLTPLAN_USERNAME;
  const password = process.env.FLTPLAN_PASSWORD;
  if (!username || !password) {
    throw new Error("Set FLTPLAN_USERNAME and FLTPLAN_PASSWORD to collect Canadian CAP chart lists from FltPlan");
  }

  const collected = {
    source: "FltPlan Digital Charts",
    collectedAt: new Date().toISOString(),
    airportCount: airports.length,
    airports: {},
  };

  let session = null;
  for (let i = 0; i < airports.length; i++) {
    if (!session || (Number.isFinite(args.batchSize) && args.batchSize > 0 && i % args.batchSize === 0)) {
      session = await loginFltPlan(username, password);
    }
    const airport = airports[i];
    process.stdout.write(`[${i + 1}/${airports.length}] ${airport}... `);
    const page = await request("https://www.FltPlan.com/AwListAppPlates.exe?a=1", {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0" },
      body: {
        CRN10: session.crn10,
        CARRYUNAME: session.carryUname,
        MODE: "SEARCH",
        AIRPORTSEL: airport,
      },
    }, session.jar);

    if (/Registered User to access Canadian Approach Plates/i.test(page.text)) {
      throw new Error("FltPlan returned the registered-user gate after login; check the account/session");
    }

    const charts = extractChartEntries(page.text, airport);
    collected.airports[airport] = charts;
    console.log(`${charts.length} SID/STAR candidates`);
    await sleep(Math.max(0, Number(args.delayMs) || 0));
  }

  const merged = args.mergeExisting ? mergeCollectedCharts(args.chartsJson, collected) : collected;
  fs.writeFileSync(args.chartsJson, JSON.stringify(merged, null, 2));
  return merged;
}

function mergeCollectedCharts(file, collected) {
  if (!fs.existsSync(file)) return collected;
  const existing = readJsonFile(file);
  const merged = {
    source: collected.source || existing.source || "FltPlan Digital Charts",
    collectedAt: collected.collectedAt || new Date().toISOString(),
    mergedAt: new Date().toISOString(),
    airportCount: Math.max(existing.airportCount || 0, collected.airportCount || 0),
    airports: { ...(existing.airports || {}) },
  };
  for (const [airport, entries] of Object.entries(collected.airports || {})) {
    const current = merged.airports[airport] || [];
    merged.airports[airport] = entries.length >= current.length ? entries : current;
  }
  return merged;
}

function extractChartEntries(html, airport) {
  const decoded = decodeEntities(html);
  const chunks = decoded.match(/<tr\b[\s\S]*?<\/tr>/gi) || [decoded];
  const entries = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (!/(SID|STAR|_ARR_|_DEP_|ARRIVAL|DEPARTURE|PDFLIST|\.pdf)/i.test(chunk)) continue;
    const text = stripTags(chunk).replace(/\s+/g, " ").trim();
    const refs = extractPdfRefs(chunk);
    if (!refs.length && !/(SID|STAR|ARRIVAL|DEPARTURE|\bARR\b|\bDEP\b)/i.test(text)) continue;
    for (const ref of refs.length ? refs : [""]) {
      const cleanRef = sanitizeRef(ref);
      const key = `${cleanRef}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { airport, text, ref: cleanRef };
      if (isSidStarCandidate(entry)) entries.push(entry);
    }
  }
  return entries;
}

function sanitizeRef(ref) {
  const typeChart = extractTypeChart(ref);
  if (typeChart) return typeChart;
  return String(ref || "")
    .replace(/([?&](?:CRN10|CARRYUNAME)=)[^&\s>]*/gi, "$1REDACTED")
    .replace(/([?&](?:USER|PASSWORD|PASS)=)[^&\s>]*/gi, "$1REDACTED");
}

function extractPdfRefs(html) {
  const refs = [];
  const patterns = [
    /\b(?:href|src)\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi,
    /\b(?:href|src)\s*=\s*([^"'\s>]+?\.pdf(?:\?[^"'\s>]*)?)/gi,
    /\bname\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi,
    /\bname\s*=\s*([^"'\s>]+?\.pdf(?:\?[^"'\s>]*)?)/gi,
    /\bvalue\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi,
    /\bvalue\s*=\s*([^"'\s>]+?\.pdf(?:\?[^"'\s>]*)?)/gi,
    /https?:\/\/[^"'<>\s]+?\.pdf(?:\?[^"'<>\s]*)?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      refs.push(match[1] || match[0]);
    }
  }
  return [...new Set(refs.map(s => s.replace(/&amp;/gi, "&")))];
}

function isSidStarCandidate(entry) {
  const raw = `${entry.text || ""} ${entry.ref || ""}`.toUpperCase();
  if (/\bRESTRICTED\b/.test(raw)) return false;
  if (/_SID[-_]|_STAR[-_]|\bSID\b|\bSTAR\b/.test(raw)) return true;
  if (/_DEP_|_ARR_|\bDEPARTURE\b|\bARRIVAL\b/.test(raw)) return true;
  return false;
}

function isIgnoredChart(entry) {
  const raw = `${entry?.text || ""} ${entry?.ref || ""}`.toUpperCase();
  return /\bRESTRICTED\b/.test(raw);
}

function stripTags(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const n = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : _;
  });
}

function parseProcedure(entry) {
  const refBase = chartBaseName(entry.ref || "");
  const raw = `${refBase} ${entry.text || ""}`;
  if (/\bRESTRICTED\b/i.test(raw)) return null;
  const type = /(?:_STAR[-_]|\bSTARS?\b|_ARR_|\bARR(?:IVALS?)?\b)/i.test(raw)
    ? "STAR"
    : /(?:_SID[-_]|\bSIDS?\b|_DEP_|\bDEP(?:ARTURES?)?\b)/i.test(raw)
      ? "SID"
      : null;
  if (!type) return null;

  const fromFilename = parseProcedureNameFromFilename(entry.airport, refBase, type);
  const fromText = parseProcedureNameFromText(entry.text, type);
  const displayName = fromFilename?.displayName || fromText?.displayName;
  const displayRoot = fromFilename?.displayRoot || fromText?.displayRoot;
  if (!displayName || !displayRoot) return null;

  const procCode = codeFromText(entry.text) || codeFromFilename(refBase, type);
  const codeRoot = procCode ? rootFromCode(procCode) : "";

  return {
    airport: entry.airport,
    type,
    displayName,
    displayRoot,
    code: procCode || "",
    codeRoot,
    sourceRef: entry.ref || "",
    sourceText: entry.text || "",
  };
}

function baseNameFromRef(ref) {
  if (!ref) return "";
  const noQuery = ref.split("?")[0];
  const last = noQuery.split(/[\\/]/).pop() || noQuery;
  try {
    return decodeURIComponent(last).replace(/\.pdf$/i, "");
  } catch {
    return last.replace(/\.pdf$/i, "");
  }
}

function chartBaseName(ref) {
  const typeChart = extractTypeChart(ref);
  return baseNameFromRef(typeChart || ref);
}

function extractTypeChart(ref) {
  if (!ref) return "";
  try {
    const parsed = new URL(ref, "https://www.fltplan.com/");
    const value = parsed.searchParams.get("TYPECHART");
    if (value) return value;
  } catch {}
  const match = String(ref).match(/[?&]TYPECHART=([^&\s>]+?\.pdf(?:\?[^&\s>]*)?)/i);
  return match ? match[1] : "";
}

function parseProcedureNameFromFilename(airport, base, type) {
  if (!base) return null;
  let name = base.toUpperCase();
  name = name.replace(new RegExp(`^${escapeRegExp(airport)}[_ -]*`, "i"), "");
  const marker = type === "STAR" ? "_ARR_" : "_DEP_";
  const markerAt = name.indexOf(marker);
  if (markerAt < 0) return null;
  const before = cleanProcedurePrefix(name.slice(0, markerAt).replace(/[_-]+/g, " ").trim());
  return parseNameAndNumber(before);
}

function parseProcedureNameFromText(text, type) {
  const marker = type === "STAR" ? "(?:ARR|ARRIVAL)" : "(?:DEP|DEPARTURE)";
  const numberAlternation = [...NUMBER_WORDS.keys()].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`\\b([A-Z][A-Z0-9 /'&.-]*?)\\s+(${numberAlternation}|\\d{1,2})\\s+${marker}\\b`, "i");
  const match = String(text || "").toUpperCase().match(re);
  if (!match) return null;
  return parseNameAndNumber(cleanProcedurePrefix(`${match[1]} ${match[2]}`.replace(/[^\w ]+/g, " ")));
}

function cleanProcedurePrefix(value) {
  return normalizeKey(value)
    .replace(/^(?:DP\s+)?SIDS?\s+DEPARTURES?\s+/i, "")
    .replace(/^(?:DP\s+)?SID\s+/i, "")
    .replace(/^(?:STAR\s+)?STARS?\s+ARRIVALS?\s+/i, "")
    .replace(/^ARRIVALS?\s+/i, "")
    .trim();
}

function parseNameAndNumber(value) {
  const words = normalizeKey(value).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let number = null;
  let rootWords = words;
  const last = words[words.length - 1];
  if (/^\d{1,2}$/.test(last)) {
    number = Number(last);
    rootWords = words.slice(0, -1);
  } else if (NUMBER_WORDS.has(last)) {
    number = NUMBER_WORDS.get(last);
    rootWords = words.slice(0, -1);
    if (rootWords.length && NUMBER_WORDS.has(rootWords[rootWords.length - 1]) && NUMBER_WORDS.get(rootWords[rootWords.length - 1]) >= 20 && number < 10) {
      const tens = NUMBER_WORDS.get(rootWords[rootWords.length - 1]);
      number += tens;
      rootWords = rootWords.slice(0, -1);
    }
  }
  const displayRoot = rootWords.join(" ").trim();
  if (!displayRoot) return null;
  const displayName = number == null ? displayRoot : `${displayRoot} ${number}`;
  return { displayRoot, displayName };
}

function codeFromText(text) {
  const matches = [...String(text || "").toUpperCase().matchAll(/\(([A-Z0-9]{2,8})(?:\.([A-Z0-9]{2,8}))?\)/g)];
  if (!matches.length) return "";
  const last = matches[matches.length - 1];
  return last[2] || last[1] || "";
}

function codeFromFilename(base, type) {
  if (!base) return "";
  const upper = base.toUpperCase();
  const marker = type === "STAR" ? "_ARR_" : "_DEP_";
  const at = upper.indexOf(marker);
  if (at < 0) return "";
  const rest = upper.slice(at + marker.length).replace(/_(SID|STAR)[-_].*$/i, "");
  const tokens = rest.split(/[_\s-]+/).filter(Boolean);
  const candidates = tokens.filter(t => /^[A-Z0-9]{2,8}\d[A-Z]?$/.test(t));
  if (!candidates.length) return "";
  return type === "STAR" ? candidates[candidates.length - 1] : candidates[0];
}

function rootFromCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/\d+[A-Z]?$/i, "");
}

function applyProcedures(collected, args) {
  const waypoints = loadCsvFile(args.waypoints);
  const navaids = loadCsvFile(args.navaids);
  const coords = loadAirportCoords(args.airportsCsv);
  const w = makeWaypointIndexes(waypoints.rows, waypoints.headers);
  const n = makeNavaidIndexes(navaids.rows, navaids.headers);
  const originalWaypointRowCount = waypoints.rows.length;

  const report = {
    source: collected.source || "FltPlan Digital Charts",
    collectedAt: collected.collectedAt || null,
    importedAt: new Date().toISOString(),
    airports: Object.keys(collected.airports || {}).length,
    chartCandidates: 0,
    proceduresParsed: 0,
    proceduresAdded: 0,
    waypointsUpdated: 0,
    navaidsUpdated: 0,
    newWaypoints: 0,
    skippedNonWaypoint: 0,
    unresolved: [],
    changes: [],
  };

  const touchedWaypoints = new Set();
  const touchedNavaids = new Set();
  const seenProcedure = new Set();

  for (const [airport, entries] of Object.entries(collected.airports || {})) {
    for (const entry of entries || []) {
      report.chartCandidates++;
      const proc = parseProcedure({ airport, ...entry });
      if (!proc) {
        if (isIgnoredChart(entry)) continue;
        report.unresolved.push({ airport, reason: "procedure-parse-failed", entry });
        continue;
      }
      const procKey = `${airport}|${proc.type}|${proc.displayName}`;
      if (seenProcedure.has(procKey)) continue;
      seenProcedure.add(procKey);
      report.proceduresParsed++;

      const target = findTarget(proc, w, n);
      if (target.kind === "navaid") {
        const row = navaids.rows[target.rowIndex];
        if (addProcedureToRow(row, n.idx.procedures, proc)) {
          report.proceduresAdded++;
          touchedNavaids.add(target.rowIndex);
          report.changes.push({ airport, target: "navaids.csv", ident: row[n.idx.ident], procedure: `${proc.type}:${proc.displayName}` });
        }
      } else if (target.kind === "waypoint") {
        const row = waypoints.rows[target.rowIndex];
        if (addProcedureToRow(row, w.idx.procedures, proc)) {
          report.proceduresAdded++;
          touchedWaypoints.add(target.rowIndex);
          report.changes.push({ airport, target: "waypoints.csv", ident: row[w.idx.ident], procedure: `${proc.type}:${proc.displayName}` });
        }
      } else if (target.kind === "new-waypoint") {
        const airportCoords = coords.get(airport);
        if (!airportCoords) {
          report.unresolved.push({ airport, reason: "missing-airport-coordinates", procedure: proc });
          continue;
        }
        const newRow = makeNewWaypointRow(proc.displayRoot, airportCoords);
        addProcedureToRow(newRow, w.idx.procedures, proc);
        const rowIndex = waypoints.rows.length;
        waypoints.rows.push(newRow);
        const key = normalizeKey(proc.displayRoot);
        if (!w.byIdent.has(key)) w.byIdent.set(key, []);
        w.byIdent.get(key).push(rowIndex);
        report.proceduresAdded++;
        report.newWaypoints++;
        touchedWaypoints.add(rowIndex);
        report.changes.push({ airport, target: "waypoints.csv", ident: proc.displayRoot, procedure: `${proc.type}:${proc.displayName}`, status: "new" });
      } else if (target.kind === "skipped-non-waypoint") {
        report.skippedNonWaypoint++;
      }
    }
  }

  moveNewWaypointRowsIntoCanadaBlock(waypoints.rows, originalWaypointRowCount, w.idx.countryCode, w.idx.ident);

  report.waypointsUpdated = touchedWaypoints.size;
  report.navaidsUpdated = touchedNavaids.size;

  if (!args.dryRun) {
    fs.writeFileSync(args.waypoints, stringifyCsv(waypoints.rows), "utf8");
    fs.writeFileSync(args.navaids, stringifyCsv(navaids.rows), "utf8");
  }
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2), "utf8");
  return report;
}

function findTarget(proc, w, n) {
  const display = normalizeKey(proc.displayRoot);
  const compactDisplay = display.replace(/\s+/g, "");
  const compactName = normalizeCompact(proc.displayRoot);
  const codeRoot = normalizeKey(proc.codeRoot);
  const candidates = [display, compactDisplay, codeRoot].filter(Boolean);

  if (codeRoot && codeRoot.length <= 3 && n.byIdent.has(codeRoot)) {
    return { kind: "navaid", rowIndex: n.byIdent.get(codeRoot) };
  }
  for (const key of candidates) {
    if (w.byIdent.has(key)) return { kind: "waypoint", rowIndex: w.byIdent.get(key)[0] };
  }
  for (const key of candidates) {
    if (n.byIdent.has(key)) return { kind: "navaid", rowIndex: n.byIdent.get(key) };
  }
  const aliasIdent = NAVAID_NAME_ALIASES.get(`${proc.airport}|${compactName}`);
  if (aliasIdent && n.byIdent.has(aliasIdent)) {
    return { kind: "navaid", rowIndex: n.byIdent.get(aliasIdent) };
  }
  if (n.byName.has(compactName)) {
    const rows = n.byName.get(compactName);
    const sameAirport = rows.filter(rowIndex => (n.rows?.[rowIndex]?.[n.idx.airport] || "") === proc.airport);
    const rowIndex = pickBestNavaidRow(sameAirport.length ? sameAirport : rows, n);
    if (rowIndex != null) return { kind: "navaid", rowIndex };
  }
  if (!/^[A-Z]{5}$/.test(compactDisplay)) return { kind: "skipped-non-waypoint" };
  return { kind: "new-waypoint" };
}

function moveNewWaypointRowsIntoCanadaBlock(rows, originalRowCount, countryCodeIndex, identIndex) {
  if (!Number.isInteger(originalRowCount) || originalRowCount >= rows.length) return;
  const newRows = rows.slice(originalRowCount).filter(row => row && row.length);
  rows.splice(originalRowCount, rows.length - originalRowCount);
  if (!newRows.length) return;
  newRows.sort((a, b) => String(a[identIndex] || "").localeCompare(String(b[identIndex] || ""), "en"));
  const insertAt = findLastCountryRowIndex(rows, countryCodeIndex, "CA") + 1;
  rows.splice(insertAt > 0 ? insertAt : rows.length, 0, ...newRows);
}

function findLastCountryRowIndex(rows, countryCodeIndex, countryCode) {
  let found = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[countryCodeIndex] || "").toUpperCase() === countryCode) found = i;
  }
  return found;
}

function normalizeCompact(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function pickBestNavaidRow(rowIndexes, n) {
  if (!rowIndexes || !rowIndexes.length) return null;
  const rank = rowIndex => {
    const type = String(n.rows[rowIndex][n.idx.type] || "").toUpperCase();
    if (type.includes("VOR") || type.includes("VORTAC") || type.includes("TACAN")) return 1;
    if (type.includes("NDB")) return 2;
    if (type.includes("DME")) return 3;
    return 4;
  };
  return [...rowIndexes].sort((a, b) => rank(a) - rank(b))[0];
}

function makeNewWaypointRow(ident, coords) {
  return [
    "CA",
    "Canada",
    ident,
    formatDms(coords.lat, true),
    formatDms(coords.lon, false),
    "",
  ];
}

function formatDms(value, isLat) {
  const degChar = String.fromCharCode(0xfffd);
  const hemi = isLat ? (value < 0 ? "S" : "N") : (value < 0 ? "W" : "E");
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const degText = String(deg).padStart(isLat ? 2 : 3, "0");
  const minText = String(min).padStart(2, "0");
  const secText = sec.toFixed(2).padStart(5, "0");
  return `${degText}${degChar} ${minText}' ${secText} ${hemi}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  let airports = readAirportList(args.airports);
  if (args.only) {
    const only = new Set(args.only);
    airports = airports.filter(airport => only.has(airport));
  }
  if (Number.isFinite(args.limit) && args.limit > 0) airports = airports.slice(0, args.limit);
  if (!airports.length) throw new Error("No airports selected");

  let collected = null;
  if (args.updateOnly || args.noNetwork) {
    collected = readJsonFile(args.chartsJson);
  } else {
    collected = await collectCharts(airports, args);
  }

  if (!args.collectOnly) {
    const report = applyProcedures(collected, args);
    console.log(JSON.stringify({
      airports: report.airports,
      chartCandidates: report.chartCandidates,
      proceduresParsed: report.proceduresParsed,
      proceduresAdded: report.proceduresAdded,
      waypointsUpdated: report.waypointsUpdated,
      navaidsUpdated: report.navaidsUpdated,
      newWaypoints: report.newWaypoints,
      unresolved: report.unresolved.length,
      dryRun: args.dryRun,
    }, null, 2));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

function readJsonFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}
