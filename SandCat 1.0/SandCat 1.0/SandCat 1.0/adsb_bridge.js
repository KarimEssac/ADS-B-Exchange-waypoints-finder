// adsb_bridge.js

(function () {

  if (window.__adsbBridgeInstalled) return;
  window.__adsbBridgeInstalled = true;

  console.log("ADSB bridge loaded");

  // Inject hook into page context
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("adsb_hook.js");
  s.onload = () => s.remove();

  (document.head || document.documentElement).appendChild(s);

  // Listen for hook messages
  window.addEventListener("message", (event) => {

    if (event.source !== window) return;

    const msg = event.data;

    if (!msg) return;
    if (msg.source !== "adsb_hook") return;

    console.log("Forwarding aircraft to background:", msg.icao);

    chrome.runtime.sendMessage(msg);

  });

})();