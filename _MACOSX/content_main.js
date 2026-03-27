// content_main.js
// Injected into globe.adsbexchange.com page world (MAIN world).
// Draws waypoint markers on a canvas overlay synced to the OpenLayers map.

(function () {
  if (window.__adsbWptMainInstalled) return;
  window.__adsbWptMainInstalled = true;

  // ── Logging (console only) ─────────────────────────────────────────────────
  function logMsg(msg, isErr = false) {
    console[isErr ? "error" : "log"](msg);
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const Settings = {
    showFixes: true,
    showIntersects: true,
    showVors:  true,
    showNdbs:  true,
    enabled:   true,
    opacity:   0.92,
    showBtn:   true,
    labelSize: 1.0,
    scaleDot:  false,
    fixColor:  "#3fb950",
    textColor: "#3fb950",
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let allFixes = [];
  let activeHitboxes = [];
  let canvas = null;
  let ctx = null;
  let tooltip = null;
  let lastBbox = null;
  let loadTimer = null;

  // ── Bridge: page <-> extension content script ─────────────────────────────
  let _reqId = 0;
  const _pending = new Map();

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.__wpt_source !== "bridge") return;
    const msg = event.data;

    if (msg.type === "WPT_TOGGLE") {
      Settings[msg.key] = msg.value;
      // Hide quick-access button when popup/overlay/panel is active
      if (msg.key === "__hideQAB") {
        const btn = document.getElementById("wpt-quick-access-btn");
        if (btn) {
          // Only restore if user has showBtn enabled
          if (msg.value) btn.style.display = "none";
          else btn.style.display = Settings.showBtn === false ? "none" : "";
        }
        return;
      }
      // Handle quick-access button visibility
      if (msg.key === "showBtn") {
        const btn = document.getElementById("wpt-quick-access-btn");
        if (btn) btn.style.display = msg.value ? "" : "none";
        return;
      }
      // Label size only affects rendering, no data reload needed
      if (msg.key === "labelSize" || msg.key === "scaleDot" || msg.key === "fixColor" || msg.key === "textColor") return;
      lastBbox = null;  // Force re-fetch with new type filters
      loadFixesForView();
      return;
    }
    if (msg.type === "WPT_FLY_TO") {
      flyToFix(msg.lat, msg.lon, msg.zoom);
      return;
    }
    if (msg.type === "WPT_GET_BBOX") {
      const bbox = getMapBounds();
      window.postMessage({
        __wpt_source: "page",
        __wpt_bbox_reply_id: msg.__wpt_bbox_reply_id,
        bbox: bbox
      }, "*");
      return;
    }
    if (msg.type === "WPT_START_SELECTION") {
      startAreaSelection();
      return;
    }

    const id = msg.__wpt_req_id;
    if (id !== undefined && _pending.has(id)) {
      const { resolve, reject } = _pending.get(id);
      _pending.delete(id);
      msg.error ? reject(new Error(msg.error)) : resolve(msg);
    }
  });

  window.addEventListener("keydown", (e) => {
    // Only trigger if not typing in an input
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    
    if (e.shiftKey && e.key.toLowerCase() === 's') {
      Settings.enabled = !Settings.enabled;
      // Notify background to save the new setting
      bgRequest({ type: "SET_SETTINGS", settings: { enabled: Settings.enabled } }).catch(() => {});
      
      // Update the page map
      lastBbox = null;
      loadFixesForView();
    }
  });

  function bgRequest(payload) {
    return new Promise((resolve, reject) => {
      const id = _reqId++;
      _pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error("bgReq timeout: " + payload.type)); }
      }, 5000);
      window.postMessage({ __wpt_source: "page", __wpt_req_id: id, ...payload }, "*");
    });
  }

  // ── OpenLayers helpers ────────────────────────────────────────────────────
  function getOLMap() {
    // ADS-B Exchange (tar1090) exposes the map as window.OLMap
    if (window.OLMap && typeof window.OLMap.getView === "function") {
      return window.OLMap;
    }
    return null;
  }

  function getZoom() {
    const map = getOLMap();
    if (!map) return 0;
    try {
      return map.getView().getZoom() || 0;
    } catch (_) { return 0; }
  }

  function latLonToPixel(lat, lon) {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const coord = ol.proj.fromLonLat([lon, lat]);
      const pixel = map.getPixelFromCoordinate(coord);
      if (!pixel) return null;
      // OL returns CSS pixels; we need to match our canvas which uses device pixels
      const dpr = window.devicePixelRatio || 1;
      return { x: pixel[0] * dpr, y: pixel[1] * dpr };
    } catch (_) { return null; }
  }

  function getMapBounds() {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const size = map.getSize();
      if (!size) return null;
      const extent = map.getView().calculateExtent(size);
      
      // Calculate min/max lat/lon individually in case transformExtent is stripped from their OL build
      const minPt = ol.proj.toLonLat([extent[0], extent[1]]);
      const maxPt = ol.proj.toLonLat([extent[2], extent[3]]);
      
      const latPad = (maxPt[1] - minPt[1]) * 0.15;
      const lonPad = (maxPt[0] - minPt[0]) * 0.15;
      return {
        minLat: minPt[1] - latPad,
        maxLat: maxPt[1] + latPad,
        minLon: minPt[0] - lonPad,
        maxLon: maxPt[0] + lonPad,
      };
    } catch (e) { 
      logMsg("[WPT] getMapBounds error: " + String(e), true);
      return null; 
    }
  }

  // ── Find overlay container ────────────────────────────────────────────────
  function findMapViewport() {
    // tar1090 uses #map_canvas as the target element; OL creates .ol-viewport inside
    return document.querySelector(".ol-viewport") ||
           document.querySelector("#map_canvas");
  }

  // ── Create overlay canvas ─────────────────────────────────────────────────
  function createCanvas() {
    if (canvas) return;
    const container = findMapViewport();
    if (!container) { logMsg("[WPT] No OL viewport found", true); return; }

    canvas = document.createElement("canvas");
    canvas.id = "wpt-overlay-canvas";
    // Removing z-index completely. By appending to baseLayer without a z-index,
    // it will naturally render above the base map's canvas (due to DOM order)
    // but strictly beneath any subsequent OpenLayers layers (like flights) 
    // because it shares the base map's stacking context.
    canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
    `;
    ctx = canvas.getContext("2d");

    // OpenLayers strictly manages its container and creates separate stacking contexts for each map layer.
    // To cleanly sit between the map and the airplanes without being deleted by OpenLayers' renderer,
    // we inject our canvas directly into the *first* layer container (the base map).
    // This way, we render above the base map tile canvas, but strictly below the airplane vector layers.
    setInterval(() => {
      if (!canvas) return;
      const layersContainer = container.querySelector('.ol-layers');
      if (layersContainer && layersContainer.children.length > 0) {
        // children[0] is usually the base map .ol-layer
        const baseLayer = layersContainer.children[0];
        if (canvas.parentElement !== baseLayer) {
          baseLayer.appendChild(canvas);
        }
      } else {
        // Fallback if structure is unexpected
        const uiContainer = container.querySelector('.ol-overlaycontainer');
        if (uiContainer && canvas.parentElement !== container) {
          container.insertBefore(canvas, uiContainer);
        }
      }
    }, 500);

    function syncSize() {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width  = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    syncSize();
    new ResizeObserver(syncSize).observe(container);

    // Tooltip detection — listen on the container without blocking map interactions
    container.addEventListener("mousemove", onMouseMove, { passive: true });
    // Use capture phase so we intercept clicks on waypoints BEFORE ADS-B's handlers.
    // OpenLayers uses pointerdown/mousedown for map interactions (flight select/deselect),
    // so we must block those too when the cursor is over a waypoint.
    container.addEventListener("click", onClick, { capture: true });
    container.addEventListener("pointerdown", onPointerBlock, { capture: true });
    container.addEventListener("mousedown", onPointerBlock, { capture: true });

    logMsg("[WPT] Overlay canvas ready: " + canvas.width + "x" + canvas.height);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  const DEFAULT_FIX_COLOR = "#3fb950";
  function getColorMap() {
    return { airport: Settings.fixColor, fix: Settings.fixColor, intersect: "#ffffff", vor: "#58a6ff", ndb: "#f85149" };
  }
  // If a hex color is too dark, return white for readability on dark tooltips
  function readableColor(hex) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.4 ? "#ffffff" : hex;
  }

  function drawShape(type, x, y, r) {
    if (type === "vor") {
      // Hexagon
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        i === 0 ? ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a))
                : ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      ctx.closePath();
    } else if (type === "ndb") {
      // Diamond
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.8, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.8, y);
      ctx.closePath();
    } else {
      // Circle for fixes, intersects, and airports
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function drawFrame() {
    if (!canvas || !ctx) return;

    // Sync canvas size each frame
    const container = canvas.parentElement;
    if (container) {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    activeHitboxes = [];
    if (!Settings.enabled) return;

    const zoom = getZoom();
    if (zoom < 6) return;

    const dpr = window.devicePixelRatio || 1;
    const COLOR = getColorMap();
    const showLabels = zoom >= 10;
    
    // Scale radius down when zoomed out. Max size reached at zoom >= 10.5.
    let baseRadius = 5; // default max radius
    if (zoom >= 10.5) baseRadius = 5;
    else if (zoom >= 9.5) baseRadius = 4;
    else if (zoom >= 8.5) baseRadius = 3;
    else if (zoom >= 7.5) baseRadius = 2;
    else baseRadius = 1.5;
    
    const r = baseRadius * dpr * (Settings.scaleDot ? Settings.labelSize : 1);

    let drawn = 0;
    try {
      // Visually deduplicate points that map to the exact same screen location
      const drawnPixels = new Set();
      
      // Also deduplicate identical labels that are too close on screen (e.g. airway lines)
      const drawnLocationsByIdent = new Map(); // ident -> [{x, y}]
      
      for (const fix of allFixes) {
        if (fix.type === "fix" && !Settings.showFixes) continue;
        if (fix.type === "airport" && !Settings.showFixes) continue; // Group airports with generic fixes
        if (fix.type === "intersect" && !Settings.showIntersects) continue;
        if (fix.type === "vor" && !Settings.showVors)  continue;
        if (fix.type === "ndb" && !Settings.showNdbs)  continue;

        const pt = latLonToPixel(fix.lat, fix.lon);
        if (!pt) continue;
        const { x, y } = pt;
        if (x < -30 || x > canvas.width + 30 || y < -30 || y > canvas.height + 30) continue;

        // Dedup by rounding to nearest 2 pixels (for entirely overlapping points)
        const pxKey = `${Math.round(x/2)},${Math.round(y/2)}`;
        if (drawnPixels.has(pxKey)) continue;
        
        // Dedup identical ident names within ~40 pixels visually
        const existing = drawnLocationsByIdent.get(fix.ident);
        if (existing) {
          const isCrowded = existing.some(pt => Math.hypot(pt.x - x, pt.y - y) < 40 * dpr);
          if (isCrowded) continue;
          existing.push({x, y});
        } else {
          drawnLocationsByIdent.set(fix.ident, [{x, y}]);
        }
        
        drawnPixels.add(pxKey);

        const color = COLOR[fix.type] || Settings.fixColor;

        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 1 * dpr;
        ctx.globalAlpha = Settings.opacity;
        drawShape(fix.type, x, y, r);
        ctx.fill();
        ctx.stroke();

        let labelHit = null;

        if (showLabels) {
          const fs = (zoom >= 11 ? 11 : 10) * dpr * Settings.labelSize;
          ctx.font = `bold ${fs}px monospace`;
          ctx.globalAlpha = Settings.opacity;
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = "rgba(0,0,0,0.9)";
          const label = fix.name ? `${fix.ident} (${fix.name})` : fix.ident;
          
          let labelX = x + r + 3 * dpr;
          let labelY = y + 4 * dpr;
          
          ctx.strokeText(label, labelX, labelY);
          ctx.fillStyle = (fix.type === "fix" || fix.type === "airport") ? Settings.textColor : color;
          ctx.fillText(label, labelX, labelY);
          
          let w = ctx.measureText(label).width;
          labelHit = {
             x1: labelX, 
             y1: labelY - fs * 0.8,
             x2: labelX + w + 4 * dpr, 
             y2: labelY + fs * 0.3
          };
        }

        activeHitboxes.push({
           fix,
           dotHit: { x, y, r: r + 6 * dpr },
           labelHit
        });

        ctx.restore();
        drawn++;
      }
    } catch(e) {
      logMsg("[WPT] Draw error: " + String(e), true);
    }
  }

  // Render loop — keeps overlay in sync during panning
  function startRenderLoop() {
    function loop() {
      drawFrame();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  function getFixNearMouse(e) {
    const container = canvas ? canvas.parentElement : null;
    if (!container) return null;

    // Yield priority to flights: tar1090 sets pointer cursor on the viewport
    // or internal canvas when hovering over an aircraft. If a flight is hovered, ignore waypoints.
    if (container.style.cursor === 'pointer') return null;
    if (e.target && window.getComputedStyle(e.target).cursor === 'pointer') return null;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;

    // Check hitboxes in reverse order (top-most drawn)
    for (let i = activeHitboxes.length - 1; i >= 0; i--) {
      const box = activeHitboxes[i];
      // Check dot
      if (Math.hypot(box.dotHit.x - mx, box.dotHit.y - my) <= box.dotHit.r) {
         return box.fix;
      }
      // Check label
      if (box.labelHit && 
          mx >= box.labelHit.x1 && mx <= box.labelHit.x2 &&
          my >= box.labelHit.y1 && my <= box.labelHit.y2) {
         return box.fix;
      }
    }
    return null;
  }

  let _copiedUntil = 0; // timestamp — tooltip is locked while Date.now() < _copiedUntil

  // Block pointer/mouse-down events from reaching ADS-B when over a waypoint
  function onPointerBlock(e) {
    const fix = getFixNearMouse(e);
    if (fix) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function onClick(e) {
    const fix = getFixNearMouse(e);
    if (fix) {
      // Stop the click from reaching ADS-B's handlers (preserves flight tracking)
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      const lowerIdent = (fix.name || fix.ident).toLowerCase();
      navigator.clipboard.writeText(lowerIdent).then(() => {
        if (tooltip) {
          const COPY_DURATION = 400; // ms to keep "Copied" visible
          _copiedUntil = Date.now() + COPY_DURATION;
          const color = getColorMap()[fix.type] || Settings.fixColor;
          tooltip.innerHTML = `<span style="color:${readableColor(color)};font-weight:bold;font-size:14px">Copied ${lowerIdent} to clipboard</span>`;
          tooltip.style.display = "block";
          setTimeout(() => { _copiedUntil = 0; }, COPY_DURATION);
        }
      }).catch(err => logMsg("[WPT] clipboard auto-copy failed", true));
    }
  }

  function onMouseMove(e) {
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "wpt-tooltip";
      tooltip.style.cssText = `
        position:fixed; background:rgba(8,12,20,0.96); color:#e6edf3;
        border:1px solid #30363d; border-radius:7px; padding:8px 12px;
        font-family:monospace; font-size:13px; pointer-events:none;
        z-index:99999; display:none; box-shadow:0 4px 18px rgba(0,0,0,0.6);
        line-height:1.5;
      `;
      document.body.appendChild(tooltip);
    }

    // Don't overwrite the "Copied" message while it's still showing
    if (Date.now() < _copiedUntil) return;

    const fix = getFixNearMouse(e);
    if (fix) {
      const dotColor = getColorMap()[fix.type] || Settings.fixColor;
      const labelColor = (fix.type === "fix" || fix.type === "airport") ? Settings.textColor : dotColor;
      const label = fix.name ? `${fix.ident} (${fix.name})` : fix.ident;
      tooltip.innerHTML = `<span style="font-size:15px;font-weight:bold;color:${readableColor(labelColor)}">${label}</span>`;
      tooltip.style.display = "block";
      tooltip.style.left = (e.clientX + 16) + "px";
      tooltip.style.top  = (e.clientY - 8) + "px";
    } else {
      tooltip.style.display = "none";
    }
  }

  // ── Load fixes from background ────────────────────────────────────────────
  async function loadFixesForView() {
    if (!Settings.enabled) { allFixes = []; drawFrame(); return; }

    const bbox = getMapBounds();
    if (!bbox) return;

    const zoom = getZoom();
    if (zoom < 6) { allFixes = []; drawFrame(); return; }

    if (lastBbox) {
      const dLat = Math.abs(bbox.minLat - lastBbox.minLat);
      const dLon = Math.abs(bbox.minLon - lastBbox.minLon);
      if (dLat < 0.1 && dLon < 0.1) { drawFrame(); return; }
    }
    lastBbox = bbox;

    const types = [];
    if (Settings.showFixes) types.push("fix", "airport");
    if (Settings.showIntersects) types.push("intersect");
    if (Settings.showVors)  types.push("vor");
    if (Settings.showNdbs)  types.push("ndb");
    if (!types.length) { allFixes = []; drawFrame(); return; }

    try {
      const res = await bgRequest({ type: "GET_FIXES_IN_BBOX", ...bbox, types });
      allFixes = res.fixes || [];
      logMsg(`[WPT] ${allFixes.length} fixes loaded`);
    } catch (e) {
      logMsg("[WPT] Load error: " + String(e), true);
    }
  }

  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadFixesForView, 300);
  }

  function flyToFix(lat, lon, zoom) {
    const map = getOLMap();
    if (!map || !window.ol) { logMsg("[WPT] flyTo: No map", true); return; }
    try {
      const center = ol.proj.fromLonLat([lon, lat]);
      map.getView().animate({
        center: center,
        zoom: zoom || 12,
        duration: 1000
      });
      logMsg(`[WPT] Flew to ${lat.toFixed(3)}, ${lon.toFixed(3)}`);
    } catch (e) {
      logMsg("[WPT] flyTo error: " + String(e), true);
    }
  }

  // ── Aggressive Map Search ─────────────────────────────────────────────────
  function findMapObjectDynamically() {
    // 1. Check known variables
    if (window.OLMap) return window.OLMap;
    if (window.olMap) return window.olMap;
    if (window.map && typeof window.map.getView === 'function') return window.map;
    if (window.SiteTracker && window.SiteTracker.map) return window.SiteTracker.map;
    if (window.tar1090 && window.tar1090.map) return window.tar1090.map;

    // 2. OpenLayers 6+ internal registries
    try {
      if (window.ol && window.ol.Map && window.ol.Map.instances && window.ol.Map.instances.length > 0) {
        logMsg("[WPT DEBUG] Found map in ol.Map.instances!");
        return window.ol.Map.instances[0];
      }
    } catch(e) {}

    // 3. The Intercept Hook Method (runs on new ol.Map())
    if (interceptedMap) return interceptedMap;

    // 4. Fallback: Search all properties of the viewport directly
    try {
      const container = document.querySelector('.ol-viewport') || document.getElementById('map_canvas');
      if (container) {
        const parent = container.parentElement;
        if (parent) {
          logMsg(`[WPT] Scanning parent element properties: ${parent.id || parent.className}...`);
          for (let key in parent) {
            try {
              let obj = parent[key];
              if (obj && typeof obj === 'object') {
                if (typeof obj.getView === 'function' && typeof obj.getLayers === 'function') return obj;
                if (obj.map && typeof obj.map.getView === 'function') return obj.map;
              }
            } catch(e) {}
          }
        }
      }
    } catch(e) {}

    // 5. The Control Injection Trick
    // OpenLayers scans the viewport for DOM elements matching its controls.
    // If we can't find the map, but window.ol exists, we can try to
    // force the map to hand itself to us by creating a dummy control.
    try {
      if (window.ol && window.ol.control && window.ol.control.Control) {
        if (!window.__wpt_dummy_control) {
          logMsg("[WPT] Injecting dummy Control to extract map...");
          const dummyDiv = document.createElement('div');
          const DummyControl = /*@__PURE__*/(function (Control) {
            function DummyControl(opt_options) {
              Control.call(this, { element: dummyDiv, target: opt_options.target });
            }
            if (Control) DummyControl.__proto__ = Control;
            DummyControl.prototype = Object.create(Control && Control.prototype);
            DummyControl.prototype.constructor = DummyControl;
            DummyControl.prototype.setMap = function setMap (map) {
              Control.prototype.setMap.call(this, map);
              if (map && !interceptedMap) {
                logMsg("[WPT DEBUG] Stole map from Control.setMap!");
                interceptedMap = map;
              }
            };
            return DummyControl;
          }(window.ol.control.Control));
          
          window.__wpt_dummy_control = new DummyControl({});
          // The map has a collection of controls. We can't easily push to it without the map.
        }
      }
    } catch(e) {}

    // 6. The Massive Interceptor Hook
    try {
      if (window.ol && window.ol.Map && !window.ol.Map.prototype.__wpt_massive_patched) {
        logMsg("[WPT] Setting up massive ol.Map.prototype interceptor... Waiting for you to move the map.");
        const methods = [
          'getView', 'updateSize', 'render', 'getEventPixel', 
          'getEventCoordinate', 'getFeaturesAtPixel', 'forEachFeatureAtPixel',
          'setTarget', 'getLayers', 'addLayer', 'removeLayer', 'getPixelFromCoordinate'
        ];
        
        methods.forEach(method => {
          if (typeof window.ol.Map.prototype[method] === 'function') {
            const orig = window.ol.Map.prototype[method];
            window.ol.Map.prototype[method] = function() {
              if (!interceptedMap) {
                logMsg(`[WPT DEBUG] JACKPOT! Stole map from ${method}()!`);
                interceptedMap = this;
                // Force an immediate init check now that we have the map
                if (!canvas) setTimeout(initOverlay, 100);
              }
              return orig.apply(this, arguments);
            };
          }
        });
        window.ol.Map.prototype.__wpt_massive_patched = true;
      }
    } catch(e) {}

    return interceptedMap;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  let attempts = 0;
  let interceptedMap = null;

  function injectMapInterceptor() {
    if (!window.ol || !window.ol.Map || window.ol.Map.__wpt_patched) return false;
    
    logMsg("[WPT] Intercepting ol.Map constructor (just in case)...");
    const originalMap = window.ol.Map;
    
    // Monkey-patch the OpenLayers Map constructor
    window.ol.Map = function(options) {
      logMsg("[WPT] Intercepted new ol.Map() call!");
      const instance = new originalMap(options);
      interceptedMap = instance;
      setTimeout(initOverlay, 500);
      return instance;
    };
    
    // Copy over prototype and static props
    window.ol.Map.prototype = originalMap.prototype;
    Object.assign(window.ol.Map, originalMap);
    window.ol.Map.__wpt_patched = true;

    // Alternative: Intercept layer addition. If the map was already created, any new layer added might give us the map
    if (window.ol.layer && window.ol.layer.Layer) {
        const origSetMap = window.ol.layer.Layer.prototype.setMap;
        if (origSetMap) {
            window.ol.layer.Layer.prototype.setMap = function(map) {
                if (map && typeof map.getView === 'function') {
                    if (!interceptedMap) {
                      logMsg("[WPT] Intercepted map via Layer.setMap!");
                      interceptedMap = map;
                      setTimeout(initOverlay, 100);
                    }
                }
                return origSetMap.apply(this, arguments);
            };
        }
    }
    
    return true;
  }

  function getOLMap() {
    // 1. Check known variables just in case
    if (window.OLMap) return window.OLMap;
    if (window.map && typeof window.map.getView === 'function') return window.map;
    // 2. Return the map we intercepted during creation or interaction
    if (interceptedMap) return interceptedMap;
    return null;
  }

  // Inject interceptor immediately in case the map hasn't loaded yet
  injectMapInterceptor();

  function initOverlay() {
    if (canvas) return; // already initialized

    const map = getOLMap();
    const viewport = findMapViewport();

    if (!map || !viewport) {
      logMsg(`[WPT] initOverlay: Map or viewport missing. map=${!!map}, viewport=${!!viewport}`);
      return;
    }

    logMsg("[WPT] Map object captured! Setting up overlay...");
    try {
      createCanvas();
      if (!canvas) { 
        logMsg("[WPT] Canvas creation failed, trying again...", true);
        setTimeout(initOverlay, 500); 
        return; 
      }

      // OpenLayers events
      map.on("moveend", scheduleLoad);
      map.getView().on("change:resolution", scheduleLoad);
      
      startRenderLoop();
      logMsg("[WPT] Triggering initial loadFixesForView...");
      loadFixesForView();
      logMsg("[WPT] Overlay initialised and running render loop!");
    } catch(e) {
      logMsg("[WPT] Init failed: " + String(e), true);
    }
  }

  function init() {
    const map = getOLMap() || findMapObjectDynamically();
    const viewport = findMapViewport();

    if (!map || !viewport) {
      attempts++;
      if (attempts === 1) {
        logMsg("[WPT] Waiting for map interception... Please DRAG, ZOOM, or CLICK the map to force capture.");
      } else if (attempts % 5 === 0) {
        logMsg(`[WPT] Still waiting for you to move the map... (attempt ${attempts})`);
      }
      
      // Keep trying to patch if 'ol' arrived late
      if (!window.ol?.Map?.__wpt_patched) injectMapInterceptor();
      
      // Run forever until we get the map!
      setTimeout(init, 1000);
      return;
    }
    
    initOverlay();
  }



  // ── Load persisted settings before first render ───────────────────────────
  // Request saved toggle states from the background service worker so that
  // Settings are restored immediately after a browser/machine restart.
  async function loadPersistedSettings() {
    try {
      const saved = await bgRequest({ type: "GET_SETTINGS" });
      if (saved) {
        if (saved.enabled       !== undefined) Settings.enabled       = saved.enabled;
        if (saved.showFixes     !== undefined) Settings.showFixes     = saved.showFixes;
        if (saved.showIntersects!== undefined) Settings.showIntersects= saved.showIntersects;
        if (saved.showVors      !== undefined) Settings.showVors      = saved.showVors;
        if (saved.showNdbs      !== undefined) Settings.showNdbs      = saved.showNdbs;
        if (saved.opacity       !== undefined) Settings.opacity       = saved.opacity;
        if (saved.showBtn      !== undefined) Settings.showBtn      = saved.showBtn;
        if (saved.labelSize    !== undefined) Settings.labelSize    = saved.labelSize;
        if (saved.scaleDot     !== undefined) Settings.scaleDot     = saved.scaleDot;
        if (saved.fixColor     !== undefined) Settings.fixColor     = saved.fixColor;
        if (saved.textColor    !== undefined) Settings.textColor    = saved.textColor;
        logMsg("[WPT] Persisted settings restored: " + JSON.stringify(Settings));
      }
    } catch (e) {
      logMsg("[WPT] Could not restore settings, using defaults: " + String(e));
    }
  }

  function createQuickAccessButton() {
    const btn = document.createElement("div");
    btn.id = "wpt-quick-access-btn";
    btn.innerText = "ADSB Waypoints Settings";
    btn.style.position = "fixed";
    
    // Restore saved position or use default
    let savedPos = null;
    try {
      const posStr = localStorage.getItem("wpt_btn_pos");
      if (posStr) savedPos = JSON.parse(posStr);
    } catch(e) {}
    
    if (savedPos && savedPos.top !== undefined && savedPos.left !== undefined) {
      btn.style.top = savedPos.top + "px";
      btn.style.left = savedPos.left + "px";
    } else {
      btn.style.top = "10px";
      btn.style.right = "10px";
    }

    btn.style.zIndex = "999999";
    btn.style.background = "#1f6feb";
    btn.style.color = "#ffffff";
    btn.style.padding = "10px 16px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid #58a6ff";
    btn.style.cursor = "pointer";
    btn.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    btn.style.fontSize = "14px";
    btn.style.fontWeight = "bold";
    btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.6)";
    btn.style.transition = "background 0.2s";
    btn.style.userSelect = "none";
    
    btn.addEventListener("mouseover", () => {
      btn.style.background = "#388bfd";
    });
    btn.addEventListener("mouseout", () => {
      btn.style.background = "#1f6feb";
    });

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // Only left click
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = btn.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      btn.style.transition = "none"; // Disable transition during drag
      btn.style.right = "auto";
      btn.style.left = startLeft + "px";
      btn.style.top = startTop + "px";
      
      e.preventDefault(); // Prevent text selection
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      // Small threshold to distinguish click from drag
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      
      if (hasMoved) {
        btn.style.left = (startLeft + dx) + "px";
        btn.style.top = (startTop + dy) + "px";
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      btn.style.transition = "background 0.2s"; // Restore transition
      if (hasMoved) {
        try {
          const rect = btn.getBoundingClientRect();
          localStorage.setItem("wpt_btn_pos", JSON.stringify({ left: rect.left, top: rect.top }));
        } catch(err) {}
      }
    });
    
    btn.addEventListener("click", () => {
      if (hasMoved) return; // Ignore click if dragging occurred
      bgRequest({ type: "OPEN_POPUP" }).catch(e => {
        if (String(e).includes("invalidated")) return; // expected after extension reload
        logMsg("Failed to open popup: " + e, true);
      });
    });
  
    document.body.appendChild(btn);

    // Apply persisted showBtn visibility
    if (!Settings.showBtn) btn.style.display = "none";
  }

  // Wait for the bridge to be ready, load settings, then start map init
  async function startWithSettings() {
    await loadPersistedSettings();
    createQuickAccessButton();
    setTimeout(init, 1500);
  }

  startWithSettings();

  // Expose for popup commands
  window.__wptOverlay = { getSettings: () => ({...Settings}), reload: loadFixesForView };
  logMsg("[WPT] Exposed window.__wptOverlay");

  // ── SandCat fuzzy search engine (shared with background.js search) ─────────
  const SOUND_GROUPS = [
    "EI","AE","OU","BP","DT","GKC","FV","SZC","MN","LR","JY","XKS"
  ];
  const CHAR_GROUPS = {};
  for (let gi = 0; gi < SOUND_GROUPS.length; gi++) {
    for (const ch of SOUND_GROUPS[gi]) {
      if (!CHAR_GROUPS[ch]) CHAR_GROUPS[ch] = [];
      CHAR_GROUPS[ch].push(gi);
    }
  }
  function charSimilarity(a, b) {
    if (a === b) return 1.0;
    const ga = CHAR_GROUPS[a], gb = CHAR_GROUPS[b];
    if (!ga || !gb) return 0;
    for (const g of ga) { if (gb.includes(g)) return 0.6; }
    return 0;
  }
  function soundSimilarityScore(a, b) {
    a = String(a || "").toUpperCase(); b = String(b || "").toUpperCase();
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length), minLen = Math.min(a.length, b.length);
    if (maxLen === 0) return 0;
    let totalSim = 0;
    for (let i = 0; i < minLen; i++) totalSim += charSimilarity(a[i], b[i]);
    const lengthPenalty = 1 - (maxLen - minLen) / maxLen;
    return Math.round((totalSim / maxLen) * 100 * lengthPenalty);
  }
  function phoneticNormalize(s) {
    if (!s) return "";
    s = s.toUpperCase().replace(/[^A-Z]/g, "");
    const rules = [
      [/PH/g,"F"],[/CK/g,"K"],[/Q/g,"K"],[/X/g,"KS"],
      [/Z/g,"S"],[/DG/g,"J"],[/GH/g,"G"],[/KN/g,"N"],[/WR/g,"R"],
      [/EE/g,"I"],[/EA/g,"I"],[/IE/g,"I"],[/EY/g,"I"],[/AY/g,"I"],
      [/OO/g,"U"],[/OU/g,"U"],[/ISN/g,"SN"],[/YSN/g,"SN"]
    ];
    for (const [r, rep] of rules) s = s.replace(r, rep);
    s = s.replace(/Y/g, "I");
    s = s.replace(/(.)\\1+/g, "$1");
    if (s.length > 1) s = s[0] + s.slice(1).replace(/[AEIOU]/g, "");
    return s;
  }
  function consonantSkeleton(s) {
    if (!s) return "";
    return s.toUpperCase().replace(/[^A-Z]/g, "")
      .replace(/[AEIOU]/g, "").replace(/PH/g,"F")
      .replace(/CK/g,"K").replace(/Q/g,"K").replace(/Z/g,"S")
      .replace(/(.)\\1+/g, "$1");
  }
  function fuzzyMatch(str, pattern) {
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
        if (b.charAt(i-1) === a.charAt(j-1)) matrix[i][j] = matrix[i-1][j-1];
        else matrix[i][j] = Math.min(matrix[i-1][j-1]+1, matrix[i][j-1]+1, matrix[i-1][j]+1);
      }
    }
    return matrix[b.length][a.length];
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
    if (fuzzyMatch(fix, query)) score += 40;
    const distPh = levenshtein(fixPh, qPh);
    score += Math.max(0, 40 - distPh * 6);
    const distRaw = levenshtein(fix, query);
    if (distRaw <= 3) score += [300, 200, 120, 60][distRaw];
    return score;
  }

  // ── Area Selection Mode ──────────────────────────────────────────────────────
  function pixelToLatLon(px, py) {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const coord = map.getCoordinateFromPixel([px, py]);
      if (!coord) return null;
      const lonlat = ol.proj.toLonLat(coord);
      return { lat: lonlat[1], lon: lonlat[0] };
    } catch (_) { return null; }
  }

  function startAreaSelection() {
    const old = document.getElementById("wpt-selection-overlay");
    if (old) old.remove();

    // Restore last used mode or default to rect
    let mode = "rect";
    try { mode = localStorage.getItem("wpt_selMode") || "rect"; } catch(_) {}

    const overlay = document.createElement("div");
    overlay.id = "wpt-selection-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      z-index: 999999;
      cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cline x1='16' y1='0' x2='16' y2='32' stroke='%2358a6ff' stroke-width='2'/%3E%3Cline x1='0' y1='16' x2='32' y2='16' stroke='%2358a6ff' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='6' fill='none' stroke='%2358a6ff' stroke-width='1.5'/%3E%3C/svg%3E") 16 16, crosshair;
    `;

    // Hide quick-access button during selection
    const qab = document.getElementById("wpt-quick-access-btn");
    if (qab) qab.style.display = "none";

    const cvs = document.createElement("canvas");
    cvs.width = window.innerWidth;
    cvs.height = window.innerHeight;
    cvs.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;";
    overlay.appendChild(cvs);
    const dc = cvs.getContext("2d");

    // Banner
    const banner = document.createElement("div");
    banner.style.cssText = `
      position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
      background: rgba(13,17,23,0.92); color: #e6edf3; padding: 10px 18px;
      border-radius: 8px; border: 1px solid #58a6ff; font-size: 12px;
      font-weight: 600; font-family: monospace; pointer-events: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      display: flex; align-items: center; gap: 12px;
    `;
    const bannerText = document.createElement("span");
    bannerText.style.pointerEvents = "none";

    const modeToggle = document.createElement("div");
    modeToggle.style.cssText = `
      display: flex; gap: 2px; background: #161b22; border: 1px solid #30363d;
      border-radius: 5px; padding: 2px; pointer-events: auto;
    `;

    const btnStyle = `border:none; border-radius:3px; padding:3px 8px; font-size:10px;
      font-weight:600; cursor:pointer; transition:all 0.15s;`;
    const btnModeRect = document.createElement("button");
    btnModeRect.textContent = "Rectangle";
    btnModeRect.style.cssText = btnStyle;
    const btnModeFree = document.createElement("button");
    btnModeFree.textContent = "Free Select";
    btnModeFree.style.cssText = btnStyle;
    const btnModeCircle = document.createElement("button");
    btnModeCircle.textContent = "Circle";
    btnModeCircle.style.cssText = btnStyle;

    const allModeBtns = [btnModeRect, btnModeFree, btnModeCircle];

    function switchMode(m) {
      mode = m;
      try { localStorage.setItem("wpt_selMode", m); } catch(_) {}
      freePoints = [];
      rectDrawing = false;
      circDrawing = false;
      dc.clearRect(0, 0, cvs.width, cvs.height);
      allModeBtns.forEach(b => { b.style.background = "transparent"; b.style.color = "#8b949e"; });
      const activeBtn = m === "rect" ? btnModeRect : m === "free" ? btnModeFree : btnModeCircle;
      activeBtn.style.background = "#58a6ff";
      activeBtn.style.color = "#0d1117";
      if (m === "rect") bannerText.textContent = "Drag to select";
      else if (m === "free") bannerText.textContent = "Click to place points \u00b7 Double-click to finish";
      else bannerText.textContent = "Click center, drag radius";
    }

    btnModeRect.addEventListener("click", (e) => { e.stopPropagation(); switchMode("rect"); });
    btnModeFree.addEventListener("click", (e) => { e.stopPropagation(); switchMode("free"); });
    btnModeCircle.addEventListener("click", (e) => { e.stopPropagation(); switchMode("circle"); });

    modeToggle.appendChild(btnModeRect);
    modeToggle.appendChild(btnModeFree);
    modeToggle.appendChild(btnModeCircle);

    const escHint = document.createElement("span");
    escHint.textContent = "ESC to cancel";
    escHint.style.cssText = "color: #8b949e; font-size: 10px; pointer-events: none;";

    banner.appendChild(bannerText);
    banner.appendChild(modeToggle);
    banner.appendChild(escHint);
    overlay.appendChild(banner);

    // ── State ──
    let rectDrawing = false, rectSx = 0, rectSy = 0;
    let freePoints = [];
    let circDrawing = false, circCx = 0, circCy = 0;

    // ── Draw helpers ──
    function drawFreeOverlay(mouseX, mouseY) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      if (freePoints.length === 0) return;
      dc.beginPath();
      dc.moveTo(freePoints[0].x, freePoints[0].y);
      for (let i = 1; i < freePoints.length; i++) dc.lineTo(freePoints[i].x, freePoints[i].y);
      if (mouseX !== undefined) dc.lineTo(mouseX, mouseY);
      dc.lineTo(freePoints[0].x, freePoints[0].y);
      dc.closePath();
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fill();
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.stroke(); dc.setLineDash([]);
      for (const pt of freePoints) {
        dc.beginPath(); dc.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        dc.fillStyle = "#58a6ff"; dc.fill();
        dc.strokeStyle = "#0d1117"; dc.lineWidth = 1; dc.stroke();
      }
    }

    function drawRectOverlay(x1, y1, x2, y2) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fillRect(rx, ry, rw, rh);
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.strokeRect(rx, ry, rw, rh); dc.setLineDash([]);
    }

    function drawCircleOverlay(sx, sy, ex, ey) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
      const r = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) / 2;
      dc.beginPath(); dc.arc(cx, cy, r, 0, Math.PI * 2);
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fill();
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.stroke(); dc.setLineDash([]);
      // Start and end dots
      dc.beginPath(); dc.arc(sx, sy, 3, 0, Math.PI * 2);
      dc.fillStyle = "#58a6ff"; dc.fill();
      dc.beginPath(); dc.arc(ex, ey, 3, 0, Math.PI * 2);
      dc.fillStyle = "#58a6ff"; dc.fill();
    }

    function finishFreeSelect() {
      if (freePoints.length < 3) return;
      const polygon = freePoints.map(p => pixelToLatLon(p.x, p.y)).filter(Boolean);
      if (polygon.length < 3) return;
      overlay.remove(); document.removeEventListener("keydown", onKey);
      collectPolygonWaypoints(polygon);
    }

    function finishCircleSelect(sx, sy, ex, ey) {
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
      const r = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) / 2;
      if (r < 15) return;
      const polygon = [];
      for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2;
        const px = cx + r * Math.cos(angle);
        const py = cy + r * Math.sin(angle);
        const ll = pixelToLatLon(px, py);
        if (ll) polygon.push(ll);
      }
      if (polygon.length < 3) return;
      overlay.remove(); document.removeEventListener("keydown", onKey);
      collectPolygonWaypoints(polygon);
    }

    // ── Events ──
    overlay.addEventListener("mousedown", (e) => {
      if (mode === "rect") {
        rectDrawing = true; rectSx = e.clientX; rectSy = e.clientY;
      }
      if (mode === "circle") {
        circDrawing = true; circCx = e.clientX; circCy = e.clientY;
      }
    });

    overlay.addEventListener("mousemove", (e) => {
      if (mode === "rect" && rectDrawing) {
        drawRectOverlay(rectSx, rectSy, e.clientX, e.clientY);
      }
      if (mode === "free" && freePoints.length > 0) {
        drawFreeOverlay(e.clientX, e.clientY);
      }
      if (mode === "circle" && circDrawing) {
        drawCircleOverlay(circCx, circCy, e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("mouseup", (e) => {
      if (mode === "rect" && rectDrawing) {
        rectDrawing = false;
        const x1 = Math.min(rectSx, e.clientX), y1 = Math.min(rectSy, e.clientY);
        const x2 = Math.max(rectSx, e.clientX), y2 = Math.max(rectSy, e.clientY);
        if (x2 - x1 < 20 || y2 - y1 < 20) return;
        overlay.remove(); document.removeEventListener("keydown", onKey);
        const tl = pixelToLatLon(x1, y1), br = pixelToLatLon(x2, y2);
        if (!tl || !br) return;
        collectAreaWaypoints({
          minLat: Math.min(tl.lat, br.lat), maxLat: Math.max(tl.lat, br.lat),
          minLon: Math.min(tl.lon, br.lon), maxLon: Math.max(tl.lon, br.lon),
        });
      }
      if (mode === "circle" && circDrawing) {
        circDrawing = false;
        finishCircleSelect(circCx, circCy, e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("click", (e) => {
      if (mode === "free") {
        freePoints.push({ x: e.clientX, y: e.clientY });
        drawFreeOverlay(e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("dblclick", (e) => {
      if (mode === "free") { e.preventDefault(); finishFreeSelect(); }
    });

    const onKey = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        const qab2 = document.getElementById("wpt-quick-access-btn");
        if (qab2) qab2.style.display = "";
        bgRequest({ type: "OPEN_POPUP" }).catch(() => {});
      }
    };
    document.addEventListener("keydown", onKey);

    // Initialize with persisted mode
    switchMode(mode);
    document.body.appendChild(overlay);
  }

  // Ray-casting point-in-polygon test
  function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat, yi = polygon[i].lon;
      const xj = polygon[j].lat, yj = polygon[j].lon;
      if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  async function collectPolygonWaypoints(polygon) {
    const lats = polygon.map(p => p.lat), lons = polygon.map(p => p.lon);
    const bbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    try {
      const res = await bgRequest({
        type: "GET_FIXES_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon,
        types: ["fix", "airport", "vor", "ndb", "intersect"]
      });
      const fixes = (res.fixes || []).filter(f => f.type !== "intersect" && pointInPolygon(f.lat, f.lon, polygon));
      showAreaResultsPanel(fixes, bbox);
    } catch (e) { logMsg("[WPT] Polygon query failed: " + String(e), true); }
  }

  async function collectAreaWaypoints(bbox) {
    try {
      const res = await bgRequest({
        type: "GET_FIXES_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon,
        types: ["fix", "airport", "vor", "ndb", "intersect"]
      });
      const fixes = (res.fixes || []).filter(f => f.type !== "intersect");
      showAreaResultsPanel(fixes, bbox);
    } catch (e) { logMsg("[WPT] Area selection query failed: " + String(e), true); }
  }

  function showAreaResultsPanel(fixes, bbox) {
    // Remove any existing panel
    const old = document.getElementById("wpt-area-panel");
    if (old) old.remove();

    // Hide quick-access button while panel is visible
    const qab3 = document.getElementById("wpt-quick-access-btn");
    if (qab3) qab3.style.display = "none";

    const panel = document.createElement("div");
    panel.id = "wpt-area-panel";
    panel.style.cssText = `
      position: fixed; top: 60px; right: 16px; width: 320px; max-height: 70vh;
      background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
      color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
      z-index: 999998; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      display: flex; flex-direction: column; overflow: hidden;
    `;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 12px 16px; border-bottom: 1px solid #21262d;
      display: flex; justify-content: space-between; align-items: center;
      background: #161b22; border-radius: 10px 10px 0 0;
    `;
    header.innerHTML = `
      <span style="font-weight:700; font-size:13px;">Area Selection — ${fixes.length} waypoints</span>
    `;
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "cursor:pointer; color:#8b949e; font-size:18px; line-height:1; padding: 0 2px;";
    closeBtn.addEventListener("click", () => {
      panel.remove();
      const qab4 = document.getElementById("wpt-quick-access-btn");
      if (qab4) qab4.style.display = "";
      bgRequest({ type: "OPEN_POPUP" }).catch(() => {});
    });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    if (fixes.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding: 24px 16px; text-align: center; color: #8b949e; font-size: 12px;";
      empty.textContent = "No waypoints found in the selected area";
      panel.appendChild(empty);
      document.body.appendChild(panel);
      return;
    }

    // Toolbar: Copy All + New Selection
    const toolbar = document.createElement("div");
    toolbar.style.cssText = `padding: 8px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 8px;`;
    const btnStyle = `background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:5px;
      padding:5px 12px; font-size:11px; cursor:pointer; font-weight:600;`;
    const copyAllBtn = document.createElement("button");
    copyAllBtn.textContent = "Copy All";
    copyAllBtn.style.cssText = btnStyle;
    copyAllBtn.addEventListener("click", () => {
      const filtered = getFilteredFixes();
      const text = filtered.map(f => f.ident).join(", ");
      navigator.clipboard.writeText(text).then(() => {
        copyAllBtn.textContent = "\u2713 Copied!";
        setTimeout(() => { copyAllBtn.textContent = "Copy All"; }, 1200);
      });
    });
    copyAllBtn.addEventListener("mouseover", () => { copyAllBtn.style.background = "#30363d"; });
    copyAllBtn.addEventListener("mouseout", () => { copyAllBtn.style.background = "#21262d"; });
    toolbar.appendChild(copyAllBtn);

    const newSelBtn = document.createElement("button");
    newSelBtn.textContent = "New Selection";
    newSelBtn.style.cssText = btnStyle;
    newSelBtn.addEventListener("click", () => { panel.remove(); startAreaSelection(); });
    newSelBtn.addEventListener("mouseover", () => { newSelBtn.style.background = "#30363d"; });
    newSelBtn.addEventListener("mouseout", () => { newSelBtn.style.background = "#21262d"; });
    toolbar.appendChild(newSelBtn);
    panel.appendChild(toolbar);

    // Search box
    const searchRow = document.createElement("div");
    searchRow.style.cssText = "padding: 6px 12px; border-bottom: 1px solid #21262d;";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = `Filter ${fixes.length} waypoints...`;
    searchInput.style.cssText = `
      width: 100%; box-sizing: border-box; background: #161b22; color: #e6edf3;
      border: 1px solid #30363d; border-radius: 5px; padding: 6px 10px;
      font-size: 11px; font-family: monospace; outline: none;
    `;
    searchInput.addEventListener("focus", () => { searchInput.style.borderColor = "#58a6ff"; });
    searchInput.addEventListener("blur", () => { searchInput.style.borderColor = "#30363d"; });
    searchRow.appendChild(searchInput);
    panel.appendChild(searchRow);

    // Results list
    const list = document.createElement("div");
    list.className = "wpt-area-list";
    list.style.cssText = "overflow-y: auto; flex: 1; padding: 4px 0;";

    if (!document.getElementById("wpt-area-scrollbar-css")) {
      const style = document.createElement("style");
      style.id = "wpt-area-scrollbar-css";
      style.textContent = `
        .wpt-area-list::-webkit-scrollbar { width: 4px; }
        .wpt-area-list::-webkit-scrollbar-track { background: transparent; }
        .wpt-area-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `;
      document.head.appendChild(style);
    }

    const colorMap = getColorMap();

    function getFilteredFixes() {
      const q = searchInput.value.trim().toUpperCase();
      if (!q) return fixes;
      const scored = [];
      for (const f of fixes) {
        let sc = soundScore(f.ident, q);
        if (f.name) sc = Math.max(sc, soundScore(f.name.replace(/[^A-Z]/g, ""), q));
        if (sc > 0) scored.push({ fix: f, score: sc });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map(s => s.fix);
    }

    function renderList() {
      list.innerHTML = "";
      const filtered = getFilteredFixes();
      if (filtered.length === 0) {
        const msg = document.createElement("div");
        msg.style.cssText = "padding: 16px; text-align: center; color: #8b949e; font-size: 11px;";
        msg.textContent = "No matches";
        list.appendChild(msg);
        return;
      }
      filtered.forEach((fix, i) => {
        const row = document.createElement("div");
        row.style.cssText = `
          padding: 6px 16px; display: flex; align-items: center; gap: 8px;
          cursor: pointer; transition: background 0.15s;
          ${i % 2 === 0 ? "background: #0d1117;" : "background: #161b22;"}
        `;
        row.addEventListener("mouseover", () => { row.style.background = "#21262d"; });
        row.addEventListener("mouseout", () => { row.style.background = i % 2 === 0 ? "#0d1117" : "#161b22"; });
        row.addEventListener("click", () => {
          navigator.clipboard.writeText((fix.name || fix.ident).toLowerCase()).then(() => {
            identEl.textContent = "\u2713 Copied!";
            setTimeout(() => { identEl.textContent = fix.ident; }, 800);
          });
        });

        const dot = document.createElement("div");
        const c = colorMap[fix.type] || Settings.fixColor;
        dot.style.cssText = `width:8px; height:8px; border-radius:50%; background:${c}; flex-shrink:0;`;
        row.appendChild(dot);

        const identEl = document.createElement("span");
        identEl.textContent = fix.ident;
        identEl.style.cssText = `font-weight:700; font-size:12px; color:${c}; min-width: 50px;`;
        row.appendChild(identEl);

        if (fix.name) {
          const name = document.createElement("span");
          name.textContent = fix.name;
          name.style.cssText = "font-size:11px; color:#8b949e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
          row.appendChild(name);
        }

        const type = document.createElement("span");
        type.textContent = fix.type;
        type.style.cssText = "font-size:9px; color:#484f58; margin-left:auto; text-transform:uppercase; flex-shrink:0;";
        row.appendChild(type);

        list.appendChild(row);
      });
    }

    let _filterTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(renderList, 150);
    });

    renderList();

    panel.appendChild(list);
    document.body.appendChild(panel);

    // Make panel draggable
    let isDragging = false, dragOffX = 0, dragOffY = 0;
    header.style.cursor = "move";
    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      dragOffX = e.clientX - panel.getBoundingClientRect().left;
      dragOffY = e.clientY - panel.getBoundingClientRect().top;
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      panel.style.left = (e.clientX - dragOffX) + "px";
      panel.style.top = (e.clientY - dragOffY) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { isDragging = false; });
  }

})();