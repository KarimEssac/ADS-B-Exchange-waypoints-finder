const fs = require('fs');
let c = fs.readFileSync('content_main.js', 'utf8');

// Add optional timeout param to bgRequest
c = c.replace(
  'function bgRequest(payload) {',
  'function bgRequest(payload, timeoutMs) {'
);
c = c.replace(
  '}, 5000);',
  '}, timeoutMs || 5000);'
);

// Use 30s timeout for the nearby airports call
c = c.replace(
  'bgRequest({ type: "GET_NEARBY_AIRPORTS", points: trackData.pts, maxNm: 150 })',
  'bgRequest({ type: "GET_NEARBY_AIRPORTS", points: trackData.pts, maxNm: 150 }, 30000)'
);

fs.writeFileSync('content_main.js', c, 'utf8');
console.log('done');
