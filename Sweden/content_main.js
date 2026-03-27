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
      // Reply directly to the bridge's dedicated bbox listener (not the bg relay)
      window.postMessage({
        __wpt_source: "page",
        __wpt_bbox_reply_id: msg.__wpt_bbox_reply_id,
        bbox: bbox
      }, "*");
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
          tooltip.innerHTML = `<span style="color:${color};font-weight:bold;font-size:14px">Copied ${lowerIdent} to clipboard</span>`;
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
      tooltip.innerHTML = `<span style="font-size:15px;font-weight:bold;color:${labelColor}">${label}</span>`;
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
      bgRequest({ type: "OPEN_POPUP" }).catch(e => logMsg("Failed to open popup: " + e, true));
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

})();