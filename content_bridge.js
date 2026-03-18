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
    if (!msg || msg.__wpt_source !== "popup") return true;

    if (msg.type === "WPT_GET_BBOX") {
      // Need a real reply — attach a unique reply id, listen for the page's answer
      const replyId = "__bbox_" + Date.now() + "_" + Math.random();
      const onReply = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__wpt_source !== "page" || d.__wpt_bbox_reply_id !== replyId) return;
        window.removeEventListener("message", onReply);
        sendResponse({ bbox: d.bbox });
      };
      window.addEventListener("message", onReply);
      // Timeout safety — don't leave the listener dangling
      setTimeout(() => {
        window.removeEventListener("message", onReply);
        sendResponse({ bbox: null });
      }, 3000);
      window.postMessage({ ...msg, __wpt_source: "bridge", __wpt_bbox_reply_id: replyId }, "*");
      return true; // async response
    }

    // All other popup messages (toggles, fly-to) are fire-and-forget
    window.postMessage({ ...msg, __wpt_source: "bridge" }, "*");
    sendResponse({ ok: true });
    return true;
  });

})();