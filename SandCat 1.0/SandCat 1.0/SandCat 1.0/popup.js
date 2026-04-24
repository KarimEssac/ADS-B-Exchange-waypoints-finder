
  const FIX_PROCEDURE_MAP = {};
  const FIX_AIRWAY_MAP = {};
  let FACILITY_FREQ_INDEX = [];
let PROC_FIX_MASTER = [];
let LAST_LOADED_AIRPORT = null;
let AIRPORT_FREQ_INDEX = null;


window.addEventListener("error", e => {
  console.error("POPUP CRASH:", e.message, "at", e.filename, ":", e.lineno);
});

window.addEventListener("unhandledrejection", e => {
  console.error("PROMISE CRASH:", e.reason);
});
window.originalConsoleLog = console.log;

console.log = (...args) => {
  window.__popupLog = window.__popupLog || [];
  window.__popupLog.push(args);
  window.__popupLog = window.__popupLog.slice(-200);
  window.originalConsoleLog(...args);
};

window.addEventListener("message", async (event) => {

  const msg = event.data;
  if (!msg) return;

  /* =============================
     STREAMED FIX
  ============================= */

  if (msg.type === "ROUTE_FIX_STREAM") {
    if (ACTIVE_ROUTE_RENDER > 0) return;
    const list = document.getElementById("routeResults");
    if (!list) return;

    const row = document.createElement("div");
    row.className = "routeFix";

    const fx = String(msg.fix || "").toUpperCase();
    const nav = NAVAIDS?.[fx];

const displayText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

const copyText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

let label = displayText;

if (nav?.name) {
  label = `${displayText} (${fx})`;
}

const procs = FIX_PROCEDURE_MAP?.[fx.toUpperCase()];

if(procs?.length){

  const unique = new Map();

  for(const p of procs){

    const name = p.procDisplay || p.proc || "";

    if(!unique.has(name)){
      unique.set(name,p.type);
    }

  }

  for(const [name,type] of unique){

    let cls = "procSID";

    if(type === "STAR") cls = "procSTAR";
    if(type === "IAP") cls = "procAPP";

    label += ` <span class="procTag ${cls}">${name}</span>`;
  }

}


const airways = FIX_AIRWAY_MAP?.[fx];

if(airways?.length){

  const unique = [...new Set(airways)];

  for(const aw of unique){

    label += ` <span class="procTag procAIRWAY">${aw}</span>`;

  }

}

    row.innerHTML = label;

row.addEventListener("click", async () => {
  await copyWithFeedback(row, copyText);
});

    list.appendChild(row);

}
  


  /* =============================
     FULL ROUTE DATA
  ============================= */

  if (msg.type === "ACTIVE_FLIGHT_DATA") {
    if(msg.data?.routeParts){

  for(const part of msg.data.routeParts){

    if(!part.airway) continue;

    for(const fix of part.fixes){

      const key = fix.toUpperCase();

      if(!FIX_AIRWAY_MAP[key]){
        FIX_AIRWAY_MAP[key] = [];
      }

      FIX_AIRWAY_MAP[key].push(part.airway);
    }
  }
}

    const fixes = msg.data?.adsb_active_flight_fixes || [];

    await applyActiveFlightFixesToUI(fixes);

    renderFlightAnalysis(
      null,
      fixes,
      { ident: msg.data.adsb_active_flight_origin },
      { ident: msg.data.adsb_active_flight_destination },
      null
    );

  }

  /* =============================
     CLEAR ROUTE
  ============================= */

  if (msg.type === "CLEAR_ROUTE") {

    const list = document.getElementById("routeResults");
    if (list) list.innerHTML = "";

  }

});

const $ = (id) => document.getElementById(id);
let LAST_RESULTS = [];
let LAST_CENTER = "";
let MASTER_RESULTS = [];
let WAYPOINT_SEARCH_TOKEN = 0;
let waypointDebounce = null;
let NAVAIDS = null; // { IDENT: {name,type,freq,...} }
let ACTIVE_ROUTE_RENDER = 0;


const AIRPORT_NAME_MAP = {};

function buildAirportNameMap(){

  for (const k in AIRPORT_NAME_MAP){
    delete AIRPORT_NAME_MAP[k];
  }

  for(const a of MASTER_RESULTS || []){

    const ident = String(a.ident || "").toUpperCase();
    if(!ident) continue;

    AIRPORT_NAME_MAP[ident] = a.name || "";
  }

}



chrome.storage.local.get("adsb_active_flight_callsign", (data) => {
  window.activeFlightCallsign = data.adsb_active_flight_callsign || null;
});



async function maybeQueryNearby(ident) {

  ident = String(ident || "").trim().toUpperCase();
  if (!ident) return;

  const {
    nearby_cache,
    last_query_signature
  } = await chrome.storage.local.get([
    "nearby_cache",
    "last_query_signature"
  ]);

  const radius_nm =
    Number(document.getElementById("radiusNm")?.value || 0);

  const requestedMax =
    Number(document.getElementById("maxResults")?.value || 25);

  const hideNoApp =
    document.getElementById("filterNoApproaches")?.checked === true;

  const mainOnly =
    document.getElementById("mainOnlyToggle")?.checked === true;

  const typesMode =
    document.getElementById("types")?.value;

  const includeHelipads =
    typesMode === "helipads_only" ||
    typesMode === "airports_plus_helipads";

const intlMode =
  document.getElementById("internationalModeToggle")?.checked === true;

    
const querySignature = JSON.stringify({
  ident,
  radius_nm,
  requestedMax,
  hideNoApp,
  mainOnly,
  typesMode,
  includeHelipads,
  intlMode
});


  
if (ident === LAST_LOADED_AIRPORT) {
  console.log("Same airport already loaded");
  return;
}

if (querySignature === last_query_signature) {
  console.log("Skipping reload (same query)");
  return;
}

  console.log("Query changed → running search");
  await queryNearby(false);
}


async function copyTextSafe(text) {

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;

      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";

      document.body.appendChild(textarea);
      textarea.select();

      document.execCommand("copy");

      document.body.removeChild(textarea);

      return true;

    } catch (err) {
      console.warn("Clipboard fallback failed", err);
      return false;
    }

  }

}
async function copyWithFeedback(row, text) {

  const success = await copyTextSafe(text);

  if (!success) return;

const original = row.innerHTML;

  row.textContent = "Copied ✓";
  row.style.opacity = "1";
  row.classList.add("copied");

  setTimeout(() => {
row.innerHTML = original;
    row.style.opacity = "";
    row.classList.remove("copied");
  }, 800);

}


function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
}

function openFixPopover(anchorEl, title, text) {
  const pop = document.getElementById("fixPopover");
  const titleEl = document.getElementById("fixPopoverTitle");
  const content = document.getElementById("fixPopoverContent");

  titleEl.textContent = title;
  content.textContent = text;

  pop.classList.remove("hidden");

  const rect = anchorEl.getBoundingClientRect();

  const padding = 8;
  let left = rect.left;
  let top = rect.bottom + 6;

  // Keep inside viewport
  if (left + 220 > window.innerWidth - padding) {
    left = window.innerWidth - 220 - padding;
  }

  if (top + 240 > attachingBottom()) {
    top = rect.top - 240 - 6;
  }

  pop.style.left = `${Math.max(padding, left)}px`;
  pop.style.top = `${Math.max(padding, top)}px`;
}

function attachingBottom() {
  return window.innerHeight - 8;
}

function closeFixPanel() {
  const panel = document.getElementById("fixPanel");
  if (panel) panel.classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const pop = document.getElementById("fixPopover");
  if (!pop) return;

  if (!pop.contains(e.target)) {
    pop.classList.add("hidden");
  }
});

document.getElementById("fixPopoverClose")
  ?.addEventListener("click", () => {
    document.getElementById("fixPopover").classList.add("hidden");
  });

  document.getElementById("mainOnlyToggle")
  ?.addEventListener("change", () => {
    renderResults(MASTER_RESULTS, LAST_CENTER);
  });


function makeChip(label, cursor = "default") {
  const span = document.createElement("span");
  span.textContent = label;
  span.style.display = "inline-block";
  span.style.padding = "3px 8px";
  span.style.border = "1px solid #ddd";
  span.style.borderRadius = "999px";
  span.style.margin = "4px 6px 0 0";
  span.style.cursor = cursor;
  span.style.userSelect = "none";
  return span;
}

function makeButtonChip(label, isActive = false) {
  const c = makeChip(label, "pointer");
  c.style.borderColor = isActive ? "#555" : "#ddd";
  c.style.fontWeight = isActive ? "600" : "400";
  c.style.background = isActive ? "rgba(0,0,0,0.04)" : "transparent";
  return c;
}

function runwayLineText(r) {
  const dims = `${r.length_ft || "?"}x${r.width_ft || "?"} ft`;
  const flags = [
    r.surface ? r.surface : null,
    r.lighted === "1" ? "LGT" : null,
    r.closed === "1" ? "CLOSED" : null
  ].filter(Boolean).join(" • ");
  return `${(r.ident1 || "?")}/${(r.ident2 || "?")} — ${dims}${flags ? " — " + flags : ""}`;
}

/* -------- SID/STAR tooltip chips -------- */

function procChip(procObj, airportIdent, procType) {

let label = procObj.displayName;

if (!label && procObj.code) {

  const parts = procObj.code.split(".");

  if (parts.length >= 2) {
    label = parts[1];   // BENKY1
  }

}

if (!label) label = procObj.name;

const span = makeChip(label, "pointer");

  span.addEventListener("click", async (e) => {
    e.stopPropagation();

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType,
      procName: procObj.name,
      procCode: procObj.code
    });

    if (!resp || !resp.ok) {
      openFixPopover(span, procObj.name, resp?.error || "No response.");
      return;
    }

    if (!resp.fixes?.length) {
      openFixPopover(span, procObj.name, "No fixes found.");
      return;
    }

    const sorted = resp.fixes.slice().sort((a,b)=>a.localeCompare(b));
    // cache fix membership
for (const fx of resp.fixes || []) {

  const key = fx.toUpperCase();

  if (!FIX_PROCEDURE_MAP[key]) {
    FIX_PROCEDURE_MAP[key] = [];
  }
FIX_PROCEDURE_MAP[key].push({
  type: procType,
  proc: procObj.code || procObj.name,
  procDisplay: procObj.displayName || procObj.name
});

}
openFixPopover(span, procObj.name, " ");
await renderFixListInPopover(procObj.name, sorted);
  });

  return span;
}

