// background.js — ADSB Waypoints Extension
// Loads cifp.zip, parses all fixes/waypoints worldwide, serves them to the content script
// Uses IndexedDB to cache parsed data across service worker restarts (MV3)

importScripts("fflate.js", "sound_map.js");

// ─── State ────────────────────────────────────────────────────────────────────
let FIXES = [];          // [{ident, lat, lon, type}]
let READY = false;
let LOADING = false;     // prevent double-loading

// ─── IndexedDB caching ────────────────────────────────────────────────────────
const DB_NAME = "AdsbWptCache";
const STORE_NAME = "fixes";
const CACHE_VERSION = 11; // Bumped: worldwide data — removed US-only filters

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFixes(fixes) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(fixes, "allFixes");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadFixesFromCache() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get("allFixes");
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch (_) {
    return null;
  }
}

// ─── CIFP lat/lon parser (FAA Arinc-424 format) ───────────────────────────────
function parseCifpLatLon(str) {
  const latHem = str[0];
  const latDeg = parseInt(str.substring(1, 3));
  const latMin = parseInt(str.substring(3, 5));
  const latSec = parseInt(str.substring(5, 9)) / 100;

  const lonHem = str[9];
  const lonDeg = parseInt(str.substring(10, 13));
  const lonMin = parseInt(str.substring(13, 15));
  const lonSec = parseInt(str.substring(15, 19)) / 100;

  let lat = latDeg + latMin / 60 + latSec / 3600;
  let lon = lonDeg + lonMin / 60 + lonSec / 3600;

  if (latHem === "S") lat *= -1;
  if (lonHem === "W") lon *= -1;

  return { lat, lon };
}

// ─── Unzip helper (uses fflate) ───────────────────────────────────────────────
function unzipRawFiles(u8) {
  return fflate.unzipSync(u8);
}

// ─── Determine fix type from CIFP record prefix ──────────────────────────────
// Format: S + area(US/PA) + subarea(A/C) + section code at index 4
//   D = Navaid (VOR/NDB), E = Enroute waypoint, P = Airport,
//   U = Airway intersection, H = Heliport/runway
// For navaids (xD), VOR vs NDB is determined by navaid class at chars 27-31:
//   V=VOR, D=DME, T=TACAN → "vor";  H=NDB, M=MarineNDB without V/T → "ndb"
function lineType(line) {
  const sec = line[4]; // Section code: D, E, P, U, H, etc.

  if (sec === 'D') {
    // Navaid record — check navaid class field (chars 27-31) for VOR vs NDB
    const navClass = line.substring(27, 32);
    const hasVorIndicator = /[VDT]/.test(navClass);
    return hasVorIndicator ? "vor" : "ndb";
  }
  if (sec === 'E') return "fix";        // Enroute waypoint (5-letter ident)
  if (sec === 'U') return "intersect";  // Airway fix / intersection
  if (sec === 'P') return "airport";    // Airport procedure waypoint
  if (sec === 'H') return "airport";    // Heliport
  return "fix";
}

// ─── Main CIFP loader ─────────────────────────────────────────────────────────
async function loadCifp() {
  if (READY || LOADING) return;
  LOADING = true;

  try {
    // 1. Try loading from IndexedDB cache first (fast path for SW restarts)
    console.log("[WPT] Checking IndexedDB cache...");
    const cached = await loadFixesFromCache();
    if (cached && cached.length > 0) {
      FIXES = cached;
      READY = true;
      LOADING = false;
      console.log(`[WPT] Loaded ${FIXES.length} fixes from cache`);
      return;
    }

    // 2. Parse from cifp.zip
    console.log("[WPT] No cache found, loading cifp.zip...");
    const url = chrome.runtime.getURL("cifp.zip");
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed: " + res.status);

    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const files = unzipRawFiles(u8);

    // Find the CIFP file inside the zip (avoid PDFs/TXTs/XLSXs)
    const cifpName = Object.keys(files).find(k => 
      /FAACIFP/i.test(k) && !/\.(pdf|txt|xlsx|doc)$/i.test(k)
    );
    if (!cifpName) throw new Error("No CIFP file found in zip");

    const rawData = files[cifpName];
    const text = new TextDecoder("utf-8").decode(rawData);
    console.log("[WPT] CIFP loaded, length:", text.length);

    parseCifp(text);

    // 3. Cache parsed fixes to IndexedDB
    console.log("[WPT] Saving to IndexedDB cache...");
    await saveFixes(FIXES);
    console.log("[WPT] Cache saved successfully");

  } catch (e) {
    console.error("[WPT] Failed to load CIFP:", e);
  } finally {
    LOADING = false;
  }
}

