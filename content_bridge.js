// content_bridge.js — runs in extension content script context
// Bridges between: popup <-> here <-> page (content_main.js)

(function () {
  if (window.__adsbWptBridgeInstalled) return;
  window.__adsbWptBridgeInstalled = true;
  console.log("[WPT] Bridge installed");

  // ── Inject content_main.js into MAIN world (so it can access OLMap / ol) ──
  // We ask the background script to do this via chrome.scripting to bypass CSP blocks
  chrome.runtime.sendMessage({ type: "INJECT_MAIN_SCRIPT" })
    .then(() => {
      console.log("[WPT] Background reported successful MAIN injection.");
    })
    .catch(e => {
      console.error("[WPT] Failed requesting main script injection:", e);
    });

  // ── PAGE → BACKGROUND: relay bgRequest messages ───────────────────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__wpt_source !== "page") return;

    // Use async response pattern
    (async () => {
      try {
        const response = await chrome.runtime.sendMessage(msg);
        window.postMessage({
          __wpt_source: "bridge",
          __wpt_req_id: msg.__wpt_req_id,
          ...(response || {})
        }, "*");
      } catch (e) {
        window.postMessage({
          __wpt_source: "bridge",
          __wpt_req_id: msg.__wpt_req_id,
          error: String(e)
        }, "*");
      }
    })();
  });

  // ── POPUP → PAGE: relay toggle / fly-to commands ──────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.__wpt_source === "popup") {
      window.postMessage({ ...msg, __wpt_source: "bridge" }, "*");
      // Respond so the popup knows the message was received
      sendResponse({ ok: true });
    }
    return true; // Keep channel open for async
  });

})();
