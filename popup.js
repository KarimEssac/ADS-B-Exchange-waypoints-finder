// popup.js

const statusDot  = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const togEnabled = document.getElementById("togEnabled");
const subToggles = document.getElementById("subToggles");
const togFixes   = document.getElementById("togFixes");
const togIntersects = document.getElementById("togIntersects");
const togVors    = document.getElementById("togVors");
const togNdbs    = document.getElementById("togNdbs");
const searchBox  = document.getElementById("searchBox");
const searchResults = document.getElementById("searchResults");

// ── Ensure content scripts are injected ──────────────────────────────────────
async function ensureContentScripts(tabId) {
  try {
    // Try sending a ping; if the bridge is alive it will respond
    await chrome.tabs.sendMessage(tabId, { __wpt_source: "popup", type: "WPT_PING" });
  } catch (_) {
    // Content script not present — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content_bridge.js"]
      });
      // Give the bridge a moment to inject content_main.js
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn("[WPT] Cannot inject content script:", e);
    }
  }
}

// ── Status check ─────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (res && res.ready) {
      statusDot.className = "status-dot";
      statusText.textContent = `${res.count.toLocaleString()} waypoints loaded`;
    } else {
      statusDot.className = "status-dot loading";
      statusText.textContent = "Loading waypoint database…";
      setTimeout(checkStatus, 1500);
    }
  } catch (e) {
    statusDot.className = "status-dot error";
    statusText.textContent = "Extension not ready";
  }
}

checkStatus();

// ── Restore saved toggle states ───────────────────────────────────────────────
chrome.storage.local.get(["wpt_enabled", "wpt_showFixes", "wpt_showIntersects", "wpt_showVors", "wpt_showNdbs"], (data) => {
  if (data.wpt_enabled !== undefined) {
    togEnabled.checked = data.wpt_enabled;
    updateSubTogglesVisuals(data.wpt_enabled);
  }
  if (data.wpt_showFixes !== undefined) togFixes.checked = data.wpt_showFixes;
  if (data.wpt_showIntersects !== undefined) togIntersects.checked = data.wpt_showIntersects;
  if (data.wpt_showVors  !== undefined) togVors.checked  = data.wpt_showVors;
  if (data.wpt_showNdbs  !== undefined) togNdbs.checked  = data.wpt_showNdbs;
});

function updateSubTogglesVisuals(isEnabled) {
  subToggles.style.opacity = isEnabled ? "1" : "0.4";
  subToggles.style.pointerEvents = isEnabled ? "auto" : "none";
}

// ── Toggle handlers ───────────────────────────────────────────────────────────
async function sendToggle(key, value) {
  chrome.storage.local.set({ [`wpt_${key}`]: value });
  // Send to content script via tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    await ensureContentScripts(tabs[0].id);
    chrome.tabs.sendMessage(tabs[0].id, {
      __wpt_source: "popup",
      type: "WPT_TOGGLE",
      key,
      value
    }).catch(() => {}); // Silently ignore if still can't connect
  } catch (e) {
    console.warn("[WPT] Toggle send error:", e);
  }
}

togEnabled.addEventListener("change", () => {
  sendToggle("enabled", togEnabled.checked);
  updateSubTogglesVisuals(togEnabled.checked);
});
togFixes.addEventListener("change", () => sendToggle("showFixes", togFixes.checked));
togIntersects.addEventListener("change", () => sendToggle("showIntersects", togIntersects.checked));
togVors.addEventListener("change",  () => sendToggle("showVors",  togVors.checked));
togNdbs.addEventListener("change",  () => sendToggle("showNdbs",  togNdbs.checked));

// ── Search ────────────────────────────────────────────────────────────────────
let _searchTimer = null;

searchBox.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  const q = searchBox.value.trim();
  if (!q) { searchResults.innerHTML = ""; return; }
  _searchTimer = setTimeout(() => doSearch(q), 250);
});

async function doSearch(q) {
  searchResults.innerHTML = `<div class="no-results">Searching…</div>`;
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEARCH_FIX", query: q.toUpperCase() });
    renderResults(res.fixes || []);
  } catch (e) {
    searchResults.innerHTML = `<div class="no-results">Error searching</div>`;
  }
}

function renderResults(fixes) {
  if (!fixes.length) {
    searchResults.innerHTML = `<div class="no-results">No results found</div>`;
    return;
  }

  searchResults.innerHTML = fixes.map(f => {
    const nameStr = f.name ? ` <span style="color:#8b949e;font-weight:normal">(${f.name})</span>` : "";
    return `
    <div class="result-item" data-lat="${f.lat}" data-lon="${f.lon}" data-ident="${f.ident}">
      <div>
        <div class="result-ident" style="color:${typeColor(f.type)}">${f.ident}${nameStr}</div>
        <div class="result-coords">${f.lat.toFixed(4)}° / ${f.lon.toFixed(4)}°</div>
      </div>
      <span class="result-type">${typeLabel(f.type)}</span>
    </div>
  `}).join("");

  searchResults.querySelectorAll(".result-item").forEach(el => {
    el.addEventListener("click", async () => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      const ident = el.dataset.ident;
      // Pan the map to this fix
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) return;
        await ensureContentScripts(tabs[0].id);
        chrome.tabs.sendMessage(tabs[0].id, {
          __wpt_source: "popup",
          type: "WPT_FLY_TO",
          lat, lon, ident,
          zoom: 12
        }).catch(() => {});
      } catch (e) {
        console.warn("[WPT] FlyTo error:", e);
      }
      window.close();
    });
  });
}

function typeColor(t) {
  return t === "vor" ? "#58a6ff" : t === "ndb" ? "#f85149" : t === "airport" ? "#3fb950" : t === "intersect" ? "#ffffff" : "#3fb950";
}

function typeLabel(t) {
  return t === "vor" ? "VOR" : t === "ndb" ? "NDB" : t === "airport" ? "APT" : t === "intersect" ? "INT" : "FIX";
}
