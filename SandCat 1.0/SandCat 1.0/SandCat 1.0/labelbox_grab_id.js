// labelbox_grab_id.js
// Opens the Labelbox "data row details" (info) panel ONCE PER NEW DATA ROW,
// extracts Global Key, stores to chrome.storage.local["lb_rawText"], then goes passive.
//
// Key points:
// - Detects DR changes via URL changes + DOM mutations
// - Opens panel only if "Global Key" label is not visible
// - Won’t repeatedly re-open the panel for the same DR
// - Cooldown to avoid UI fighting/spam
// Only run inside the actual editor frame
// labelbox_grab_id.js

console.log("GRABBER LOADED IN:", location.hostname);

// Only run inside the real editor frame
if (location.hostname !== "editor.labelbox.com") {
  console.log("[LB GK] Not editor frame — exiting.");
} else {

(() => {
  if (window.__lbGKPerDRLoaded) return;
  window.__lbGKPerDRLoaded = true;

  const STORAGE_KEY = "lb_pageKey";

const OLD_KEY_REGEX =
  /[A-Za-z0-9.-]+-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{1,2}-\d{4}-\d{4}Z_\d+_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.wav/i;

const NEW_KEY_REGEX =
  /\b\d{6}_\d{4}_\d+\.wav\b/i;

const KEY_REGEX =
  new RegExp(`${OLD_KEY_REGEX.source}|${NEW_KEY_REGEX.source}`, "i");

  const DEBUG = false; // set true for console logs

  const norm = (s) => (s || "").toString().replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => { if (DEBUG) console.log("[LB GK]", ...args); };

  let lastSeenKey = "";
  let running = false;

  // Track per “data row identity” so we only click once per DR
  let lastDrIdentity = "";
  const openedForDr = new Set();

  // Prevent spam clicks
  let lastClickTs = 0;
  const CLICK_COOLDOWN_MS = 2500;

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function click(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
  }

  function findDetailsButton() {
    // Confirmed selector from you:
    const btn = document.querySelector('button[data-cy="data-row-details-button"]');
    if (btn && isVisible(btn)) return btn;

    // Fallback if Labelbox changes it slightly
    const alt = Array.from(document.querySelectorAll("button[data-cy]"))
      .filter(isVisible)
      .find((b) => (b.getAttribute("data-cy") || "").toLowerCase().includes("details"));
    return alt || null;
  }

  function findGlobalKeyLabelEl() {
    const candidates = Array.from(document.querySelectorAll("span"))
      .filter(isVisible)
      .filter((el) => norm(el.textContent).toLowerCase() === "global key");

    if (!candidates.length) return null;

    // Prefer the one farthest to the right (details panel)
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.left + br.width) - (ar.left + ar.width);
    });

    return candidates[0];
  }

function extractKeyFromGlobalKeyRow(labelEl) {
  if (!labelEl) return null;

  const row =
    labelEl.closest(".MuiGrid-container") ||
    labelEl.closest('[class*="MuiGrid-container"]') ||
    labelEl.parentElement;

  if (!row) return null;

  // 🔥 NEW: Direct text extraction (Labelbox changed DOM)
  const text = (row.innerText || "").trim();

  const match = text.match(KEY_REGEX);
  if (match) return match[0];

  return null;
}

