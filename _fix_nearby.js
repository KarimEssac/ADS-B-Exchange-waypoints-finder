const fs = require('fs');
let c = fs.readFileSync('background.js', 'utf8');

const oldHandler = `  // GET_NEARBY_AIRPORTS: find all airports within maxNm of the flight path
  if (msg.type === "GET_NEARBY_AIRPORTS") {
    (async () => {
      await ensureOurAirportsLoaded();
      const pts = msg.points;
      const maxNm = msg.maxNm || 150;
      if (!Array.isArray(pts) || pts.length < 1 || !_ourAirportsList) {
        sendResponse({ airports: [] });
        return;
      }

      function haversineNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // Cross-track distance from point to segment (same as tracker uses)
      function ptSegDistNm(aLat, aLon, bLat, bLon, pLat, pLon) {
        const dAP = haversineNm(aLat, aLon, pLat, pLon);
        const dAB = haversineNm(aLat, aLon, bLat, bLon);
        const dBP = haversineNm(bLat, bLon, pLat, pLon);
        if (dAB < 0.01) return dAP;
        // Project onto segment
        const t = Math.max(0, Math.min(1, ((dAP * dAP) - (dBP * dBP) + (dAB * dAB)) / (2 * dAB * dAB) ));
        // Interpolate
        const iLat = aLat + t * (bLat - aLat);
        const iLon = aLon + t * (bLon - aLon);
        return haversineNm(iLat, iLon, pLat, pLon);
      }

      // Quick bbox filter first
      const degPad = maxNm / 60;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const p of pts) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      minLat -= degPad; maxLat += degPad;
      minLon -= degPad; maxLon += degPad;

      const results = [];
      for (const apt of _ourAirportsList) {
        if (apt.lat < minLat || apt.lat > maxLat || apt.lon < minLon || apt.lon > maxLon) continue;
        let bestDist = Infinity;
        if (pts.length === 1) {
          bestDist = haversineNm(pts[0].lat, pts[0].lon, apt.lat, apt.lon);
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            const d = ptSegDistNm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon, apt.lat, apt.lon);
            if (d < bestDist) bestDist = d;
          }
        }
        if (bestDist <= maxNm) {
          results.push({ ...apt, distance: Math.round(bestDist * 10) / 10 });
        }
      }
      results.sort((a, b) => a.distance - b.distance);
      sendResponse({ airports: results });
    })();
    return true;
  }`;

const newHandler = `  // GET_NEARBY_AIRPORTS: find all airports within maxNm of the flight path
  if (msg.type === "GET_NEARBY_AIRPORTS") {
    (async () => {
      await ensureOurAirportsLoaded();
      const rawPts = msg.points;
      const maxNm = msg.maxNm || 150;
      if (!Array.isArray(rawPts) || rawPts.length < 1 || !_ourAirportsList || _ourAirportsList.length === 0) {
        sendResponse({ airports: [] });
        return;
      }

      // Downsample track to ~every 5th point for performance (150 NM radius
      // doesn't need sub-mile precision).  Always keep first + last point.
      const pts = [];
      const step = Math.max(1, Math.floor(rawPts.length / 60));
      for (let i = 0; i < rawPts.length; i += step) pts.push(rawPts[i]);
      if (pts[pts.length - 1] !== rawPts[rawPts.length - 1]) pts.push(rawPts[rawPts.length - 1]);

      function haversineNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // Cross-track distance from point to segment
      function ptSegDistNm(aLat, aLon, bLat, bLon, pLat, pLon) {
        const dAP = haversineNm(aLat, aLon, pLat, pLon);
        const dAB = haversineNm(aLat, aLon, bLat, bLon);
        const dBP = haversineNm(bLat, bLon, pLat, pLon);
        if (dAB < 0.01) return dAP;
        const t = Math.max(0, Math.min(1, ((dAP * dAP) - (dBP * dBP) + (dAB * dAB)) / (2 * dAB * dAB) ));
        const iLat = aLat + t * (bLat - aLat);
        const iLon = aLon + t * (bLon - aLon);
        return haversineNm(iLat, iLon, pLat, pLon);
      }

      // Quick bbox filter
      const degPad = maxNm / 60;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const p of pts) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      minLat -= degPad; maxLat += degPad;
      minLon -= degPad; maxLon += degPad;

      const results = [];
      for (const apt of _ourAirportsList) {
        if (apt.lat < minLat || apt.lat > maxLat || apt.lon < minLon || apt.lon > maxLon) continue;
        let bestDist = Infinity;
        if (pts.length === 1) {
          bestDist = haversineNm(pts[0].lat, pts[0].lon, apt.lat, apt.lon);
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            const d = ptSegDistNm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon, apt.lat, apt.lon);
            if (d < bestDist) bestDist = d;
            if (bestDist < 1) break; // close enough, no need to check more segments
          }
        }
        if (bestDist <= maxNm) {
          results.push({ ...apt, distance: Math.round(bestDist * 10) / 10 });
        }
      }
      results.sort((a, b) => a.distance - b.distance);
      sendResponse({ airports: results });
    })();
    return true;
  }`;

const idx = c.indexOf(oldHandler);
if (idx === -1) {
  console.log('FAILED: old handler not found');
  process.exit(1);
}
c = c.substring(0, idx) + newHandler + c.substring(idx + oldHandler.length);
fs.writeFileSync('background.js', c, 'utf8');
console.log('UPDATED SUCCESSFULLY');
