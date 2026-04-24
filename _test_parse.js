const fs = require('fs');
const text = fs.readFileSync('airports.csv', 'utf8');
const lines = text.split(/\r?\n/);
const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
const iIdent = headers.indexOf('ident');
const iGps = headers.indexOf('gps_code');
const iName = headers.indexOf('name');
const iLat = headers.indexOf('latitude_deg');
const iLon = headers.indexOf('longitude_deg');
const iType = headers.indexOf('type');
let count = 0;
let samples = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cols = [];
  let cur = '', inQ = false;
  for (let c = 0; c < line.length; c++) {
    if (line[c] === '"') { inQ = !inQ; }
    else if (line[c] === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += line[c];
  }
  cols.push(cur);
  const ident = (cols[iIdent] || '').trim().toUpperCase();
  const gps = (cols[iGps] || '').trim().toUpperCase();
  const aType = (cols[iType] || '').trim();
  const lat = parseFloat(cols[iLat]);
  const lon = parseFloat(cols[iLon]);
  if (!isNaN(lat) && !isNaN(lon) && (aType === 'large_airport' || aType === 'medium_airport' || aType === 'small_airport')) {
    count++;
    const icao = gps || ident;
    if (icao === 'KJFK' || icao === 'KLAX' || icao === 'EGLL') {
      samples.push({ icao, lat, lon, type: aType });
    }
  }
}
console.log('Total airports parsed:', count);
console.log('Samples:', JSON.stringify(samples, null, 2));