function writeIfChanged(key, reason) {
  const k = norm(key);
  if (!k) return;
  if (k === lastSeenKey) return;

  lastSeenKey = k;

  // Always store
  chrome.storage.local.set({ [STORAGE_KEY]: k }, () => {
    console.log("[LB GK] stored lb_rawText =", k, "reason=", reason);

    // Also message background (and confirm response)
    chrome.runtime.sendMessage(
      { type: "LB_AIRPORT_FOUND", rawText: k },
      (resp) => {
        console.log("[LB GK] sent LB_AIRPORT_FOUND resp=", resp, "runtimeErr=", chrome.runtime.lastError?.message || null);
      }
    );
  });
}

  // Try to derive a stable “DR identity” from URL.
  // Labelbox routes vary; we just need something that changes when the data row changes.
  function getDataRowIdentity() {
    const href = location.href;

    // Common patterns: UUIDs or long IDs in URL
    const uuid = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return `uuid:${uuid[0].toLowerCase()}`;

    // Sometimes an ID appears after /data-rows/ or /datarows/
    const dr = href.match(/data-rows\/([^/?#]+)/i) || href.match(/datarows\/([^/?#]+)/i);
    if (dr && dr[1]) return `dr:${dr[1]}`;

    // Fallback: full URL (good enough in many work queues)
    return `url:${href}`;
  }

  async function openPanelOnceForThisDR(reason) {
    const drId = getDataRowIdentity();
    lastDrIdentity = drId;

    // Already opened for this DR? Don't click again.
    if (openedForDr.has(drId)) return false;

    // If Global Key is already visible, do not click; just mark as opened for this DR.
    if (findGlobalKeyLabelEl()) {
      openedForDr.add(drId);
      return false;
    }

    // Cooldown
    const now = Date.now();
    if (now - lastClickTs < CLICK_COOLDOWN_MS) return false;

    const btn = findDetailsButton();
    if (!btn) return false;

    // Click once
    lastClickTs = now;
    openedForDr.add(drId);
    log("clicking details panel for DR:", drId, reason);
    click(btn);

    // Wait a bit for panel to render
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (findGlobalKeyLabelEl()) return true;
    }
    return true;
  }

  async function readAndStore(reason) {
    if (running) return;
    running = true;

    try {
      // Always attempt "open once per DR" first
      await openPanelOnceForThisDR(reason);

      // Passive read if Global Key visible
      const label = findGlobalKeyLabelEl();
      if (!label) return;

      // A few retries because panel content updates async
      for (let i = 0; i < 15; i++) {

  const label = findGlobalKeyLabelEl();
  if (!label) {
    await sleep(200);
    continue;
  }

  const key = extractKeyFromGlobalKeyRow(label);

  // 🔥 CRITICAL: ensure it's DIFFERENT from lastSeenKey
  if (key && key !== lastSeenKey) {
    writeIfChanged(key, reason);
    return;
  }

  await sleep(250);
}

console.warn("[LB GK] Timed out waiting for NEW key.");
    } finally {
      running = false;
    }
  }

  // --- Triggers ---

  // 1) Initial load: open for current DR
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    lastSeenKey = norm(res[STORAGE_KEY]);
    lastDrIdentity = getDataRowIdentity();
    readAndStore("init");
  });

  // 2) Watch URL changes in SPA (pushState/replaceState + popstate)
  function installHistoryHooks() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function (...args) {
      const r = _push.apply(this, args);
      setTimeout(() => {
        const id = getDataRowIdentity();
        if (id !== lastDrIdentity) {
          lastDrIdentity = id;
          readAndStore("pushState");
        }
      }, 0);
      return r;
    };

    history.replaceState = function (...args) {
      const r = _replace.apply(this, args);
      setTimeout(() => {
        const id = getDataRowIdentity();
        if (id !== lastDrIdentity) {
          lastDrIdentity = id;
          readAndStore("replaceState");
        }
      }, 0);
      return r;
    };

    window.addEventListener("popstate", () => {
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("popstate");
      }
    });

    window.addEventListener("hashchange", () => {
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("hashchange");
      }
    });
  }

  // 3) MutationObserver: catches DR changes that don't change URL
  let debounceTimer = null;
  function schedule(reason) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // If identity changed, treat as new DR and open once
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("mutation:newDR");
      } else {
        // Otherwise just try to read (passive), but still won’t click again for same DR
        readAndStore("mutation");
      }
    }, 350);
  }

  const obs = new MutationObserver(() => schedule("mutation"));
  obs.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  installHistoryHooks();

  // Extra delayed attempts (Labelbox boot can be slow)
  setTimeout(() => readAndStore("delay_1s"), 1000);
  setTimeout(() => readAndStore("delay_3s"), 3000);
  setTimeout(() => readAndStore("delay_7s"), 7000);

  let lastDataRowParam = null;

function getDataRowParam() {
  try {
    const params = new URLSearchParams(location.search);
    return params.get("dataRow");
  } catch {
    return null;
  }
}


function watchDataRowChange() {
  const current = getDataRowParam();
  if (!current) return;

  if (current !== lastDataRowParam) {
    lastDataRowParam = current;

    console.log("[LB GK] dataRow changed → triggering re-read");

    // Reset state so extraction runs clean
    lastSeenKey = "";
    openedForDr.clear();

    readAndStore("dataRowChange");
  }
}
setInterval(watchDataRowChange, 500);
})();

function grabCurrentGlobalKey() {

  // Check all frames (including editor iframe)
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const frame = window.frames[i];
      const href = frame.location.href;

      if (!href) continue;

      const params = new URLSearchParams(frame.location.search);
      const dataRow = params.get("dataRow");

      if (dataRow) {
        console.log("Found key in frame:", href);
        return dataRow;
      }

    } catch (e) {
      // Ignore cross-origin frames
    }
  }

  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg?.type === "MANUAL_GRAB_GLOBAL_KEY") {

    const key = grabCurrentGlobalKey(); // use your existing function

    if (key) {
      sendResponse({ ok: true, key });
    } else {
      sendResponse({ ok: false });
    }

    return true;
  }

});
}