function parseCifp(text) {
  const seen = new Set();       // exact dedup: ident + rounded coords
  const identCoords = new Map(); // ident → [{lat,lon}] for proximity dedup
  const lines = text.split(/\r?\n/);
  let count = 0;

  for (const line of lines) {
    // Process all CIFP records (S prefix = standard record)
    if (!line.startsWith("S")) continue;

    const coordMatch = line.match(/[NS]\d{8}[EW]\d{9}/);
    if (!coordMatch) continue;

    // Extract fix ident from columns 13-18
    const ident = line.substring(13, 18).trim();

    if (!ident || ident.length < 2) continue;
    if (/^\d/.test(ident)) continue;         // skip numeric-start garbage
    if (ident.startsWith("RW")) continue;    // skip runway designators
    if (!/^[A-Z][A-Z0-9]{1,4}$/.test(ident)) continue;

    try {
      const { lat, lon } = parseCifpLatLon(coordMatch[0]);

      // Basic sanity check — skip obviously invalid coordinates
      if (lat < -90 || lat > 90) continue;
      if (lon < -180 || lon > 180) continue;

      let type = lineType(line);

      // Waypoints (fixes/airports) must have exactly 5-letter idents.
      // Shorter idents that aren't VORs or NDBs are procedure/approach fixes
      // that belong visually with intersections, not named waypoints.
      if ((type === "fix" || type === "airport") && ident.length !== 5) {
        type = "intersect";
      }

      let name = undefined;
      let airport = undefined;

      if ((type === "vor" || type === "ndb") && line.length > 93) {
        name = line.substring(93, 123).trim();
      }

      // For P-section (airport procedure) records, cols 6-10 hold the airport ICAO
      if (line[4] === 'P' && line.length >= 10) {
        const icao = line.substring(6, 10).trim();
        if (icao && /^[A-Z0-9]{3,4}$/.test(icao)) airport = icao;
      }

      // Exact dedup: same ident + tightly rounded coords
      const dedupeKey = `${ident}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Proximity dedup: collapse identical idents that are close together
      // to prevent airway routes from becoming a solid line of redundant labels
      const existing = identCoords.get(ident);
      if (existing) {
        // Use a ~55km (0.5 degree) suppression radius for generic fixes/intersections
        // and a tighter ~5km (0.05 degree) radius for important distinct Navaids/Airports
        const threshold = (type === "intersect" || type === "fix") ? 0.5 : 0.05;
        const isDup = existing.some(e =>
          Math.abs(e.lat - lat) < threshold && Math.abs(e.lon - lon) < threshold
        );
        if (isDup) continue;
        existing.push({ lat, lon });
      } else {
        identCoords.set(ident, [{ lat, lon }]);
      }

      FIXES.push({ ident, lat, lon, type, name, airport });
      count++;
    } catch (_) {}
  }

  READY = true;
  console.log(`[WPT] Parsed ${count} fixes/waypoints from CIFP`);
}

// ─── Start loading immediately ────────────────────────────────────────────────
loadCifp();

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "INJECT_MAIN_SCRIPT") {
    if (sender.tab && sender.tab.id != null) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        files: ["content_main.js"],
        world: "MAIN"
      }).then(() => {
        console.log(`[WPT] Injected content_main.js into MAIN world on tab ${sender.tab.id}`);
        sendResponse({ ok: true });
      }).catch(err => {
        console.error(`[WPT] Injection failed:`, err);
        sendResponse({ ok: false, error: String(err) });
      });
      return true; // async response
    }
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.local.get(
      ["wpt_enabled", "wpt_showFixes", "wpt_showIntersects", "wpt_showVors", "wpt_showNdbs", "wpt_opacity", "wpt_showBtn", "wpt_labelSize", "wpt_scaleDot", "wpt_fixColor", "wpt_textColor"],
      (data) => {
        sendResponse({
          enabled:       data.wpt_enabled       !== undefined ? data.wpt_enabled       : true,
          showFixes:     data.wpt_showFixes      !== undefined ? data.wpt_showFixes     : true,
          showIntersects:data.wpt_showIntersects !== undefined ? data.wpt_showIntersects: true,
          showVors:      data.wpt_showVors       !== undefined ? data.wpt_showVors      : true,
          showNdbs:      data.wpt_showNdbs       !== undefined ? data.wpt_showNdbs      : true,
          opacity:       data.wpt_opacity        !== undefined ? data.wpt_opacity       : 0.92,
          showBtn:       data.wpt_showBtn         !== undefined ? data.wpt_showBtn        : true,
          labelSize:     data.wpt_labelSize       !== undefined ? data.wpt_labelSize      : 1.0,
          scaleDot:      data.wpt_scaleDot        !== undefined ? data.wpt_scaleDot       : false,
          fixColor:      data.wpt_fixColor        !== undefined ? data.wpt_fixColor       : "#3fb950",
          textColor:     data.wpt_textColor       !== undefined ? data.wpt_textColor      : "#3fb950",
        });
      }
    );
    return true; // async response
  }

  if (msg.type === "SET_SETTINGS") {
    const updates = {};
    if (msg.settings.enabled !== undefined) updates.wpt_enabled = msg.settings.enabled;
    if (msg.settings.opacity !== undefined) updates.wpt_opacity = msg.settings.opacity;
    if (msg.settings.showBtn !== undefined) updates.wpt_showBtn = msg.settings.showBtn;
    if (msg.settings.labelSize !== undefined) updates.wpt_labelSize = msg.settings.labelSize;
    if (msg.settings.scaleDot !== undefined) updates.wpt_scaleDot = msg.settings.scaleDot;
    if (msg.settings.fixColor !== undefined) updates.wpt_fixColor = msg.settings.fixColor;
    if (msg.settings.textColor !== undefined) updates.wpt_textColor = msg.settings.textColor;
    chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
    return true;
  }

  // ── SandCat fuzzy search helpers (shared by SEARCH_AIRPORT & SEARCH_FIX) ──
  function phoneticNormalize(s) {
    if (!s) return "";
    s = s.toUpperCase().replace(/[^A-Z]/g, "");
    const rules = [
      [/PH/g,"F"], [/CK/g,"K"], [/Q/g,"K"], [/X/g,"KS"],
      [/Z/g,"S"], [/DG/g,"J"], [/GH/g,"G"], [/KN/g,"N"], [/WR/g,"R"],
      [/EE/g,"I"], [/EA/g,"I"], [/IE/g,"I"], [/EY/g,"I"], [/AY/g,"I"],
      [/OO/g,"U"], [/OU/g,"U"],
      [/ISN/g,"SN"], [/YSN/g,"SN"]
    ];
    for (const [r, rep] of rules) s = s.replace(r, rep);
    s = s.replace(/Y/g, "I");
    s = s.replace(/(.)\1+/g, "$1");
    if (s.length > 1) s = s[0] + s.slice(1).replace(/[AEIOU]/g, "");
    return s;
  }
  function fuzzy(str, pattern) {
    let i = 0;
    for (const c of str) { if (c === pattern[i]) i++; if (i === pattern.length) return true; }
    return false;
  }
  function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
        else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }
  function consonantSkeleton(s) {
    if (!s) return "";
    return s.toUpperCase().replace(/[^A-Z]/g, "")
      .replace(/[AEIOU]/g, "").replace(/PH/g, "F")
      .replace(/CK/g, "K").replace(/Q/g, "K").replace(/Z/g, "S")
      .replace(/(.)\1+/g, "$1");
  }
  function soundScore(fix, query) {
    fix = String(fix || "").toUpperCase();
    query = String(query || "").toUpperCase();
    if (!fix || !query) return 0;
    const fixPh = phoneticNormalize(fix), qPh = phoneticNormalize(query);
    const fixSk = consonantSkeleton(fix), qSk = consonantSkeleton(query);
    let score = 0;
    score += Math.round(soundSimilarityScore(fix, query) * 3);
    if (fixPh === qPh) score += 200;
    if (fixSk === qSk && fixSk.length >= 2) score += 180;
    if (fixPh.includes(qPh) || qPh.includes(fixPh)) score += 120;
    if (fixSk.includes(qSk) || qSk.includes(fixSk)) score += 80;
    if (fix === query) score += 100;
    if (fix.startsWith(query)) score += 80;
    if (fix.includes(query)) score += 50;
    if (fuzzy(fix, query)) score += 40;
    const distPh = levenshtein(fixPh, qPh);
    score += Math.max(0, 40 - distPh * 6);
    const distRaw = levenshtein(fix, query);
    if (distRaw <= 3) score += [300, 200, 120, 60][distRaw];
    return score;
  }

  // ── Search by Airport ICAO ──────────────────────────────────────────────────
  if (msg.type === "SEARCH_AIRPORT") {
    if (!READY) { sendResponse({ fixes: [], count: 0 }); return; }
    const icao = (msg.icao || "").toUpperCase().trim();
    if (!icao) { sendResponse({ fixes: [], count: 0 }); return; }

    // Collect all fixes for this airport
    const airportFixes = FIXES.filter(f => f.airport === icao);

    const q = (msg.query || "").toUpperCase().trim();
    if (!q) {
      // No search query — return all fixes for this airport
      const result = airportFixes.slice(0, 100).map(f => ({
        ident: f.ident, lat: f.lat, lon: f.lon, type: f.type, name: f.name
      }));
      sendResponse({ fixes: result, count: airportFixes.length });
      return true;
    }

    // Score and sort airport fixes by fuzzy match
    const scored = [];
    for (const f of airportFixes) {
      let score = soundScore(f.ident, q);
      if (f.name) {
        const nameScore = soundScore(f.name.replace(/[^A-Z]/g, ""), q);
        score = Math.max(score, nameScore);
      }
      if (score > 0) scored.push({ fix: f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const result = scored.slice(0, 50).map(s => ({
      ident: s.fix.ident, lat: s.fix.lat, lon: s.fix.lon,
      type: s.fix.type, name: s.fix.name
    }));
    sendResponse({ fixes: result, count: airportFixes.length });
    return true;
  }
  if (msg.type === "OPEN_POPUP") {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().then(() => sendResponse({ ok: true })).catch(err => {
        console.error("[WPT] Could not open popup:", err);
        sendResponse({ ok: false, error: String(err) });
      });
    } else {
      sendResponse({ ok: false, error: "openPopup not supported" });
    }
    return true;
  }

  if (msg.type === "GET_STATUS") {
    // If not ready, try loading (handles SW restart case)
    if (!READY && !LOADING) {
      loadCifp().then(() => {
        sendResponse({ ready: READY, count: FIXES.length });
      });
      return true; // async response
    }
    sendResponse({ ready: READY, count: FIXES.length });
    return true;
  }

  // Content script asks for fixes in a bounding box
  if (msg.type === "GET_FIXES_IN_BBOX") {
    const respond = () => {
      if (!READY) { sendResponse({ fixes: [] }); return; }
      const { minLat, maxLat, minLon, maxLon, types } = msg;
      const typeSet = new Set(types || ["fix", "vor", "ndb"]);
      const result = FIXES.filter(f =>
        f.lat >= minLat && f.lat <= maxLat &&
        f.lon >= minLon && f.lon <= maxLon &&
        typeSet.has(f.type)
      );
      sendResponse({ fixes: result });
    };

    if (!READY && !LOADING) {
      loadCifp().then(respond);
    } else if (LOADING) {
      // Wait for loading to finish
      const waitForReady = () => {
        if (READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  // Search for fixes by ident — SandCat fuzzy search algorithm
  if (msg.type === "SEARCH_FIX") {
    const respond = () => {
      if (!READY) { sendResponse({ fixes: [] }); return; }
      const q = (msg.query || "").trim().toUpperCase();
      if (!q) { sendResponse({ fixes: [] }); return; }

      // ── Score all fixes ──
      const bboxFilter = msg.bbox || null;
      const scored = [];

      for (const f of FIXES) {
        if (bboxFilter) {
          const { minLat, maxLat, minLon, maxLon } = bboxFilter;
          if (f.lat < minLat || f.lat > maxLat || f.lon < minLon || f.lon > maxLon) continue;
        }
        let score = soundScore(f.ident, q);
        if (f.name) {
          const nameScore = soundScore(f.name.replace(/[^A-Z]/g, ""), q);
          score = Math.max(score, nameScore);
          const nameUpper = f.name.toUpperCase();
          if (nameUpper.includes(q)) score = Math.max(score, 90);
        }
        if (score > 0) {
          scored.push({ fix: f, score });
        }
      }

      scored.sort((a, b) => b.score - a.score || a.fix.ident.localeCompare(b.fix.ident));
      const result = scored.slice(0, 30).map(s => s.fix);
      sendResponse({ fixes: result });
    };

    if (!READY && !LOADING) {
      loadCifp().then(respond);
    } else if (LOADING) {
      const waitForReady = () => {
        if (READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  return false;
});

// ─── Keep-alive during initial load ───────────────────────────────────────────
// MV3 service workers can be terminated. Ping ourselves to stay alive during load.
let keepAliveInterval = null;
if (!READY) {
  keepAliveInterval = setInterval(() => {
    if (READY) {
      clearInterval(keepAliveInterval);
      return;
    }
    // chrome.runtime.getPlatformInfo keeps the SW alive
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}