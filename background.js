// background.js — ADSB Waypoints Extension
// Loads cifp.zip, parses all US fixes/waypoints, serves them to the content script
// Uses IndexedDB to cache parsed data across service worker restarts (MV3)

importScripts("fflate.js");

// ─── State ────────────────────────────────────────────────────────────────────
let FIXES = [];          // [{ident, lat, lon, type}]
let READY = false;
let LOADING = false;     // prevent double-loading

// ─── IndexedDB caching ────────────────────────────────────────────────────────
const DB_NAME = "AdsbWptCache";
const STORE_NAME = "fixes";
const CACHE_VERSION = 8; // Bumped: increase spatial dedup for intersections

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
    // Only process US records (SUS = USA, SPA = Pacific/Hawaii)
    if (!line.startsWith("SUS") && !line.startsWith("SPA")) continue;

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

      // Bounds check — keep contiguous US + Alaska + Hawaii
      if (lat < 15 || lat > 72) continue;
      if (lon < -180 || lon > -60) continue;

      const type = lineType(line);

      let name = undefined;
      if ((type === "vor" || type === "ndb") && line.length > 93) {
        name = line.substring(93, 123).trim();
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

      FIXES.push({ ident, lat, lon, type, name });
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

  // Search for fixes by ident
  if (msg.type === "SEARCH_FIX") {
    const respond = () => {
      if (!READY) { sendResponse({ fixes: [] }); return; }
      const q = (msg.query || "").trim();
      if (!q) { sendResponse({ fixes: [] }); return; }
      
      const qs = q.toLowerCase();
      const scored = [];

      function lev(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
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

      const maxDist = Math.max(1, Math.floor(qs.length / 2) + (qs.length > 4 ? 1 : 0));

      for (const f of FIXES) {
        const id = f.ident.toLowerCase();
        let score = 0;
        
        let dist = lev(id, qs);
        
        // 1. Check ident
        if (id === qs) score = 100;
        else if (id.startsWith(qs)) score = 80;
        else if (id.includes(qs)) score = 60;
        else if (dist <= maxDist) score = 40 - (dist * 5); // 1 dist = 35, 2 dist = 30

        // 2. Check name (if it exists)
        if (f.name) {
          const nm = f.name.toLowerCase();
          let nDist = lev(nm, qs);
          if (nm === qs) score = Math.max(score, 90);
          else if (nm.startsWith(qs)) score = Math.max(score, 70);
          else if (nm.includes(qs)) score = Math.max(score, 50);
          else if (nDist <= maxDist) score = Math.max(score, 30 - (nDist * 5));
        }

        if (score > 0) {
          scored.push({ fix: f, score, dist });
        }
      }

      // Sort by score descending, then edit distance ascending, then alphabetically by ident
      scored.sort((a, b) => b.score - a.score || a.dist - b.dist || a.fix.ident.localeCompare(b.fix.ident));
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