async function renderFixListInPopover(title, fixes) {
  const pop = document.getElementById("fixPopover");
  const titleEl = document.getElementById("fixPopoverTitle");
  const content = document.getElementById("fixPopoverContent");


  titleEl.textContent = title;
  content.innerHTML = "";

  // Prepare an array of unique fix idents
  const rows = [];

  for (const fxRaw of fixes) {
    const fx = String(fxRaw || "").trim().toUpperCase();
    if (!fx) continue;

    rows.push({ fx, nav: null });  // placeholder
  }

  // Do lookups in parallel
await Promise.all(rows.map(async (item) => {

  const ident = item.fx;

  const nav = NAVAIDS?.[ident];

  if (nav) {
    item.nav = nav;
  }

}));

  // Now render
  for (const { fx, nav } of rows) {
    const row = document.createElement("div");
    row.className = "fixRow";

    row.style.cursor = "pointer";


const left = document.createElement("div");
left.className = "fixCode";

const right = document.createElement("div");
right.className = "fixMeta";

const displayText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

const copyText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

left.textContent = fx;

row.addEventListener("click", async (e) => {
  e.stopPropagation();

await copyWithFeedback(
  row,
  nav?.name ? nav.name.toUpperCase() : fx
);
  row.classList.add("copied");
  setTimeout(() => row.classList.remove("copied"), 600);

  const original = right.textContent;
  right.textContent = "Copied ✓";
  right.style.opacity = "1";

  setTimeout(() => {
    right.textContent = original;
    right.style.opacity = "";
  }, 800);
});


if (nav?.name) {
  right.textContent = nav.name.toUpperCase();
      const procs = FIX_PROCEDURE_MAP?.[fx.toUpperCase()];

if (procs?.length) {

  const p = procs[0];

  const procName = (p.proc || "").replace(/^.*\./,"");

  let cls = "procSID";

  if (p.type === "STAR") cls = "procSTAR";
  if (p.type === "IAP") cls = "procAPP";

  const tag = document.createElement("span");
  tag.className = `procTag ${cls}`;
  tag.textContent = procName;

  right.appendChild(tag);
}
      row.classList.add("isNav");
      row.title = `${nav.type || "NAVAID"}${nav.freq ? " • " + nav.freq : ""}`;
    } else {
      right.textContent = "";
      row.title = "Fix/Waypoint";
    }

    row.appendChild(left);
    row.appendChild(right);
    content.appendChild(row);
  }

  pop.classList.remove("hidden");
}

function iapChip(approachName, airportIdent) {
  const span = makeChip(approachName, "pointer");

  span.addEventListener("click", async (e) => {
  e.stopPropagation();

  openFixPopover(span, approachName, "Loading fixes…");

  const resp = await chrome.runtime.sendMessage({
    type: "GET_IAP_FIXES",
    airportIdent,
    approachName
  });

  if (!resp || !resp.ok) {
    openFixPopover(span, approachName, resp?.error || "Couldn’t load fixes.");
    return;
  }

  if (!resp.fixes?.length) {
    openFixPopover(span, approachName, resp.note || "No named fixes found.");
    return;
  }

  const sorted = resp.fixes.slice().sort((a,b)=>a.localeCompare(b));

  // 🔥 THIS is the important part
  await renderFixListInPopover(approachName, sorted);
});

  return span;
}

/* -------- Approaches grouping UI -------- */

function normalizeRwy(s) {
  if (!s) return null;

  let v = String(s).trim().toUpperCase();

  // Remove "RWY " prefix if present
  v = v.replace(/^RWY\s+/, "");

  // Remove leading zeros (04L -> 4L)
  v = v.replace(/^0+/, "");

  // Remove any trailing whitespace again
  v = v.trim();

  return v || null;
}

function parseRunwayFromApproachName(name) {
  // Matches "... RWY 17C ..." or "... RWY 4 ..." etc.
  const m = String(name || "").toUpperCase().match(/\bRWY\s+(\d{1,2}[LRC]?)/);
  return m ? normalizeRwy(m[1]) : null;
}

function groupApproachesByRunway(approaches) {
  const map = new Map(); // rwy -> [names]
  const other = [];

  for (const n of (approaches || [])) {
    const rwy = parseRunwayFromApproachName(n);
    if (!rwy) {
      other.push(n);
      continue;
    }
    if (!map.has(rwy)) map.set(rwy, []);
    map.get(rwy).push(n);
  }

  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => a.localeCompare(b));
    map.set(k, arr);
  }
  other.sort((a, b) => a.localeCompare(b));

  return { map, other };
}

function phoneticNormalize(str){

  if(!str) return "";

  str = str.toUpperCase().replace(/[^A-Z]/g,"");

  // common aviation pronunciation patterns
  const rules = [

    [/PH/g,"F"],
    [/CK/g,"K"],
    [/Q/g,"K"],
    [/X/g,"KS"],
    [/Z/g,"S"],
    [/DG/g,"J"],
    [/GH/g,"G"],
    [/KN/g,"N"],
    [/WR/g,"R"],

    // vowel sounds
    [/EE/g,"I"],
    [/EA/g,"I"],
    [/IE/g,"I"],
    [/EY/g,"I"],
    [/AY/g,"I"],

    [/OO/g,"U"],
    [/OU/g,"U"],

    // disney → dsnee compression
    [/ISN/g,"SN"],
    [/YSN/g,"SN"]
  ];

  
  for(const [r,rep] of rules)
    str = str.replace(r,rep);
// compress Y/E vowel noise
str = str.replace(/Y/g,"I");
  // collapse duplicates
  str = str.replace(/(.)\1+/g,"$1");

  // remove vowels except first
  str = str[0] + str.slice(1).replace(/[AEIOU]/g,"");

  return str;
}


function fuzzy(str, pattern) {
  let i = 0;
  for (const c of str) {
    if (c === pattern[i]) i++;
    if (i === pattern.length) return true;
  }
  return false;
}
function fuzzyMatchAirport(a, query) {
  const q = query.toUpperCase().trim();
  if (!q) return true;

  const fields = [
    a.ident,
    a.name,
    a.municipality,
    a.region
  ].filter(Boolean).map(s => s.toUpperCase());

  // Basic fuzzy: every character in order
  function fuzzy(str, pattern) {
    let i = 0;
    for (const c of str) {
      if (c === pattern[i]) i++;
      if (i === pattern.length) return true;
    }
    return false;
  }

  return fields.some(f =>
    f.includes(q) || fuzzy(f, q)
  );
}

function soundScore(fix,query){

  fix = String(fix||"").toUpperCase();
  query = String(query||"").toUpperCase();

  if(!fix || !query) return 0;

  const fixPh = phoneticNormalize(fix);
  const qPh = phoneticNormalize(query);

  let score = 0;

  // strongest: phonetic equality
  if(fixPh === qPh) score += 200;

  // phonetic contains
  if(fixPh.includes(qPh) || qPh.includes(fixPh))
    score += 120;

  // literal match
  if(fix === query) score += 100;

  if(fix.startsWith(query)) score += 80;

  if(fix.includes(query)) score += 50;

  // fuzzy character order
  if(fuzzy(fix,query))
    score += 40;

  const dist = levenshtein(fixPh,qPh);
  score += Math.max(0,40 - dist*6);

  return score;
}

function consonantSkeleton(str){

  if(!str) return "";

  str = str.toUpperCase().replace(/[^A-Z]/g,"");

  // aviation style vowel removal
  str = str.replace(/[AEIOU]/g,"");

  // normalize consonant sounds
  str = str
    .replace(/PH/g,"F")
    .replace(/CK/g,"K")
    .replace(/Q/g,"K")
    .replace(/Z/g,"S")
    .replace(/DG/g,"J");

  // collapse duplicates
  str = str.replace(/(.)\1+/g,"$1");

  return str;
}

function stripVowels(s){

  if(!s) return "";

  return s
    .toUpperCase()
    .replace(/[^A-Z]/g,"")
    .replace(/[AEIOU]/g,"");

}

