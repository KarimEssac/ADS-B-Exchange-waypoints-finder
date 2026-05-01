const fs = require('fs');

const waypointsCsvPath = 'waypoints.csv';
const ausPath = 'SandCat v1.4/aus_waypoints_complete.json';
const swissPath = 'SandCat v1.4/swiss_ad2_sandcat.json';

const sidMap = new Set();
const starMap = new Set();

function extractRootWaypoint(procName) {
  // e.g. "AKMIL 2A" -> "AKMIL"
  const match = procName.match(/^([A-Z]{2,5})\s*[\dA-Z]/i);
  if (match) {
    return match[1].toUpperCase();
  }
  // Sometimes it's just the ident, e.g. "HLYWD"
  const parts = procName.trim().split(' ');
  return parts[0].toUpperCase();
}

function processJson(path) {
  try {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const [airport, details] of Object.entries(data)) {
      if (details.procedures) {
        if (details.procedures.sids) {
          for (const sid of details.procedures.sids) {
            sidMap.add(extractRootWaypoint(sid.name));
          }
        }
        if (details.procedures.stars) {
          for (const star of details.procedures.stars) {
            starMap.add(extractRootWaypoint(star.name));
          }
        }
      }
    }
  } catch (e) {
    console.error('Error processing', path, e);
  }
}

processJson(ausPath);
processJson(swissPath);

console.log(`Found ${sidMap.size} SIDs and ${starMap.size} STARs root waypoints.`);

const lines = fs.readFileSync(waypointsCsvPath, 'utf8').split(/\r?\n/);

const outLines = [];
let modifications = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  
  // Header
  if (i === 0) {
    // If the header already has 6 columns, just replace or append
    const cols = line.split(',');
    if (cols.length < 6) {
      outLines.push(line + ',Procedures');
    } else {
      outLines.push(line);
    }
    continue;
  }

  // Parse CSV (handling quotes if any, though waypoints.csv usually has Country Code,Country Name,Ident,Latitude,Longitude)
  // Let's use a simple regex split for CSV because names might have quotes? Actually, the first 5 columns are simple.
  // Wait, country names can have commas? "Korea, Republic of"
  const cols = [];
  let inQuotes = false;
  let field = "";
  for(let char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      cols.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  cols.push(field);
  
  if (cols.length >= 5) {
    const ident = cols[2].replace(/"/g, '').trim().toUpperCase();
    const isSid = sidMap.has(ident);
    const isStar = starMap.has(ident);
    
    let procs = "";
    if (isSid && isStar) procs = "SID|STAR";
    else if (isSid) procs = "SID";
    else if (isStar) procs = "STAR";
    
    // Modify columns
    if (procs) modifications++;
    
    // Create new line
    // Preserve first 5 columns exactly
    const baseCols = cols.slice(0, 5).join(',');
    outLines.push(baseCols + ',' + procs);
  } else {
    outLines.push(line);
  }
}

fs.writeFileSync(waypointsCsvPath, outLines.join('\n'));
console.log(`Modified waypoints.csv. Tagged ${modifications} waypoints as SIDs/STARs.`);
