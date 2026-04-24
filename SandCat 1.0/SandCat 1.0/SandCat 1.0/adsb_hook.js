// adsb_hook.js

if (location.hostname.includes("adsbexchange.com")) {

  if (window.__adsbStoreHook) {
    console.log("ADSB hook already installed");
  } else {

    window.__adsbStoreHook = true;

    console.log("ADS-B aircraft URL hook installed");

    let lastIcao = null;

    function detectAircraft(){

  try {

    const params = new URLSearchParams(location.search);
    const icao = params.get("icao");

    if (!icao) return;

    const clean = icao.toLowerCase();

    let callsign = null;

    try {

      if (typeof selectedPlanes === "function") {

        const planes = selectedPlanes();

        if (planes && planes.length) {

          const p = planes[0];

          callsign =
            p.flight ||
            p.callsign ||
            p.t ||
            null;

        }

      }

    } catch(e){}

    if (clean !== lastIcao) {

      lastIcao = clean;

      console.log("Plane selected from URL:", clean, "callsign:", callsign);

      window.postMessage({
        source: "adsb_hook",
        type: "ADSB_AIRCRAFT_SELECTED",
        icao: clean,
        callsign: callsign?.trim() || null
      }, "*");

    }

  } catch(e){}

}

    const origRAF = window.requestAnimationFrame;

    window.requestAnimationFrame = function(fn){

      return origRAF.call(this,function(){

        detectAircraft();

        return fn.apply(this,arguments);

      });

    };

    // 🔥 CRITICAL: run once immediately after load
    setTimeout(detectAircraft, 1000);

  }

}