function levenshtein(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

async function searchWaypoints(query, token = 0) {
const useNationwide =
  document.getElementById("procGlobalToggle")?.checked === true;
  const resultsContainer = document.getElementById("results");
  resultsContainer.innerHTML = "";

  query = (query || "").trim().toUpperCase();

  if (!query || query.length < 2) {
    renderResults(MASTER_RESULTS, LAST_CENTER);
    return;
  }

  const matches = [];
  const seen = new Set();

  console.log(
    "PROC MAP SIZE:",
    Object.keys(FIX_PROCEDURE_MAP).length
  );


/* -------------------------------
   SID / STAR SEARCH
--------------------------------*/

if (useNationwide) {

  // 🇺🇸 Nationwide CIFP search
  for (const item of PROC_FIX_MASTER) {

    const fix = item.fix;
    const procs = item.procedures;
    const nav = NAVAIDS?.[fix];

    let score = soundScore(fix, query);

    if (nav?.name) {

      const nameUpper = nav.name.toUpperCase();

      if (nameUpper.includes(query))
        score = Math.max(score, 90);

      score = Math.max(
        score,
        soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
      );
    }

    if (score <= 0) continue;

    for (const p of procs) {

      const procName =
        p.displayName ||
        (p.code ? p.code.replace(/^.*\./, "") : "") ||
        p.name ||
        "";

      matches.push({
        airport: p.airport || "",
        procedure: procName.replace(/^.*\./,""),
        type: p.type,
        fix,
        score,
        navName: nav?.name || ""
      });

    }

  }

} else {

  // 📍 Nearby airports only
  for (const fix in FIX_PROCEDURE_MAP) {

    const procs = FIX_PROCEDURE_MAP[fix];
    const nav = NAVAIDS?.[fix];

    let score = soundScore(fix, query);

    if (nav?.name) {

      const nameUpper = nav.name.toUpperCase();

      if (nameUpper.includes(query))
        score = Math.max(score, 90);

      score = Math.max(
        score,
        soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
      );
    }

    if (score <= 0) continue;

    for (const p of procs) {

      const procName =
        p.procDisplay ||
        (p.proc ? p.proc.replace(/^.*\./, "") : "") ||
        "";

      matches.push({
        airport: p.airport || "",
        procedure: procName.replace(/^.*\./,""),
        type: p.type,
        fix,
        score,
        navName: nav?.name || ""
      });

    }

  }

}


  /* -------------------------------
     IAP SEARCH
  --------------------------------*/
if (!useNationwide) {
  for (const airport of (MASTER_RESULTS || [])) {

    const ident = String(airport?.ident || "").toUpperCase();
    if (!ident) continue;

    for (const apNameRaw of (airport.approaches || [])) {

      const apName = String(apNameRaw || "").trim();
      if (!apName) continue;

      const resp = await chrome.runtime.sendMessage({
        type: "GET_IAP_FIXES",
        airportIdent: ident,
        approachName: apName
      });

      const fixes = resp?.fixes || [];

      for (const fixRaw of fixes) {

        const fix = String(fixRaw || "").toUpperCase().trim();
        if (!fix) continue;

        const nav = NAVAIDS?.[fix];
let score = soundScore(fix, query);

if (nav?.name) {

  const nameUpper = nav.name.toUpperCase();

  if (nameUpper.includes(query))
    score = Math.max(score, 90);

  score = Math.max(
    score,
    soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
  );
}

if (score < 10) continue;

        const key = `${ident}|IAP|${apName}|${fix}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          airport: ident,
          procedure: apName,
          type: "IAP",
          fix,
          score,
          navName: nav?.name || ""
        });

      }

    }

  }
}

  if (!matches.length) {

    resultsContainer.innerHTML =
      "<div class='card'>No waypoint matches found.</div>";

    return;

  }

  /* -------------------------------
     SORT BEST FIRST
  --------------------------------*/

  matches.sort((a, b) => b.score - a.score);

  for (const m of matches.slice(0, 60)) {

    const div = document.createElement("div");
    div.className = "card";

let tagClass = "procSID";

if (m.type === "STAR") tagClass = "procSTAR";
if (m.type === "IAP") tagClass = "procAPP";

div.innerHTML = `
<div class="title">
  ${m.navName ? m.navName.toUpperCase() + " (" + m.fix + ")" : m.fix}
</div>
  <div class="sub">
   ${m.airport ? m.airport + " " : ""}
<span class="procTag ${tagClass}">
      ${m.type}
    </span>
    ${m.procedure}
  </div>
`;

    div.style.cursor = "pointer";

div.addEventListener("click", async () => {
  await copyWithFeedback(
    div,
    m.navName ? m.navName.toUpperCase() : m.fix
  );
});

    resultsContainer.appendChild(div);

  }

}

function normalizeAirport(a){
  if(!a) return "";
  a = a.toUpperCase();
  if(a.length === 3) return "K"+a;
  return a;
}

async function runProcedureSearch(query){

  const resultsContainer = document.getElementById("results");
  resultsContainer.innerHTML = "";

const rawQuery = (query || "").trim().toUpperCase();
const queryPh = phoneticNormalize(rawQuery);
  if(!query) return;

  const resp = await chrome.runtime.sendMessage({
  type: "SEARCH_PROCEDURES",
  query
});
console.log("PROC SEARCH RESP:", resp);
const procs = resp?.results || [];
const matches = [];
const seen = new Set();

for(const p of procs){

  const name = (p.displayName || p.name || "").toUpperCase();
  const code = (p.code || "").toUpperCase();

const airport = normalizeAirport(p.airport || "");
const key = `${airport}|${p.type}|${code}`;

  if(seen.has(key)) continue;
  seen.add(key);

const cleanName = name
  .replace(/[0-9]/g,"")
  .replace(/(STAR|SID|ARRIVAL|DEPARTURE)/g,"")
  .trim();

const namePh = phoneticNormalize(cleanName);

let score = 0;

// literal matches
if(cleanName.startsWith(rawQuery)) score += 140;
if(cleanName.includes(rawQuery)) score += 200;


// fuzzy literal
if(fuzzy(cleanName, rawQuery))
  score += 120;

// edit distance (handles eagle/eagul)
const distPh = levenshtein(namePh, queryPh);
if (distPh <= 2) score += 140;

// phonetic
score = Math.max(score, soundScore(cleanName, queryPh));
score = Math.max(score, soundScore(code, queryPh));

// phonetic equality (DISNEY vs DSNEE)
if(namePh === queryPh) score += 400;

// phonetic containment
if(namePh.includes(queryPh) || queryPh.includes(namePh))
  score += 180;

// vowel-stripped compare
const nvName = namePh.replace(/[AEIOU]/g,"");
const nvQuery = queryPh.replace(/[AEIOU]/g,"");

const skName = stripVowels(cleanName);
const skQuery = stripVowels(rawQuery);

if(skName === skQuery)
  score += 500;

if(skName.includes(skQuery) || skQuery.includes(skName))
  score += 250;

const skelName = consonantSkeleton(cleanName);
const skelQuery = consonantSkeleton(rawQuery);

if(skelName === skelQuery)
  score += 350;

if(skelName.includes(skelQuery))
  score += 200;

if(nvName === nvQuery) score += 250;

if(score < 20) continue;

matches.push({
  airport: p.airport,
  name: p.name || p.displayName,   // ⭐ REQUIRED
  procedure: (p.displayName || p.name || "").replace(/^.*\./,""),
  type: p.type,
  code: p.code,
  score
});

}

  if(!matches.length){

    resultsContainer.innerHTML =
      "<div class='card'>No procedures found.</div>";

    return;

  }

  matches.sort((a,b)=>b.score-a.score);

  for(const proc of matches.slice(0,60)){

    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";

const header = document.createElement("div");

let tagClass = "procSID";

if(proc.type === "STAR") tagClass = "procSTAR";
if(proc.type === "IAP") tagClass = "procAPP";

header.innerHTML = `
  <div class="title">
    ${proc.procedure}
    <span class="procTag ${tagClass}">
      ${proc.type}
    </span>
  </div>
  <div class="sub">
    ${proc.airport}
  </div>
`;

    const fixesBox = document.createElement("div");
    fixesBox.style.marginTop = "6px";
    fixesBox.style.display = "none";

    card.appendChild(header);
    card.appendChild(fixesBox);

    card.addEventListener("click", async () => {

      if(fixesBox.dataset.loaded){

        fixesBox.style.display =
          fixesBox.style.display === "none" ? "block" : "none";

        return;
      }

      fixesBox.innerHTML = "Loading fixes…";
      fixesBox.style.display = "block";

      const resp = await chrome.runtime.sendMessage({
        type: "GET_PROC_FIXES",
        procType: proc.type === "SID" ? "DP" : proc.type,
        procName: proc.name,
        procCode: proc.code
      });

      fixesBox.innerHTML = "";

      const fixes = resp?.fixes || [];

      if(!fixes.length){
        fixesBox.innerHTML = "<em>No fixes found</em>";
        return;
      }

for(const fxRaw of fixes){

  const fx = String(fxRaw).toUpperCase();
  const nav = NAVAIDS?.[fx];

  const row = document.createElement("div");
  row.className = "fixRow";
  row.style.cursor = "pointer";

  const left = document.createElement("div");
  left.className = "fixCode";
  left.textContent = fx;

  const right = document.createElement("div");
  right.className = "fixMeta";

  if(nav?.name){
right.textContent = nav.name.toUpperCase();
  } else {
    right.textContent = "";
  }

  row.appendChild(left);
  row.appendChild(right);

  row.addEventListener("click", async (e) => {

    e.stopPropagation();

    await copyWithFeedback(row, fx);

  });

  fixesBox.appendChild(row);
}

      fixesBox.dataset.loaded = "1";

    });

    resultsContainer.appendChild(card);

  }

}

function parseCSV(text) {
  const rows = [];
  const lines = text.split("\n").filter(Boolean);

  const headers = lines[0].split(",");

  for (let i = 1; i < lines.length; i++) {
    const cols = [];
    let current = "";
    let inQuotes = false;

    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cols.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    cols.push(current);

    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = (cols[idx] || "").trim();
    });

    rows.push(obj);
  }

  return rows;
}


async function loadOurAirportsFrequencies() {
  if (AIRPORT_FREQ_INDEX) return;

  console.log("Loading OurAirports frequencies...");

  const res = await fetch(
    "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"
  );

  const text = await res.text();
  const rows = parseCSV(text);

  const map = {};
  const seen = new Set();

  for (const r of rows) {
    const ident = String(r.airport_ident || "").toUpperCase();
    if (!ident) continue;

    const rawFreq = String(r.frequency_mhz || "").trim();
    if (!rawFreq) continue;

    const freq = parseFloat(rawFreq);
    if (isNaN(freq) || freq < 108 || freq > 137) continue;

    let type = (r.type || "").toUpperCase();
    let name = (r.description || "").trim();

    name = name
      .replace(/\[.*?\]/g, "")
      .replace(/\(.*?\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const TYPE_MAP = {
      TWR: "Tower",
      GND: "Ground",
      APP: "Approach",
      DEP: "Departure",
      ATIS: "ATIS",
      CTAF: "CTAF",
      UNICOM: "UNICOM",
      AWOS: "AWOS",
      ASOS: "ASOS"
    };

    const cleanName =
      TYPE_MAP[type] ||
      name ||
      type ||
      "Unknown";

    const freqParts = rawFreq.split(/[ /]+/);

    for (const part of freqParts) {
      const f = parseFloat(part);
      if (isNaN(f) || f < 108 || f > 137) continue;

      const key = `${ident}_${cleanName}_${f}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!map[ident]) map[ident] = [];

      map[ident].push({
        type,
        name: cleanName,
        freq: f.toFixed(3)
      });
    }
  }

  AIRPORT_FREQ_INDEX = map;
  console.log("OurAirports loaded:", Object.keys(map).length);
}

function buildRunwayPairs(runways) {
  const out = [];
  const seen = new Set();

  for (const r of (runways || [])) {
    const a0 = normalizeRwy(r.ident1);
const b0 = normalizeRwy(r.ident2);

if (!a0 || !b0) continue;

    // Canonicalize so 31R/13L and 13L/31R are the same
    const pair = [a0, b0].sort((x, y) => {
      const nx = parseInt(x, 10);
      const ny = parseInt(y, 10);
      if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
      return x.localeCompare(y);
    });

    const key = `${pair[0]}/${pair[1]}`;

    // Extra safety: also mark the reverse orientation as seen
    const rev = `${pair[1]}/${pair[0]}`;

    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    seen.add(rev);

    out.push({
      pairKey: key,
      end1: pair[0],
      end2: pair[1],
      label: key
    });
  }

  out.sort((x, y) => {
    const nx = parseInt(x.end1, 10);
    const ny = parseInt(y.end1, 10);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
    return x.pairKey.localeCompare(y.pairKey);
  });

  return out;
}

function renderRunwayEndSection(container, airportIdent, rwy, names, defaultExpanded = false) {
  if (!Array.isArray(names)) {
    console.warn("Approach names not array:", names);
    names = [];
  }

  const details = document.createElement("details");
  details.open = defaultExpanded;

  const summary = document.createElement("summary");
  summary.textContent = `RWY ${rwy} (${names.length})`;
  summary.style.cursor = "pointer";
  summary.style.fontWeight = "600";
  summary.style.marginTop = "6px";
  details.appendChild(summary);

  const wrap = document.createElement("div");
  wrap.style.marginTop = "6px";

  const MAX = 10;
  const initial = names.slice(0, MAX);

  for (const n of initial) {
    wrap.appendChild(iapChip(n, airportIdent));   // 🔥 use passed value
  }

  if (names.length > MAX) {
    const more = makeButtonChip(`Show all (${names.length})`);
    more.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.innerHTML = "";
      for (const n2 of names) {
        wrap.appendChild(iapChip(n2, airportIdent));  // 🔥 use passed value
      }
    });
    wrap.appendChild(more);
  }

  details.appendChild(wrap);
  container.appendChild(details);
}

function renderApproachesGrouped(apWrap, airportIdent, runways, approaches, metaNoteLine) {

  apWrap.innerHTML = "";
  apWrap.style.opacity = "1";

  if (!Array.isArray(approaches) || approaches.length === 0) {
    apWrap.style.opacity = "0.75";
    apWrap.textContent = metaNoteLine || "(none found)";
    return;
  }

  const safeRunways = Array.isArray(runways) ? runways : [];
const pairs = buildRunwayPairs(safeRunways);
  const { map, other } = groupApproachesByRunway(approaches);

    console.log("Runways:", runways);
console.log("Approach map keys:", Array.from(map.keys()));

  // If no runway pairs exist, show all as a flat list
  if (!pairs.length) {
    const wrap = document.createElement("div");
    for (const n of approaches) wrap.appendChild(iapChip(n, airportIdent));
    apWrap.appendChild(wrap);
    return;
  }

  // Default = first runway pair (no "All runways")
  const selected = apWrap.dataset.selectedPairKey || pairs[0].pairKey;
  apWrap.dataset.selectedPairKey = selected;

  // Buttons row
  const selectorRow = document.createElement("div");
  selectorRow.className = "rwy-selector";

  for (const p of pairs) {
    const btn = makeButtonChip(p.label, selected === p.pairKey);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      apWrap.dataset.selectedPairKey = p.pairKey;
      renderApproachesGrouped(apWrap, airportIdent, runways, approaches, metaNoteLine);
    });
    selectorRow.appendChild(btn);
  }

  apWrap.appendChild(selectorRow);

  const content = document.createElement("div");
  const sel = pairs.find(x => x.pairKey === selected) || pairs[0];
  const ends = [sel.end1, sel.end2].filter(Boolean);

  let any = false;

  for (const end of ends) {
    const names = (map.get(end) || []);
    if (!names.length) continue;

    any = true;

    const block = document.createElement("div");
    block.className = "rwy-block";

    const h = document.createElement("div");
    h.className = "rwy-header";
    h.textContent = `RWY ${end} (${names.length})`;
    block.appendChild(h);

    const wrap = document.createElement("div");

    const MAX = 12;
    const initial = names.slice(0, MAX);

    for (const n of initial) wrap.appendChild(iapChip(n, airportIdent));

    if (names.length > MAX) {
      const more = makeButtonChip(`Show all (${names.length})`);
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrap.innerHTML = "";
        for (const n2 of names) wrap.appendChild(iapChip(n2, airportIdent));
      });
      wrap.appendChild(more);
    }

    block.appendChild(wrap);
    content.appendChild(block);
  }

  if (!any) {
    const none = document.createElement("div");
    none.style.opacity = "0.75";
    none.textContent = "(no approaches tagged to this runway pair)";
    content.appendChild(none);
  }

  if (other.length) {
    const h = document.createElement("div");
    h.style.fontWeight = "700";
    h.style.marginTop = "10px";
    h.textContent = `Other (${other.length})`;
    content.appendChild(h);

    const wrap = document.createElement("div");
    for (const n of other) wrap.appendChild(iapChip(n, airportIdent));
    content.appendChild(wrap);
  }

  apWrap.appendChild(content);
}

/* -------- Approach loading (on demand) -------- */

// Card click should not fire when interacting with chips/tooltips
function isClickOnInteractive(e) {
  const t = e.target;
  if (t.closest("span")) return true;
  if (t.closest("summary")) return true;
  return false;
}



function renderResults(list, centerIdentUpper) {
  
  const root = $("results");
  root.innerHTML = "";

  const sideList = document.getElementById("sideList");
if (sideList) sideList.innerHTML = "";

  // Store last results for filtering toggle
LAST_RESULTS = list.slice();
LAST_CENTER = centerIdentUpper;

const mainOnly = document.getElementById("mainOnlyToggle")?.checked;
const typesMode = document.getElementById("types")?.value;
const hideNoApp = document.getElementById("filterNoApproaches")?.checked;
const maxResultsUI = Number(document.getElementById("maxResults")?.value || 25);

if (mainOnly && centerIdentUpper) {
  list = list.filter(a =>
    String(a.ident || "").toUpperCase() === centerIdentUpper
  );
}

/* -----------------------------
   TYPE FILTER
----------------------------- */
if (typesMode === "public") {
  list = list.filter(a => {
    const t = String(a.t || "").toLowerCase();
    return t !== "heliport" && t !== "seaplane base";
  });
} else if (typesMode === "all_airports") {
  list = list.filter(a => {
    const t = String(a.t || "").toLowerCase();
    return t !== "heliport";
  });
} else if (typesMode === "helipads_only") {
  list = list.filter(a => {
    const t = String(a.t || "").toLowerCase();
    return t === "heliport";
  });
} else if (typesMode === "airports_plus_helipads") {
  // no extra filter needed
}

/* -----------------------------
   IAP FILTER
----------------------------- */
if (hideNoApp) {
  list = list.filter(a => {
    const t = String(a.t || "").toLowerCase();

    // never show heliports when filtering for IAPs
    if (t === "heliport") return false;

    return Array.isArray(a.approaches) && a.approaches.length > 0;
  });
}

// cap after filtering
list = list.slice(0, maxResultsUI);

  if (!list.length) {
    root.innerHTML =
      `<div class="card"><div class="title">No airports found</div><div class="sub">Try increasing radius or switching Country filter to Any.</div></div>`;
    return;
  }

  for (const a of list) {
    const airportIdent = String(a.ident || "").toUpperCase();

    const div = document.createElement("div");
    div.className = "card";
    div.style.cursor = "pointer";

    const cardId = `airport_${airportIdent}`;
div.id = cardId;

if (sideList) {
  const item = document.createElement("div");
  item.className = "sideItem";

  // Build runway string
  const rwyText = (a.runways || [])
    .map(r => `${r.ident1}/${r.ident2}`)
    .join(", ");

  item.innerHTML = `
    <div class="code">${airportIdent}</div>
    <div class="name">${a.name || ""}</div>
    <div class="rwys">${rwyText}</div>
  `;

  item.addEventListener("click", () => {

  document.querySelectorAll(".sideItem")
    .forEach(el => el.classList.remove("active"));

  item.classList.add("active");

  const mainPanel = document.getElementById("mainPanel");
  if (!mainPanel) return;

  const offset = div.offsetTop - mainPanel.offsetTop;

  mainPanel.scrollTo({
    top: offset - 12,
    behavior: "smooth"
  });



  // Load facility info
const facilityContent = document.getElementById("facilityContent");
facilityContent.innerHTML = "<em>Loading facility info...</em>";

chrome.runtime.sendMessage(
  { type: "FETCH_AIRNAV", icao: airportIdent },
  async (resp) => {

    const facilityContent = document.getElementById("facilityContent");
    facilityContent.innerHTML = "";

    const facilitySearch = document.getElementById("facilitySearch");
    if (facilitySearch) facilitySearch.value = "";

    // ✅ Load OurAirports fallback
    await loadOurAirportsFrequencies();

    const ourAirports = AIRPORT_FREQ_INDEX?.[airportIdent] || [];

    let usedAirNav = false;

    if (resp && resp.ok && resp.data?.length) {

      usedAirNav = true;

      const comms = resp.data.filter(d => d.type === "comm");
      const navs = resp.data.filter(d => d.type === "nav");

      if (comms.length) {
        const commTitle = document.createElement("div");
        commTitle.innerHTML = "<strong>Communications</strong>";
        facilityContent.appendChild(commTitle);

        comms.forEach(c => {
          const div = document.createElement("div");
          div.className = "facilityItem";
          div.innerText = `${c.label} — ${c.freq}`;
          facilityContent.appendChild(div);
        });
      }

      navs.forEach(n => {
        const div = document.createElement("div");
        div.className = "facilityItem";
        div.innerText = `${n.label} — ${n.freq}`;
        facilityContent.appendChild(div);
      });

    }

    // ✅ Always add OurAirports (dedup later if you want)
    if (ourAirports.length) {

      const title = document.createElement("div");
      title.innerHTML = `<strong>OurAirports</strong>`;
      title.style.marginTop = "8px";
      facilityContent.appendChild(title);

      for (const f of ourAirports) {

        const div = document.createElement("div");
        div.className = "facilityItem";

        const name = prettyFreqName(f);

        div.innerText = `${name} — ${f.freq}`;

        facilityContent.appendChild(div);

        // 🔥 also feed your global index
        FACILITY_FREQ_INDEX.push({
          freq: f.freq,
          label: name,
          airport: airportIdent
        });
      }

    }

    if (!usedAirNav && !ourAirports.length) {
      facilityContent.innerHTML = "No facility data found.";
    }

  }
);
});

  sideList.appendChild(item);
}

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `${a.ident} — ${a.name || "(unknown name)"}`;

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${Number(a.distance_nm || 0).toFixed(1)} NM • ${a.municipality || ""} ${a.region || ""} ${a.country || ""}`.trim();

    const rwysBlock = document.createElement("div");
rwysBlock.className = "rwys";

const pairs = buildRunwayPairs(a.runways || []);

if (!pairs.length) {
  rwysBlock.textContent = "No runway data in dataset for this airport.";
} else {
  for (const p of pairs) {
    const chip = makeButtonChip(p.label);
    rwysBlock.appendChild(chip);
  }
}

    const proc = document.createElement("div");
    proc.className = "proc";

/* ---------------- Departures ---------------- */
const dpLabel = document.createElement("div");
dpLabel.className = "section-title";
dpLabel.textContent = "Departures (DP/SID)";
proc.appendChild(dpLabel);

const dpWrap = document.createElement("div");
const deps = (a.departures || []);
for (const p of deps) dpWrap.appendChild(procChip(p, a.ident, "DP"));
if (!deps.length) dpWrap.textContent = "(none found)";

const dpPanel = document.createElement("div");
dpPanel.className = "section-panel departures";
dpPanel.appendChild(dpWrap);
proc.appendChild(dpPanel);

/* ---------------- Arrivals ---------------- */
const stLabel = document.createElement("div");
stLabel.className = "section-title";
stLabel.textContent = "Arrivals (STAR)";
proc.appendChild(stLabel);

const stWrap = document.createElement("div");
const arrs = (a.arrivals || []);
for (const p of arrs) stWrap.appendChild(procChip(p, a.ident, "STAR"));
if (!arrs.length) stWrap.textContent = "(none found)";

const stPanel = document.createElement("div");
stPanel.className = "section-panel arrivals";
stPanel.appendChild(stWrap);
proc.appendChild(stPanel);

/* ---------------- Approaches ---------------- */
const apLabel = document.createElement("div");
apLabel.className = "section-title";
apLabel.textContent = "Approaches (IAP — names only)";
proc.appendChild(apLabel);

const apWrap = document.createElement("div");
apWrap.dataset.airportIdent = airportIdent;
apWrap.dataset.approachesLoaded = "0";

const apPanel = document.createElement("div");
apPanel.className = "section-panel approaches";
apPanel.appendChild(apWrap);
proc.appendChild(apPanel);

const aps = a.approaches || [];
const meta = a.approaches_meta || null;
const note = a.approaches_note || "";
const metaLine = meta?.cycle ? `(none found) • cycle=${meta.cycle} • note=${note || "n/a"}` : null;

if (aps.length) {
  apWrap.dataset.approachesLoaded = "1";
  apWrap.dataset.approachesCount = String(aps.length);
  renderApproachesGrouped(apWrap, airportIdent, a.runways || [], aps, metaLine || "(none found)");
} else {
  apWrap.textContent =
    (airportIdent === centerIdentUpper)
      ? "(none found / not cached yet)"
      : "(click card to load; will group by runway)";
  apWrap.style.opacity = "0.75";
}
console.log("ARRIVALS RAW:", a.arrivals);

// Card click loads full approaches if not already loaded
div.appendChild(title);
div.appendChild(sub);
div.appendChild(proc);
root.appendChild(div);
  }
}

function prettyFreqName(f) {

  const map = {
    TWR: "Tower",
    GND: "Ground",
    APP: "Approach",
    DEP: "Departure",
    ATIS: "ATIS",
    CTAF: "CTAF",
    UNICOM: "UNICOM"
  };

  return map[f.type] || f.name || f.type;
}

function extractICAOFromKey(rawKey) {
  if (!rawKey) return null;

  const upper = rawKey.toUpperCase();

  const matches = upper.match(/(?<![A-Z])[KPC][A-Z]{3}(?![A-Z])/g);

  if (!matches) return null;

  return matches[0];
}
  function autoResizeTextarea(el) {
  if (!el) return;

  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

async function handleNewPageKey(newRaw) {

  if (!newRaw) return;

  const lbxKeyEl = document.getElementById("lbxKey");
  if (lbxKeyEl) {
    lbxKeyEl.value = newRaw;
    autoResizeTextarea(lbxKeyEl);
  }

  const newAirport = extractICAOFromKey(newRaw);
  if (!/^[A-Z]{4}$/.test(newAirport)) return;

  const input = document.getElementById("airportInput");
  if (input && input.value !== newAirport) {
    input.value = newAirport;
    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(newAirport);
}
  }

  // 🔥 Update overlay header immediately
  chrome.storage.local.set({ overlayActiveICAO: newAirport });

  // 🔥 Run autolaunch
  const { lbx_settings } =
    await chrome.storage.local.get(["lbx_settings"]);

  chrome.runtime.sendMessage({
    type: "RUN_AUTOLAUNCH",
    rawText: newRaw,
    settings: lbx_settings || {}
  });
}


async function detectProcedures(routeFixes, origin, dest){

  const result = {
    sid: null,
    star: null
  };

  if(!routeFixes?.length) return result;

const startSegment = routeFixes.slice(0,15);
const endSegment   = routeFixes.slice(-15);

  if(origin){

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport: origin,
      procType:"DP"
    });

    const procs = resp?.procs || [];

    let bestScore = 0;

    for(const p of procs){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:"DP",
        procName:p.name,
        procCode:p.code
      });

      const fixes = fixesResp?.fixes || [];

      const score = fixes.filter(f => startSegment.includes(f)).length;

      if(score > bestScore && score >= 3){
        bestScore = score;
        result.sid = p.code || p.name;
      }

    }

  }

  if(dest){

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport: dest,
      procType:"STAR"
    });

    const procs = resp?.procs || [];

    let bestScore = 0;

    for(const p of procs){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:"STAR",
        procName:p.name,
        procCode:p.code
      });

      const fixes = fixesResp?.fixes || [];

      const score = fixes.filter(f => endSegment.includes(f)).length;

      if(score > bestScore && score >= 3){
        bestScore = score;
        result.star = p.code || p.name;
      }

    }

  }

  return result;
}


async function queryNearby(force = false) {

  const ident = ($("airportInput").value || "").trim().toUpperCase();
  if (!force && ident === LAST_LOADED_AIRPORT) {
  console.log("Already loaded:", ident);
  return;
}

  if (!ident) {
    return setStatus("Enter an airport identifier (e.g., KDAL).", true);
  }

  const radius_nm = Number($("radiusNm").value || 0);
  if (!Number.isFinite(radius_nm) || radius_nm <= 0) {
    return setStatus("Radius must be a positive number.", true);
  }

  const mainOnly =
    document.getElementById("mainOnlyToggle")?.checked === true;

  const requestedMax =
    Number($("maxResults").value || 25);

  const hideNoApp =
    document.getElementById("filterNoApproaches")?.checked === true;

  const typesMode = $("types").value;

  const includeHelipads =
    typesMode === "helipads_only" ||
    typesMode === "airports_plus_helipads";

const intlMode =
  document.getElementById("internationalModeToggle")?.checked === true;

const country = intlMode ? "ANY" : "US";

  /* -----------------------------
     QUERY SIGNATURE CACHE CHECK
  ----------------------------- */

  const { last_query_signature } =
    await chrome.storage.local.get("last_query_signature");

const querySignature = JSON.stringify({
  ident,
  radius_nm,
  requestedMax,
  hideNoApp,
  mainOnly,
  typesMode,
  includeHelipads,
  intlMode
});
  if (!force && querySignature === last_query_signature) {
    console.log("Skipping reload (same query):", ident);
    return;
  }

  console.log(
    "CHSLY check:",
    Object.keys(FIX_PROCEDURE_MAP).filter(f => f.includes("CHSLY"))
  );

  setStatus("Finding nearby airports…");

  /* -----------------------------
     RESULT SIZE CONTROL
  ----------------------------- */

  const fetchMax = hideNoApp
    ? Math.min(200, requestedMax * 6)
    : requestedMax;

const resp = await chrome.runtime.sendMessage({
  type: "QUERY_NEARBY",
  ident,
  radius_nm,
  max_results: fetchMax,
  country,
  typesMode,
  includeHelipads,
  mainOnly,
  intlMode
});

  if (!resp || !resp.ok) {
    return setStatus(resp?.error || "Unknown error", true);
  }

  if (mainOnly) {
    setStatus(`Loaded ${ident} (main airport only).`);
  } else {
    setStatus(`Loaded ${resp.results.length} airports near ${resp.center.ident}.`);
  }

  MASTER_RESULTS = resp.results.slice();

  buildAirportNameMap();

  renderResults(
    MASTER_RESULTS,
    String(resp.center.ident || "").toUpperCase()
  );

/* -----------------------------
   PRELOAD SID / STAR FIX MAP
----------------------------- */
if (!intlMode) {
for (const airport of MASTER_RESULTS) {

  /* SID */
  for (const p of airport.departures || []) {

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType: "DP",
      procName: p.name,
      procCode: p.code
    });

    for (const fx of resp?.fixes || []) {

      const key = fx.toUpperCase();

      if (!FIX_PROCEDURE_MAP[key]) {
        FIX_PROCEDURE_MAP[key] = [];
      }

      const exists = FIX_PROCEDURE_MAP[key].some(
        x => x.proc === (p.code || p.name) && x.airport === airport.ident
      );

      if (!exists) {
        FIX_PROCEDURE_MAP[key].push({
          airport: airport.ident,
          type: "SID",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }

    }
  }

  /* STAR */
  for (const p of airport.arrivals || []) {

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType: "STAR",
      procName: p.name,
      procCode: p.code
    });

    for (const fx of resp?.fixes || []) {

      const key = fx.toUpperCase();

      if (!FIX_PROCEDURE_MAP[key]) {
        FIX_PROCEDURE_MAP[key] = [];
      }

      const exists = FIX_PROCEDURE_MAP[key].some(
        x => x.proc === (p.code || p.name) && x.airport === airport.ident
      );

      if (!exists) {
        FIX_PROCEDURE_MAP[key].push({
          airport: airport.ident,
          type: "STAR",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }

    }
  }

}
}
  /* -----------------------------
     SAVE CACHE
  ----------------------------- */

await chrome.storage.local.set({
  last_query_signature: querySignature,
  nearby_cache: {
    airport: ident,
    results: resp.results,
    center: String(resp.center.ident || "").toUpperCase()
  }
});

LAST_LOADED_AIRPORT = ident;
await chrome.storage.local.set({
  last_loaded_airport: ident
});
}

$("searchBtn").addEventListener("click", queryNearby);
$("airportInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") queryNearby();
});

// ---- CIFP loader wiring ----
const cifpBtn = $("cifpBtn");
const cifpFile = $("cifpFile");
const cifpStatus = $("cifpStatus");

if (cifpBtn && cifpFile && cifpStatus) {
  cifpBtn.addEventListener("click", () => cifpFile.click());

  cifpFile.addEventListener("change", async () => {
    const f = cifpFile.files && cifpFile.files[0];
    if (!f) return;

    cifpStatus.textContent = "Loading…";

    try {
      const arrayBuffer = await f.arrayBuffer();
const u8 = new Uint8Array(arrayBuffer);   // 🔥 important
const resp = await chrome.runtime.sendMessage({
  type: "LOAD_CIFP_ZIP",
  bytes: Array.from(u8),                  // send as normal array
  filename: f.name
});

      if (!resp || !resp.ok) {
        cifpStatus.textContent = `Failed: ${resp?.error || "No response"}`;
        return;
      }
      cifpStatus.textContent = `Loaded: ${resp.summary || "OK"}`;
    } catch (e) {
      cifpStatus.textContent = `Failed: ${String(e?.message || e)}`;
    } finally {
      cifpFile.value = ""; // allow re-upload same file
    }
  });
}

function runLocalFacilitySearch(q){

  const items = document.querySelectorAll("#facilityContent .facilityItem");

  items.forEach(item => {

    const text = item.textContent.toUpperCase();

    item.style.display =
      text.includes(q) ? "" : "none";

  });

}



async function applyActiveFlightFixesToUI(fixes){

  const container = document.getElementById("routeResults");
  if(!container) return;

  container.innerHTML = "";

  if(!fixes?.length){
    container.innerHTML =
      "<div class='routeFix'>No active flight detected</div>";
    return;
  }

  fixes = [...new Set(fixes)]; // dedupe

  const max = Math.min(fixes.length,100);

  for(let i=0;i<max;i++){

    const fx = fixes[i];

    const nav = NAVAIDS?.[fx];

const displayText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

const copyText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

let label = displayText;

const procs = FIX_PROCEDURE_MAP?.[fx.toUpperCase()];

if (procs?.length) {

  const unique = new Map();

  for (const p of procs) {
    const name = p.procDisplay || p.proc;
    if (!unique.has(name)) unique.set(name, p.type);
  }

  for (const [name,type] of unique) {

    let cls = "procSID";
    if (type === "STAR") cls = "procSTAR";
    if (type === "IAP") cls = "procAPP";

    label += ` <span class="procTag ${cls}">${name}</span>`;
  }
}

if (nav?.name) {
  label = `${displayText} (${fx})`;
}

    const row = document.createElement("div");
    row.className = "routeFix";
    row.innerHTML = label;

row.addEventListener("click", async () => {
  await copyWithFeedback(row, copyText);
});

    container.appendChild(row);
  }
}


async function bootstrapActiveFlightFixes(){

  const data = await chrome.storage.local.get(
    "adsb_active_flight_fixes"
  );

  if(!data.adsb_active_flight_fixes) return;

  await applyActiveFlightFixesToUI(
    data.adsb_active_flight_fixes
  );

}

async function findNearestAirport(lat, lon){

  const resp = await chrome.runtime.sendMessage({
    type: "SEARCH_NEAREST_AIRPORT",
    lat,
    lon
  });

  if(!resp?.ok) return null;

  return resp.airport;
}


// React to changes even while overlay is open


(async function initPopup() {
const saved = await chrome.storage.local.get("last_loaded_airport");

if (saved?.last_loaded_airport) {
  LAST_LOADED_AIRPORT = saved.last_loaded_airport;
  console.log("Restored last airport:", LAST_LOADED_AIRPORT);
}
  try {
  const navResp = await chrome.runtime.sendMessage({ type: "GET_NAVAID_INDEX" });
  if (navResp?.ok) NAVAIDS = navResp.index || null;
} catch (e) {
  // safe ignore
}


try {

  const resp = await chrome.runtime.sendMessage({
    type: "GET_PROC_FIX_MASTER"
  });

  if (resp?.ok) {

    PROC_FIX_MASTER = resp.results || [];

    console.log(
      "PROC MASTER LOADED:",
      PROC_FIX_MASTER.length
    );

  }

} catch (err) {

  console.warn(
    "PROC MASTER load failed:",
    err
  );

}


  console.log("POPUP INIT");

// 🔥 Strong ICAO bootstrap
try {
  let drAirport = null;

  // 1️⃣ Try in-memory fast source
  const memResp = await chrome.runtime.sendMessage({
    type: "GET_LAST_AIRPORT"
  });

  if (memResp?.airport) {
    drAirport = memResp.airport;
  }

  // 2️⃣ Fallback to storage
  if (!drAirport) {
    const storageResp = await chrome.runtime.sendMessage({
      type: "GET_DR_AIRPORT"
    });
    drAirport = storageResp?.airport;
  }

  if (/^[A-Z]{4}$/.test(drAirport)) {
    const input = document.getElementById("airportInput");
    if (input) {
      input.value = drAirport;
      console.log("ICAO synced:", drAirport);
      const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh && drAirport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(drAirport);
}
    }

  }

} catch (err) {
  console.warn("ICAO bootstrap failed:", err);
}
  const refreshBtn = document.getElementById("icaoRefreshBtn");

  const waypointSearch = document.getElementById("waypointSearch");

  const waypointClearBtn = document.getElementById("waypointClearBtn");

function updateWaypointClearUI() {
  if (!waypointSearch || !waypointClearBtn) return;
  const hasText = waypointSearch.value.trim().length > 0;
  waypointClearBtn.style.display = hasText ? "block" : "none";
}


chrome.storage.local.get(
  ["sandcat_search_settings", "nearby_cache"],
  (data) => {

    const radiusInput = document.getElementById("radiusNm");
    const maxResultsInput = document.getElementById("maxResults");

    const settings = data.sandcat_search_settings || {};

    if (radiusInput) {
      radiusInput.value = settings.radius_nm || 25;
    }

    if (maxResultsInput) {
      maxResultsInput.value = settings.max_results || 25;
    }

    /* 🔥 Instant cache restore */
    if (data.nearby_cache?.results?.length) {

      MASTER_RESULTS = data.nearby_cache.results;

      renderResults(
        MASTER_RESULTS,
        data.nearby_cache.center
      );

      console.log("Restored nearby airport cache");
    }

const airport = document.getElementById("airportInput")?.value;

if (airport && airport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(airport);
}
  }
);

document
  .getElementById("procGlobalToggle")
  ?.addEventListener("change", () => {

    const q = document
      .getElementById("waypointSearch")
      ?.value
      ?.trim();

    if (q?.length >= 2) {
      searchWaypoints(q);
    }

});

function clearWaypointSearch() {
  if (!waypointSearch) return;

  waypointSearch.value = "";
  updateWaypointClearUI();

  clearTimeout(waypointDebounce);
  WAYPOINT_SEARCH_TOKEN++;

  // restore normal view
  renderResults(MASTER_RESULTS, LAST_CENTER);

  // optional: put cursor back in box
  waypointSearch.focus();
}

if (waypointSearch) {
  waypointSearch.addEventListener("input", () => {
    updateWaypointClearUI();

    const q = waypointSearch.value.trim();
    clearTimeout(waypointDebounce);

waypointDebounce = setTimeout(() => {

  const token = ++WAYPOINT_SEARCH_TOKEN;

  if (q.length < 2) {
    renderResults(MASTER_RESULTS, LAST_CENTER);
    return;
  }

  const global = document
    .getElementById("procGlobalToggle")
    ?.checked;

  if (global) {
    runProcedureSearch(q);
  } else {
    searchWaypoints(q, token);
  }

}, 250);
  });

  // nice: ESC clears too
  waypointSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clearWaypointSearch();
    }
  });

  // initialize state on load
  updateWaypointClearUI();
}

waypointClearBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearWaypointSearch();
});



if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {

    console.log("Manual ICAO refresh triggered");

    const { lb_pageKey } = await chrome.storage.local.get("lb_pageKey");

    if (!lb_pageKey) {
      console.warn("No lb_pageKey found.");
      return;
    }

    const newAirport = extractICAOFromKey(lb_pageKey);

    if (!/^[A-Z]{4}$/.test(newAirport)) {
      console.warn("Invalid ICAO extracted:", newAirport);
      return;
    }

    const input = document.getElementById("airportInput");

    if (!input) return;

    input.value = newAirport;

    console.log("ICAO refreshed to:", newAirport);

    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  queryNearby(false);
}
  });
}


  const { nearby_cache } =
    await chrome.storage.local.get(["nearby_cache"]);

 
const radiusInput = document.getElementById("radiusNm");
const maxResultsInput = document.getElementById("maxResults");

function saveSearchSettings() {
  chrome.storage.local.set({
    sandcat_search_settings: {
      radius_nm: Number(radiusInput?.value || 25),
      max_results: Number(maxResultsInput?.value || 25)
    }
  });
}

radiusInput?.addEventListener("input", saveSearchSettings);
maxResultsInput?.addEventListener("input", saveSearchSettings);


const facilitySearch = document.getElementById("facilitySearch");

facilitySearch?.addEventListener("input", () => {

  const q = facilitySearch.value.trim().toUpperCase();

  const items = document.querySelectorAll("#facilityContent .facilityItem");

  items.forEach(item => {

    const text = item.textContent.toUpperCase();

    if(!q || text.includes(q)){
      item.style.display = "";
    } else {
      item.style.display = "none";
    }

  });

});



  // 🔥 Attach fuzzy listener HERE (outside DOMContentLoaded)
  const resultsSearch = document.getElementById("resultsSearch");

  if (resultsSearch) {
    resultsSearch.addEventListener("input", () => {

      const query = resultsSearch.value.trim();

      if (!MASTER_RESULTS.length) return;

      const filtered = MASTER_RESULTS.filter(a =>
        fuzzyMatchAirport(a, query)
      );

      renderResults(filtered, LAST_CENTER);
    });
  }

let LAST_AUTOLAUNCHED_ICAO = null;

let LAST_AUTOLAUNCHED_RAW = null;

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
if (!changes.lb_pageKey?.newValue) return;

const newRaw = changes.lb_pageKey.newValue;
handleNewPageKey(newRaw);

  if (!newRaw || newRaw === LAST_AUTOLAUNCHED_RAW) return;

  LAST_AUTOLAUNCHED_RAW = newRaw;

  // 🔹 Update LBX key display
const lbxKeyEl = document.getElementById("lbxKey");
if (lbxKeyEl) {
  lbxKeyEl.value = newRaw;
}

  // 🔹 Extract ICAO
  const newAirport = extractICAOFromKey(newRaw);
  if (!/^[A-Z]{4}$/.test(newAirport)) return;

  const input = document.getElementById("airportInput");
  if (!input) return;

  if (input.value !== newAirport) {
    input.value = newAirport;
    console.log("Auto ICAO sync:", newAirport);
    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(newAirport);
}
  }

  // 🔹 Auto-launch
const rawText = newRaw;
if (!rawText) return;

const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

chrome.runtime.sendMessage({
  type: "RUN_AUTOLAUNCH",
  rawText,
  settings: lbx_settings || {}
});
});

async function runInitialAutomation() {
  const { lb_pageKey, lbx_settings } =
  await chrome.storage.local.get(["lb_pageKey", "lbx_settings"]);

if (!lb_pageKey) return;

LAST_AUTOLAUNCHED_RAW = lb_pageKey;

const airport = extractICAOFromKey(lb_pageKey);
  if (!/^[A-Z]{4}$/.test(airport)) return;

  const input = document.getElementById("airportInput");
  if (input) {
    input.value = airport;
    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(airport);
}
  }

  chrome.runtime.sendMessage({
    type: "RUN_AUTOLAUNCH",
    rawText: lb_pageKey,
    settings: lbx_settings || {}
  });
}

await runInitialAutomation();


chrome.runtime.sendMessage(
    { type: "GET_LAST_AIRPORT" },
    (res) => {

      if (!res?.ok || !res.airport) return;

      const input = document.getElementById("airportInput");
      if (!input) return;

      input.value = res.airport;

      // 🔥 trigger search automatically
     if (res.airport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(res.airport);
}
    }
  );


async function checkSelectedAircraft(){

  const data = await chrome.storage.local.get("adsb_selected_flight");

  const flight = data.adsb_selected_flight;

  if(!flight) return;

  const infoBox = document.getElementById("flightAnalysis");
if (!infoBox) return;

  infoBox.innerHTML = `
<div class="analysisBlock">
  <div class="analysisHeader">Selected Aircraft</div>
  <div>ICAO: ${flight.icao}</div>
  <div>Callsign: ${flight.callsign || "Unknown"}</div>
  <div>Altitude: ${flight.altitude || "-"}</div>
  <div>Speed: ${flight.speed || "-"}</div>
</div>
`;

  const trimmed = extractCurrentLeg(flight.coords);

  await analyzeTrack(trimmed);

}


async function getAdsbRoute() {

  const tabs = await chrome.tabs.query({
    url: "*://globe.adsbexchange.com/*"
  });

  if (!tabs.length) {
    console.warn("ADS-B tab not found");
    return null;
  }

  const tabId = tabs[0].id;

  return new Promise(resolve => {

    chrome.runtime.sendMessage({
      type: "GET_ADSB_ROUTE_FROM_TAB",
      tabId
    }, res => {

      if (!res?.ok) {
        console.warn("Route fetch failed");
        resolve(null);
      } else {
        resolve(res.coords);
      }

    });

  });

}

function flattenRoute(track) {
  return track;   // already flat
}

async function findWaypointsAlongRoute(track) {

  const points = flattenRoute(track);

  if (!points.length) return [];

  const found = new Set();
  const results = [];

  // sample every Nth point so we don't overload
  const STEP = 6;

  for (let i = 0; i < points.length; i += STEP) {

    const {lat, lon} = points[i];

    const resp = await chrome.runtime.sendMessage({
      type: "SEARCH_WAYPOINTS_NEAR",
      lat,
      lon,
      radius_nm: 8
    });

    if (!resp?.ok) continue;

    for (const fix of resp.fixes) {

      const id = fix.ident;

      if (found.has(id)) continue;

      found.add(id);
      results.push(fix);
    }
  }

  return results;
}

document.getElementById("adsbClearFlight")?.addEventListener("click", async () => {

  // wipe UI immediately
  const routeBox = document.getElementById("routeResults");
  if (routeBox) {
    routeBox.innerHTML = "<div class='routeFix'>No active flight</div>";
  }

  const analysis = document.getElementById("routeAnalysis");
  if (analysis) analysis.innerHTML = "";

  // reset globals
  window.activeFlightCallsign = null;
  window.activeFlightOrigin = null;
  window.activeFlightDest = null;

  // tell background to wipe flight
  await chrome.runtime.sendMessage({
    type: "CLEAR_ACTIVE_FLIGHT"
  });

});

document.getElementById("importAdsbRoute")
?.addEventListener("click", async () => {

  const track = await getAdsbRoute();

  if (!track) {
    alert("No aircraft selected in ADS-B Exchange");
    return;
  }

  const fixes = await findWaypointsAlongRoute(track);

  renderRouteWaypoints(fixes);
});

async function renderRouteWaypoints(fixes) {

  const container = document.getElementById("routeResults");
  container.innerHTML = "";

  for (const fx of fixes) {

    const row = document.createElement("div");
    row.className = "routeFix";

    let label = fx.ident;

const nav = NAVAIDS?.[fx.ident];

if (nav) {
  label = `${fx.ident} — ${nav.name}`;
}

    row.textContent = label;

    row.addEventListener("click", async () => {
  await copyTextSafe(fx.ident.toUpperCase());
});

    container.appendChild(row);
  }
}


  /* =============================
     LBX FUNCTIONAL WIRING
  ============================== */

  const lbxKeyEl = document.getElementById("lbxKey");


if (lbxKeyEl) {

  // Resize on typing
  lbxKeyEl.addEventListener("input", () => {
  autoResizeTextarea(lbxKeyEl);

  chrome.storage.local.set({
    lb_manualKey: lbxKeyEl.value.trim()
  });
});

  // Resize once on load (after value restored)
  setTimeout(() => autoResizeTextarea(lbxKeyEl), 0);
}

  const openBtn = document.getElementById("lbxOpenNow");

  const optAdsb = document.getElementById("opt_adsb");
  const optOpenNav = document.getElementById("opt_opennav");
  const optAirNav = document.getElementById("opt_airnav");

  const speedSlider = document.getElementById("adsbSpeed");
  const speedText = document.getElementById("adsbSpeedText");


  /* ---------- Restore Settings ---------- */

  chrome.storage.local.get(
  ["lb_pageKey", "lb_manualKey", "lbx_settings"],
  (data) => {

    const displayKey = data.lb_pageKey || data.lb_manualKey || "";
    

    if (lbxKeyEl) {
      lbxKeyEl.value = displayKey;
      autoResizeTextarea(lbxKeyEl);
    }

    const settings = data.lbx_settings || {};

    if (optAdsb) optAdsb.checked = !!settings.adsb;
    if (optOpenNav) optOpenNav.checked = !!settings.opennav;
    if (optAirNav) optAirNav.checked = !!settings.airnav;
    if (optFixesFinder) optFixesFinder.checked = !!settings.fixesfinder;

    if (speedSlider && settings.adsbSpeed) {
      speedSlider.value = settings.adsbSpeed;
    }

    if (speedText && settings.adsbSpeed) {
      speedText.value = settings.adsbSpeed;
    }
  }
);




chrome.storage.local.get("sandcat_radius_nm", (data) => {

  const radiusInput = document.getElementById("radiusNm");

  if (!radiusInput) return;

  if (data.sandcat_radius_nm) {
    radiusInput.value = data.sandcat_radius_nm;
  } else {
    radiusInput.value = 25;
  }

});

async function preloadProcedureMaps(origin, dest){

  async function loadProcedures(airport, type){

    if(!airport) return;

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport,
      procType:type
    });

    for(const p of resp?.procs || []){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:type,
        procName:p.name,
        procCode:p.code
      });

      for(const fx of fixesResp?.fixes || []){

        const key = fx.toUpperCase();

        if(!FIX_PROCEDURE_MAP[key]){
          FIX_PROCEDURE_MAP[key] = [];
        }

        FIX_PROCEDURE_MAP[key].push({
          type:type === "DP" ? "SID" : "STAR",
          proc:p.code,
          procDisplay:p.displayName || p.code.split(".")[1]
        });

      }

    }

  }

  /* SID */
  await loadProcedures(origin,"DP");

  /* STAR */
  await loadProcedures(dest,"STAR");


  /* IAP (approaches) */
  if(dest){

    const airportData = MASTER_RESULTS
      ?.find(a => a.ident === dest);

    const approaches = airportData?.approaches || [];

    for(const ap of approaches){

      const resp = await chrome.runtime.sendMessage({
        type:"GET_IAP_FIXES",
        airportIdent:dest,
        approachName:ap
      });

      for(const fx of resp?.fixes || []){

        const key = fx.toUpperCase();

        if(!FIX_PROCEDURE_MAP[key]){
          FIX_PROCEDURE_MAP[key] = [];
        }

        FIX_PROCEDURE_MAP[key].push({
          type:"IAP",
          proc:ap,
          procDisplay:ap
        });

      }

    }

  }

}

async function refreshActiveFlightPanel(){

  console.log("REFRESHING ACTIVE PANEL");

  const renderId = ++ACTIVE_ROUTE_RENDER;

  const list = document.getElementById("routeResults");
  if(list && !list.children.length){
  list.innerHTML = "";
}

  const data = await chrome.storage.local.get([
  "adsb_active_flight_callsign",
  "adsb_active_flight_info",
  "adsb_active_flight_origin",
  "adsb_active_flight_destination",
  "adsb_active_flight_fixes"
]);

  if(renderId !== ACTIVE_ROUTE_RENDER) return;

window.activeFlightCallsign =
  data.adsb_active_flight_callsign ||
  data.adsb_active_flight_info?.callsign ||
  null;
  window.activeFlightOrigin = data.adsb_active_flight_origin || null;
  window.activeFlightDest = data.adsb_active_flight_destination || null;

  const routeBox = document.getElementById("routeResults");
  if(!routeBox) return;

  let fixes = (data.adsb_active_flight_fixes || []).map(f => f.toUpperCase());
  await preloadProcedureMaps(
  window.activeFlightOrigin,
  window.activeFlightDest
);

  if (!fixes.length) {

  routeBox.innerHTML =
    "<div class='routeFix'>Reconstructing route…</div>";

  chrome.runtime.sendMessage({
    type: "RECONSTRUCT_ADSB_ROUTE"
  });

  return;
}

  if(fixes.length > 100){
    fixes = fixes.slice(0,100);
  }

  await applyActiveFlightFixesToUI(fixes);

const origin = window.activeFlightOrigin;
const dest = window.activeFlightDest;

let originName = AIRPORT_NAME_MAP[origin] || "";
let destName = AIRPORT_NAME_MAP[dest] || "";

// fallback if not already loaded
if (!originName && origin) {
  const resp = await chrome.runtime.sendMessage({
    type: "GET_AIRPORT_NAME",
    ident: origin
  });
  originName = resp?.name || "";
}

if (!destName && dest) {
  const resp = await chrome.runtime.sendMessage({
    type: "GET_AIRPORT_NAME",
    ident: dest
  });
  destName = resp?.name || "";
}

renderFlightAnalysis(
  null,
  fixes,
  { ident: origin, name: originName },
  { ident: dest, name: destName },
  null
);

  if(renderId !== ACTIVE_ROUTE_RENDER) return;
}


  /* ---------- Persist Settings ---------- */
const optForeflight = document.getElementById("opt_foreflight");
const optFixesFinder = document.getElementById("opt_fixesfinder");
  function saveLBXSettings() {
    chrome.storage.local.set({
      lbx_settings: {
        adsb: optAdsb?.checked,
        opennav: optOpenNav?.checked,
        airnav: optAirNav?.checked,
        fixesfinder: optFixesFinder?.checked,
        adsbSpeed: Number(speedSlider?.value || 1),
        foreflight: optForeflight?.checked,
      }
    });
  }

  optAdsb?.addEventListener("change", saveLBXSettings);
  optOpenNav?.addEventListener("change", saveLBXSettings);
  optAirNav?.addEventListener("change", saveLBXSettings);
  optFixesFinder?.addEventListener("change", saveLBXSettings);

  /* ---------- Slider Sync ---------- */

  if (speedSlider && speedText) {

    speedSlider.addEventListener("input", () => {
      speedText.value = speedSlider.value;
      saveLBXSettings();
    });

    speedText.addEventListener("input", () => {
      const v = Number(speedText.value || 1);
      if (!isNaN(v)) {
        speedSlider.value = v;
        saveLBXSettings();
      }
    });
  }

  /* ---------- Open Selected Now ---------- */

openBtn?.addEventListener("click", async () => {

  const { lbx_settings } =
    await chrome.storage.local.get(["lbx_settings"]);

  const rawText = lbxKeyEl?.value.trim();
  if (!rawText) return;

  chrome.runtime.sendMessage({
    type: "RUN_AUTOLAUNCH",
    rawText,
    settings: lbx_settings || {}
  });
});


document.getElementById("refreshKeyBtn")?.addEventListener("click", async () => {

  const status = document.getElementById("refreshStatus");
  status.textContent = "Syncing...";

  let rawKey = null;

  // 1️⃣ Try grabbing fresh key from active tab
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (tab?.id) {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "MANUAL_GRAB_GLOBAL_KEY"
      });

      if (res?.ok && res.key) {
        rawKey = res.key;
        await chrome.storage.local.set({ lb_pageKey: rawKey });
        // 🔥 Manually run the same logic as storage listener
handleNewPageKey(rawKey);
      }
    }
  } catch (err) {
    // ignore and fallback
  }

  // 2️⃣ Fallback to saved key
  if (!rawKey) {
    const data = await chrome.storage.local.get("lb_pageKey");
rawKey = data.lb_pageKey;
  }

  if (!rawKey) {
    status.textContent = "Global key not found.";
    setTimeout(() => status.textContent = "", 2000);
    return;
  }

  // 🔥 Extract ICAO
  const icao = extractICAOFromKey(rawKey);

  if (!/^[A-Z]{4}$/.test(icao)) {
    status.textContent = "Invalid ICAO.";
    setTimeout(() => status.textContent = "", 2000);
    return;
  }

  // 🔥 Replace airport input
  const input = document.getElementById("airportInput");
  if (input) input.value = icao;

  // 🔥 Force search
  const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(icao);
}

  status.textContent = "Synced ✓";
  setTimeout(() => status.textContent = "", 2000);
});

document.getElementById("pasteKeyBtn")?.addEventListener("click", () => {

  const status = document.getElementById("refreshStatus");

  try {
    const textarea = document.createElement("textarea");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    document.body.appendChild(textarea);
    textarea.focus();

    const success = document.execCommand("paste");

    if (!success) {
      status.textContent = "Clipboard blocked.";
      document.body.removeChild(textarea);
      return;
    }

    const rawKey = textarea.value.trim();
    document.body.removeChild(textarea);

    if (!rawKey) {
      status.textContent = "Clipboard empty.";
      return;
    }

    chrome.storage.local.set({ lb_manualKey: rawKey });

    const lbxKeyEl = document.getElementById("lbxKey");
    if (lbxKeyEl) lbxKeyEl.value = rawKey;

    const icao = extractICAOFromKey(rawKey);

    const airportInput = document.getElementById("airportInput");
    if (airportInput && /^[A-Z]{4}$/.test(icao)) {
      airportInput.value = icao;
      queryNearby();
    }

    status.textContent = "Pasted ✓";

  } catch (err) {
    status.textContent = "Clipboard blocked.";
  }

});





/* =============================
   PANEL TOGGLE WIRING (FINAL)
============================= */

const overlayRoot = document.getElementById("overlayRoot");
const facilityPanel = document.getElementById("facilityPanel");
const lbxPanel = document.getElementById("lbxPanel");
const facilityHeader = facilityPanel?.querySelector(".panel-header");
const lbxHeader = document.getElementById("lbxTitle");

const routePanel = document.getElementById("routePanel");
const routeTitle = document.getElementById("routeTitle");

const airportSearchPanel = document.getElementById("airportSearchPanel");
const airportSearchTitle = document.getElementById("airportSearchTitle");

if (routePanel) {
  routePanel.addEventListener("click", (e) => {
    const isOpen = overlayRoot.classList.contains("route-open");

    if (!isOpen) {
      overlayRoot.classList.add("route-open");
    } else {
      if (e.target.closest("#routeTitle")) {
        overlayRoot.classList.remove("route-open");
      }
    }
  });
}

if (airportSearchPanel) {
  airportSearchPanel.addEventListener("click", (e) => {
    const isOpen = overlayRoot.classList.contains("airportsearch-open");

    if (!isOpen) {
      overlayRoot.classList.add("airportsearch-open");
    } else {
      if (e.target.closest("#airportSearchTitle")) {
        overlayRoot.classList.remove("airportsearch-open");
      }
    }

    chrome.storage.local.set({
      airportSearchOpen: overlayRoot.classList.contains("airportsearch-open")
    });
  });
}

if (overlayRoot && facilityPanel && lbxPanel) {

  // Restore saved state
chrome.storage.local.get(["facilityOpen", "lbxOpen", "airportSearchOpen"], (data) => {
  if (data.facilityOpen) overlayRoot.classList.add("facility-open");
  if (data.lbxOpen) overlayRoot.classList.add("lbx-open");
  if (data.airportSearchOpen) overlayRoot.classList.add("airportsearch-open");
});

  /* ========= FACILITY ========= */

  facilityPanel.addEventListener("click", (e) => {

    const isOpen = overlayRoot.classList.contains("facility-open");

    if (!isOpen) {
      // collapsed → open on ANY click
      overlayRoot.classList.add("facility-open");
    } else {
      // open → only collapse if header clicked
      if (e.target.closest(".panel-header")) {
        overlayRoot.classList.remove("facility-open");
      }
    }

    chrome.storage.local.set({
      facilityOpen: overlayRoot.classList.contains("facility-open")
    });
  });

  /* ========= LBX ========= */

  lbxPanel.addEventListener("click", (e) => {

    const isOpen = overlayRoot.classList.contains("lbx-open");

    if (!isOpen) {
      overlayRoot.classList.add("lbx-open");
    } else {
      if (e.target.closest("#lbxTitle")) {
        overlayRoot.classList.remove("lbx-open");
      }
    }

    chrome.storage.local.set({
      lbxOpen: overlayRoot.classList.contains("lbx-open")
    });
  });

}

chrome.storage.onChanged.addListener(async (changes, area) => {

  if (area !== "local") return;

  if (
    changes.adsb_active_flight_fixes ||
    changes.adsb_active_flight_callsign ||
    changes.adsb_active_flight_origin ||
    changes.adsb_active_flight_destination
  ) {

    await refreshActiveFlightPanel();

  }

});

try {
  await refreshActiveFlightPanel();
} catch (err) {
  console.error("Active flight panel failed:", err);
}

})();


const flightSearch = document.getElementById("flightFixSearch");

flightSearch?.addEventListener("input", async () => {

  const q = flightSearch.value.trim().toUpperCase();

  const data = await chrome.storage.local.get("adsb_active_flight_fixes");

  let fixes = data.adsb_active_flight_fixes || [];

  if(q){

    fixes = fixes
      .map(f => {

        const nav = NAVAIDS?.[f];
        let score = soundScore(f, q);

        if(nav?.name){

          const nameUpper = nav.name.toUpperCase();

            // ⭐ put it HERE
  if(nameUpper.startsWith(q))
    score = Math.max(score, 150);

          if(nameUpper.includes(q))
            score = Math.max(score, 120);

          score = Math.max(
            score,
            soundScore(
              nameUpper.replace(/[^A-Z]/g,""),
              q
            )
          );
        }

        return { fix: f, score };

      })
      .filter(r => r.score > 10)
      .sort((a,b)=>b.score-a.score)
      .map(r=>r.fix);

  }

  applyActiveFlightFixesToUI(fixes);

});


// Re-render when filter toggled
document.getElementById("filterNoApproaches")
  ?.addEventListener("change", () => {
    renderResults(MASTER_RESULTS, LAST_CENTER);
  });

document
.getElementById("analyzeReplayBtn")
?.addEventListener("click", analyzeReplay);

async function analyzeReplay(){

  const url = document
    .getElementById("replayUrlInput")
    .value
    .trim();

  if(!url){
    alert("Paste an ADS-B replay URL first.");
    return;
  }

  const coords = await getAdsbRoute();

  if(!coords?.length){
    alert("Could not extract route from ADS-B page.");
    return;
  }

  await analyzeTrack(coords);
}

document.getElementById("refreshActiveFlightBtn")
?.addEventListener("click", async (e) => {

  const btn = e.currentTarget;

  btn.textContent = "Refreshing…";

 const resp = await chrome.runtime.sendMessage({
  type: "RECONSTRUCT_ADSB_ROUTE"
});

if(!resp?.ok){
  console.warn("Route reconstruction failed");
}

    await refreshActiveFlightPanel();

  btn.textContent = "✓";

  setTimeout(() => {
    btn.textContent = "↻";
  }, 800);

});


async function analyzeRoute(route){

  const tokens = route
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);

  const fixes = [];

  for(let i=0;i<tokens.length;i++){

    const token = tokens[i];

    // airway expansion
    if(token.match(/^[A-Z]\d+$/)){

      const entry = tokens[i-1];
      const exit = tokens[i+1];

      if(!entry || !exit) continue;

      const res = await chrome.runtime.sendMessage({
        type:"EXPAND_AIRWAY",
        airway:token,
        entry,
        exit
      });

      if(res?.ok){
        fixes.push(...res.fixes);
      }

      continue;
    }

    // procedure lookup
    const proc = await chrome.runtime.sendMessage({
      type:"GET_PROC_FIXES_BY_NAME",
      name:token
    });

    if(proc?.ok){
      fixes.push(...proc.fixes);
      continue;
    }

    // plain fix
    fixes.push(token);

  }

  renderFlightAnalysis(route, fixes);
}

function dedupeFixes(fixes){

  const out = [];

  for(const fx of fixes){

    if(out.length === 0 || out[out.length-1] !== fx){
      out.push(fx);
    }

  }

  return out;
}

function renderFlightAnalysis(route, fixes, origin, dest, procedures){

  const container = document.getElementById("routeAnalysis");
  if(!container) return;

  container.innerHTML = "";

  const analysis = document.createElement("div");
  analysis.className = "analysisBox";

const callsign =
  window.activeFlightCallsign ||
  "Unknown";

  function isAirport(code){
  return /^[A-Z]{4}$/.test(code);
}

const originCode =
  isAirport(origin?.ident)
    ? origin.ident
    : isAirport(origin)
    ? origin
    : window.activeFlightOrigin || "?";

const destCode =
  isAirport(dest?.ident)
    ? dest.ident
    : isAirport(dest)
    ? dest
    : window.activeFlightDest || "?";

/* Flight */
const od = document.createElement("div");
od.className = "analysisBlock";

const originName = origin?.name || originCode;
const destName   = dest?.name   || destCode;

od.innerHTML = `
  <div class="analysisHeader">Flight</div>

  <div class="flightCallsign">
    ✈ ${callsign}
  </div>

  <div class="flightRoute">

    <div class="flightAirport">
      ${originName} <span class="airportCode">(${originCode})</span>
    </div>

    <div class="flightArrow">↓</div>

    <div class="flightAirport">
      ${destName} <span class="airportCode">(${destCode})</span>
    </div>

  </div>
`;

analysis.appendChild(od);

  /* Procedures */
  if(procedures?.sid || procedures?.star){

    const procBlock = document.createElement("div");
    procBlock.className = "analysisBlock";

    procBlock.innerHTML = `
      <div class="analysisHeader">Procedures</div>
      <div>SID: ${procedures.sid || "-"}</div>
      <div>STAR: ${procedures.star || "-"}</div>
    `;

    analysis.appendChild(procBlock);
  }

  if(origin?.name && dest?.name){

  const routeHeader = document.getElementById("flightRouteHeader");

  if(routeHeader){

    routeHeader.innerHTML = `
      ${origin.ident} → ${dest.ident}
      <div class="routeSub">
        ${origin.name} → ${dest.name}
      </div>
    `;

  }

}

  container.appendChild(analysis);
}


function extractCurrentLeg(track){

  if(!track?.length) return track;

  let takeoff = 0;
  let landing = track.length - 1;

  // detect last takeoff
  for(let i=1;i<track.length;i++){

    const prev = track[i-1];
    const cur  = track[i];

    if(
      prev.alt < 800 &&
      prev.gs < 40 &&
      cur.alt > 2000 &&
      cur.gs > 120
    ){
      takeoff = i;
    }

  }

  // detect landing
  for(let i=takeoff;i<track.length;i++){

    const p = track[i];

    if(
      p.alt < 800 &&
      p.gs < 40 &&
      i > takeoff + 200
    ){
      landing = i;
      break;
    }

  }

  return track.slice(takeoff, landing);
}


async function analyzeTrack(coords){

  const sampled = [];

  for (let i = 0; i < coords.length; i += 6) {

    sampled.push({
      lat: coords[i].lat,
      lon: coords[i].lon
    });

  }

  // Step 1: detect fix sequence
  const fixSequence = await chrome.runtime.sendMessage({
    type: "DETECT_FIX_SEQUENCE",
    track: sampled
  });

  if(!fixSequence?.ok){
    alert("Fix detection failed");
    return;
  }

let origin = null;
let dest = null;

try {

// determine direction automatically

const firstIndex = Math.min(40, coords.length - 1);
const lastIndex  = Math.max(coords.length - 40, 0);

const first = coords[firstIndex];
const last  = coords[lastIndex];

const airportA = await findNearestAirport(first.lat, first.lon);
const airportB = await findNearestAirport(last.lat, last.lon);

if (!airportA || !airportB) {
  origin = airportA;
  dest = airportB;
} else {

  // distance helper
  function dist(a,b){
    const dx = a.lat - b.lat;
    const dy = a.lon - b.lon;
    return Math.sqrt(dx*dx + dy*dy);
  }

  const firstToA = dist(first, airportA);
  const lastToA  = dist(last, airportA);

  // whichever point is closer to airportA is the origin
  if(firstToA < lastToA){
    origin = airportA;
    dest   = airportB;
  }else{
    origin = airportB;
    dest   = airportA;
  }

}

} catch {}

const procedures = await detectProcedures(
  fixSequence.fixes,
  origin?.ident,
  dest?.ident
);
await chrome.storage.local.set({
  adsb_active_flight_origin: origin?.ident || null,
  adsb_active_flight_destination: dest?.ident || null
});
renderFlightAnalysis(
  fixSequence.routeString || "TRACK RECONSTRUCTED",
  fixSequence.fixes || [],
  origin,
  dest,
  procedures
);
}

if (typeof initAirportSearch === "function") {
  initAirportSearch();
}