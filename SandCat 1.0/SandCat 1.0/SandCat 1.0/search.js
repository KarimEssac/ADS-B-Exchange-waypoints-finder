function initAirportSearch() {
  const input = document.getElementById("airportSearchQuery");
  const contextInput = document.getElementById('airportSearchContext');
  const resultsEl = document.getElementById("airportSearchResults")
  const filtersEl = document.getElementById('airportSearchFilters');
  const contextToggleBtn = document.getElementById("airportContextToggle");
const contextBlock = document.getElementById("airportContextBlock");

contextToggleBtn?.addEventListener("click", () => {
  const collapsed = contextBlock?.classList.toggle("is-collapsed");
  contextToggleBtn.textContent = collapsed ? "Show" : "Hide";
});

  input?.addEventListener("input", (e) => e.stopPropagation());
input?.addEventListener("keydown", (e) => e.stopPropagation());
contextInput?.addEventListener("input", (e) => e.stopPropagation());
contextInput?.addEventListener("keydown", (e) => e.stopPropagation());

  let activeFilter = 'all';
  let debounceTimer = null;
  let searchRequestId = 0;

  const STATE_CODES = {
    'alabama': 'al',
    'alaska': 'ak',
    'american samoa': 'as',
    'arizona': 'az',
    'arkansas': 'ar',
    'california': 'ca',
    'colorado': 'co',
    'connecticut': 'ct',
    'delaware': 'de',
    'district of columbia': 'dc',
    'florida': 'fl',
    'georgia': 'ga',
    'guam': 'gu',
    'hawaii': 'hi',
    'idaho': 'id',
    'illinois': 'il',
    'indiana': 'in',
    'iowa': 'ia',
    'kansas': 'ks',
    'kentucky': 'ky',
    'louisiana': 'la',
    'maine': 'me',
    'maryland': 'md',
    'massachusetts': 'ma',
    'michigan': 'mi',
    'minnesota': 'mn',
    'mississippi': 'ms',
    'missouri': 'mo',
    'montana': 'mt',
    'nebraska': 'ne',
    'nevada': 'nv',
    'new hampshire': 'nh',
    'new jersey': 'nj',
    'new mexico': 'nm',
    'new york': 'ny',
    'north carolina': 'nc',
    'north dakota': 'nd',
    'northern mariana islands': 'mp',
    'ohio': 'oh',
    'oklahoma': 'ok',
    'oregon': 'or',
    'pennsylvania': 'pa',
    'puerto rico': 'pr',
    'rhode island': 'ri',
    'south carolina': 'sc',
    'south dakota': 'sd',
    'tennessee': 'tn',
    'texas': 'tx',
    'utah': 'ut',
    'vermont': 'vt',
    'virginia': 'va',
    'u.s. virgin islands': 'vi',
    'washington': 'wa',
    'west virginia': 'wv',
    'wisconsin': 'wi',
    'wyoming': 'wy'
  };
  const STATE_CODE_SET = new Set(Object.values(STATE_CODES));
  const AIRCRAFT_PROFILE_LABELS = {
    a: 'airline profile',
    b: 'bizjet profile',
    c: 'cargo profile',
    g: 'GA piston profile',
    h: 'helicopter profile',
    m: 'multi-engine GA profile',
    s: 'seaplane profile',
    t: 'turboprop profile'
  };
  const AIRCRAFT_BUCKET_ALIASES = {
    beechcraft: 'beech',
    bonanza: 'beech',
    baron: 'beech',
    challenger: 'bombardier',
    lear: 'learjet',
    kingair: 'kingair',
    helicopter: 'helicopter'
  };

  const COMMERCIAL_CODES = [
    'aal', 'aay', 'asa', 'dal', 'edv', 'eny', 'fft', 'jbu', 'nks',
    'rpa', 'skw', 'swa', 'ual'
  ];

  const CONTEXT_HINTS = {
    commercial: [
      'airline', 'airlines', 'commercial', 'passenger', 'scheduled',
      'american', 'delta', 'united', 'southwest', 'jetblue', 'alaska',
      'frontier', 'spirit', 'allegiant'
    ],
    cargo: [
      'cargo', 'freight', 'fedex', 'ups', 'dhl', 'atlas', 'kalitta'
    ],
    military: [
      'military', 'air force', 'army', 'navy', 'marine', 'marines',
      'coast guard', 'guard', 'reach', 'rescue', 'patriot'
    ],
    heli: [
      'helicopter', 'heli', 'heliport', 'medevac', 'air ambulance',
      'air evac', 'lifeflight', 'life flight'
    ],
    seaplane: [
      'seaplane', 'floatplane', 'float plane', 'water landing'
    ],
    privateOps: [
      'private', 'general aviation', 'ga', 'registration', 'tail number',
      'cessna', 'cirrus', 'piper', 'bonanza', 'beechcraft', 'mooney'
    ]
  };

  const MILITARY_AIRPORT_RE = /\b(air force|afb|sfb|army|navy|marine|guard|joint|base|nas|jrb|fort|camp)\b/;
  const FLIGHT_NUMBER_RE = new RegExp(`\\b(?:${COMMERCIAL_CODES.join('|')})\\s?\\d{1,4}\\b`, 'gi');
  const TAIL_NUMBER_RE = /\bN\d[0-9A-HJ-NP-Z]{0,5}\b/gi;
  const NAVAID_ROWS = typeof NAVAIDS_BY_AIRPORT !== 'undefined' ? NAVAIDS_BY_AIRPORT : [];
  const navaidsByAirport = new Map(
    NAVAID_ROWS.map((entry) => [
      compactWhitespace(entry.airport || ''),
      (entry.navaids || []).map((navaid) => ({
        ...navaid,
        identText: compactWhitespace(navaid.ident || ''),
        nameText: compactWhitespace(navaid.name || ''),
        typeText: normalizeNavaidType(navaid.type || ''),
        freqKHz: Number.isFinite(Number(navaid.khz)) ? Number(navaid.khz) : null,
        searchTokens: new Set(buildCompoundTokens([
          navaid.ident || '',
          navaid.name || '',
          navaid.type || '',
          navaid.freq || '',
          navaid.usage || '',
          navaid.power || ''
        ].join(' ')))
      }))
    ])
  );
  const dynamicDatasets = {
    aircraft: { cache: null, promise: null, file: 'aircraft-hints.json' },
    aircraftLocations: { cache: null, promise: null, file: 'aircraft-locations.json' },
    waypoints: { cache: null, promise: null, file: 'waypoints.json' }
  };

  const index = AIRPORTS.map((airport, i) => {
    const airportIdent = compactWhitespace(airport.id || airport.icao || airport.iata || airport.lc || '');
    const navaids = navaidsByAirport.get(airportIdent) || [];
    const navaidText = compactWhitespace(
      navaids.map((navaid) => [navaid.ident, navaid.name, navaid.type, navaid.freq].filter(Boolean).join(' ')).join(' ')
    );
    const nameText = compactWhitespace(airport.n || '');
    const cityText = compactWhitespace(airport.city || '');
    const stateText = compactWhitespace(airport.st || '');
    const stateCode = STATE_CODES[stateText] || '';
    const keywordText = compactWhitespace((airport.kw || '') + ' ' + (airport.id || ''));
    const codeText = compactWhitespace([
      airport.id || '',
      airport.iata || '',
      airport.icao || '',
      airport.lc || '',
      stateCode
    ].join(' '));
    const searchText = compactWhitespace([
      airport.n || '',
      airport.id || '',
      airport.iata || '',
      airport.icao || '',
      airport.lc || '',
      airport.city || '',
      airport.st || '',
      stateCode,
      airport.kw || '',
      navaidText
    ].join(' '));

    return {
      i,
      airportIdent,
      navaids,
      navaidText,
      nameText,
      cityText,
      stateText,
      stateCode,
      keywordText,
      codeText,
      searchText,
      keywordTokens: new Set(tokenize((airport.kw || '') + ' ' + (airport.id || ''))),
      wordTokens: buildCompoundTokens([
        airport.n || '',
        airport.city || '',
        airport.kw || ''
      ].join(' ')),
      isMilitary: MILITARY_AIRPORT_RE.test(searchText),
      isHeli: compactWhitespace(airport.t || '') === 'heliport',
      isSeaplane: compactWhitespace(airport.t || '') === 'seaplane base',
      isScheduled: airport.sched === '1'
    };
  });

  function normalizeText(value) {
    return (value || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function compactWhitespace(value) {
    return normalizeText(value).replace(/\s+/g, ' ').trim();
  }

  function tokenize(value) {
    return normalizeText(value)
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function buildCompoundTokens(value) {
    const tokens = tokenize(value);
    const compounds = [];

    for (let i = 0; i < tokens.length; i++) {
      const current = tokens[i];
      if (current.length >= 3) compounds.push(current);
      if (tokens[i + 1]) compounds.push(current + tokens[i + 1]);
      if (tokens[i + 2] && current.length <= 2) compounds.push(current + tokens[i + 1] + tokens[i + 2]);
    }

    return uniqueStrings(compounds.filter((token) => token.length >= 3));
  }

  function distanceNm(lat1, lon1, lat2, lon2) {
    const radians = Math.PI / 180;
    const dLat = (lat2 - lat1) * radians;
    const dLon = (lon2 - lon1) * radians;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
    return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getRuntimeUrl(fileName) {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      return chrome.runtime.getURL(fileName);
    }
    return fileName;
  }

  async function loadDynamicDataset(name) {
    const state = dynamicDatasets[name];
    if (!state) return null;
    if (state.cache) return state.cache;
    if (!state.promise) {
      const url = getRuntimeUrl(state.file);
      state.promise = fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`Failed to load ${state.file}`);
          return response.json();
        })
        .then((payload) => {
          state.cache = payload;
          return payload;
        })
        .catch((error) => {
          console.warn(error);
          state.cache = null;
          return null;
        });
    }
    return state.promise;
  }

  function normalizeNavaidType(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, '');
  }

  function extractFrequencyHints(raw, text) {
    const hints = new Map();
    const decimalMatches = raw.match(/\b\d{3}\.\d{1,2}\b/g) || [];
    const integerMatches = raw.match(/\b\d{3,6}\b/g) || [];
    const hasNdbContext = text.includes('ndb') || text.includes('khz');

    for (const match of decimalMatches) {
      const mhz = Number(match);
      if (mhz >= 108 && mhz <= 118) {
        const khz = Math.round(mhz * 1000);
        hints.set(khz, { khz, label: `${mhz.toFixed(2)} MHz` });
      }
    }

    for (const match of integerMatches) {
      const value = Number(match);
      if (value >= 190 && value <= 535 && hasNdbContext) {
        hints.set(value, { khz: value, label: `${value} kHz` });
      } else if (value >= 10800 && value <= 11795) {
        const khz = value * 10;
        hints.set(khz, { khz, label: `${(khz / 1000).toFixed(2)} MHz` });
      } else if (value >= 108000 && value <= 117950) {
        hints.set(value, { khz: value, label: `${(value / 1000).toFixed(2)} MHz` });
      }
    }

    return [...hints.values()];
  }

  function extractNavaidTypes(text) {
    const set = new Set();
    if (text.includes('vortac')) set.add('vortac');
    if (text.includes('vordme') || text.includes('vor dme')) set.add('vordme');
    if (text.includes('ndbdme') || text.includes('ndb dme')) set.add('ndbdme');
    if (text.includes('tacan')) set.add('tacan');
    if (text.includes('ndb')) set.add('ndb');
    if (text.includes('vor')) set.add('vor');
    if (text.includes('dme')) set.add('dme');
    return [...set];
  }

  function extractStateHints(raw, text) {
    const hints = new Set();
    const rawStateCodes = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];

    for (const [stateName, code] of Object.entries(STATE_CODES)) {
      if (text.includes(stateName)) {
        hints.add(stateName);
        hints.add(code);
      }
    }

    for (const token of rawStateCodes) {
      const code = token.toLowerCase();
      if (STATE_CODE_SET.has(code)) hints.add(code);
    }

    return [...hints];
  }

  function extractWaypointTokens(tokens) {
    return uniqueStrings(tokens.filter((token) => /^[a-z]{5}$/.test(token)));
  }

  function normalizeAircraftBucket(value) {
    const key = normalizeText(value).replace(/\s+/g, '');
    return AIRCRAFT_BUCKET_ALIASES[key] || key;
  }

  function extractAircraftShorthand(raw) {
    const normalized = compactWhitespace(raw);
    const pattern = /\b(cessna|citation|piper|beech(?:craft)?|bonanza|baron|cirrus|mooney|gulfstream|lear(?:jet)?|pilatus|king air|embraer|bombardier|challenger|airbus|boeing|robinson|bell|helicopter)\s+([a-z0-9]{2,4})\b/gi;
    const results = [];
    const seen = new Set();
    let match = null;

    while ((match = pattern.exec(normalized))) {
      const bucket = normalizeAircraftBucket(match[1]);
      const suffix = match[2].toLowerCase();
      const key = `${bucket}:${suffix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        bucket,
        suffix,
        label: `${match[1].trim()} ${match[2].toUpperCase()}`
      });
    }

    return results;
  }

  function waypointScoreForDistance(distNm) {
    if (distNm <= 8) return 280;
    if (distNm <= 20) return 220;
    if (distNm <= 40) return 150;
    if (distNm <= 70) return 90;
    return 50;
  }

  function addAirportSignal(map, airportIdent, label, points) {
    if (!airportIdent || !points) return;

    const existing = map.get(airportIdent) || {
      points: 0,
      labels: [],
      aircraft: []
    };

    existing.points += points;
    if (label && !existing.labels.includes(label)) existing.labels.push(label);
    map.set(airportIdent, existing);
  }

  function addAircraftSignal(signal, label, profile, strength) {
    if (!profile || !label) return;
    const key = `${profile}:${label}`;
    if (!signal.seen.has(key)) {
      signal.seen.add(key);
      signal.aircraftHints.push({ label, profile, strength });
    }
  }

  function isFixedWingProfile(profile) {
    return profile === 'g' || profile === 'm' || profile === 't' || profile === 'b' || profile === 'a' || profile === 'c';
  }

  function getAircraftProfilesFromData(aircraftData, keys) {
    if (!aircraftData) return [];

    for (const key of keys) {
      const profiles = Array.isArray(aircraftData.suffixProfiles && aircraftData.suffixProfiles[key])
        ? aircraftData.suffixProfiles[key].filter(Boolean)
        : [];
      if (profiles.length > 0) return uniqueStrings(profiles);

      const dominant = aircraftData.suffix && aircraftData.suffix[key];
      if (dominant) return [dominant];
    }

    return [];
  }

  function navaidLinkRank(navaid) {
    if (navaid.by === 'associated') return 0;
    if (navaid.by === 'code') return 1;
    if (navaid.by === 'nearby') return 2;
    return 3;
  }

  function navaidStrength(navaid) {
    if (navaid.by === 'associated') return 1;
    if (navaid.by === 'code') return 0.95;
    if (typeof navaid.distNm !== 'number') return 0.65;
    if (navaid.distNm <= 3) return 0.9;
    if (navaid.distNm <= 8) return 0.78;
    if (navaid.distNm <= 15) return 0.66;
    return 0.52;
  }

  function formatNavaidSummary(navaid) {
    const parts = [
      navaid.ident || '',
      navaid.type || '',
      navaid.freq || ''
    ].filter(Boolean);
    return parts.join(' ');
  }

  function phonetic(value) {
    return normalizeText(value)
      .replace(/[^a-z]/g, '')
      .replace(/ph/g, 'f')
      .replace(/ght/g, 't')
      .replace(/ck/g, 'k')
      .replace(/sch/g, 'sk')
      .replace(/sh/g, 's')
      .replace(/th/g, 't')
      .replace(/wh/g, 'w')
      .replace(/wr/g, 'r')
      .replace(/kn/g, 'n')
      .replace(/gn/g, 'n')
      .replace(/mb$/g, 'm')
      .replace(/ee/g, 'e')
      .replace(/oo/g, 'u')
      .replace(/ou/g, 'ow')
      .replace(/([a-z])\1+/g, '$1');
  }

  function levenshtein(a, b, maxDist) {
    if (!a || !b) return Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

    const la = a.length;
    const lb = b.length;
    const dp = Array.from({ length: la + 1 }, () => new Uint16Array(lb + 1));

    for (let i = 0; i <= la; i++) dp[i][0] = i;
    for (let j = 0; j <= lb; j++) dp[0][j] = j;

    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }

    return dp[la][lb];
  }

  function buildQueryInfo(raw) {
    const text = compactWhitespace(raw);
    const rawUpper = raw.toUpperCase();
    const tokens = uniqueStrings(tokenize(raw));
    const compoundTokens = buildCompoundTokens(raw);
    const strippedTailNumbers = uniqueStrings(
      tokens
        .filter((token) => /^\d{4,5}$/.test(token))
        .map((token) => `n${token}`)
    );
    return {
      raw: raw.trim(),
      text,
      tokens,
      compoundTokens,
      nameTokens: compoundTokens.filter((token) => token.length >= 3 && /[a-z]/.test(token)),
      registrationSuffixes: uniqueStrings(tokens.filter((token) => /^\d{3}$/.test(token))),
      tailNumbers: uniqueStrings([
        ...(rawUpper.match(TAIL_NUMBER_RE) || []).map((value) => value.toLowerCase()),
        ...strippedTailNumbers
      ]),
      waypointTokens: extractWaypointTokens(tokens),
      aircraftShorthand: extractAircraftShorthand(raw),
      phonetic: phonetic(raw)
    };
  }

  function parseContext(raw) {
    const text = compactWhitespace(raw);
    const tokens = uniqueStrings(tokenize(raw));
    const compoundTokens = buildCompoundTokens(raw);
    const rawUpper = raw.toUpperCase();
    const strippedTailNumbers = uniqueStrings(
      tokens
        .filter((token) => /^\d{4,5}$/.test(token))
        .map((token) => `n${token}`)
    );
    const tailNumbers = uniqueStrings([
      ...(rawUpper.match(TAIL_NUMBER_RE) || []).map(v => v.toLowerCase()),
      ...strippedTailNumbers
    ]);
    const flightNumbers = uniqueStrings((rawUpper.match(FLIGHT_NUMBER_RE) || []).map(v => v.replace(/\s+/g, '').toLowerCase()));
    const codeLikeTokens = tokens.filter((token) => token.length >= 3 && token.length <= 5 && /[a-z]/.test(token));
    const registrationSuffixes = uniqueStrings(tokens.filter((token) => /^\d{3}$/.test(token)));
    const navaidTokens = uniqueStrings(
      [...tokens.filter((token) => token.length >= 3), ...compoundTokens]
        .filter((token) => /[a-z]/.test(token))
    );
    const frequencyHints = extractFrequencyHints(raw, text);
    const navaidTypes = extractNavaidTypes(text);
    const stateHints = extractStateHints(raw, text);
    const waypointTokens = extractWaypointTokens(tokens);
    const aircraftShorthand = extractAircraftShorthand(raw);

    return {
      raw: raw.trim(),
      text,
      tokens,
      compoundTokens,
      navaidTokens,
      codeLikeTokens,
      registrationSuffixes,
      frequencyHints,
      navaidTypes,
      stateHints,
      waypointTokens,
      aircraftShorthand,
      tailNumbers,
      flightNumbers,
      hasCommercial: flightNumbers.length > 0 || hasAnyPhrase(text, CONTEXT_HINTS.commercial),
      hasCargo: hasAnyPhrase(text, CONTEXT_HINTS.cargo),
      hasMilitary: hasAnyPhrase(text, CONTEXT_HINTS.military),
      hasHeli: hasAnyPhrase(text, CONTEXT_HINTS.heli),
      hasSeaplane: hasAnyPhrase(text, CONTEXT_HINTS.seaplane),
      hasPrivateOps: tailNumbers.length > 0 || hasAnyPhrase(text, CONTEXT_HINTS.privateOps)
    };
  }

  function hasAnyPhrase(haystack, phrases) {
    return phrases.some((phrase) => haystack.includes(phrase));
  }

  function addReason(reasonMap, label, points) {
    const current = reasonMap.get(label) || 0;
    if (points > current) reasonMap.set(label, points);
  }

  function formatClueToken(token) {
    if (!token) return '';
    if (/^[a-z0-9]{2,5}$/.test(token)) return token.toUpperCase();
    return token;
  }

  async function resolveDynamicHints(query, context) {
    const hints = {
      aircraftHints: [],
      aircraftConstraintSources: [],
      exactAircraft: [],
      suffixAircraft: [],
      waypointAirports: new Map(),
      waypointLabels: [],
      seen: new Set()
    };

    const waypointTokens = uniqueStrings([...query.waypointTokens, ...context.waypointTokens]);
    if (waypointTokens.length > 0) {
      const waypointData = await loadDynamicDataset('waypoints');
      if (waypointData) {
        for (const token of waypointTokens) {
          const row = waypointData[token];
          if (!row || !Array.isArray(row[1])) continue;

          const label = row[0]
            ? `${formatClueToken(token)} (${row[0].toUpperCase()})`
            : formatClueToken(token);
          if (!hints.waypointLabels.includes(label)) hints.waypointLabels.push(label);

          for (const link of row[1]) {
            const airportIdent = compactWhitespace(link[0]);
            const distNm = Number(link[1]);
            const linkType = link[2] || 'near';
            if (!airportIdent || !Number.isFinite(distNm)) continue;
            const points = waypointScoreForDistance(distNm) + (linkType === 'ref' ? 180 : 0);
            addAirportSignal(hints.waypointAirports, airportIdent, label, points);
          }
        }
      }
    }

    const exactTails = uniqueStrings([...query.tailNumbers, ...context.tailNumbers]);
    const suffixHints = uniqueStrings([...query.registrationSuffixes, ...context.registrationSuffixes]);
    const shorthand = uniqueStrings(
      [...query.aircraftShorthand, ...context.aircraftShorthand]
        .map((item) => `${item.bucket}:${item.suffix}:${item.label}`)
    ).map((value) => {
      const [bucket, suffix, ...labelParts] = value.split(':');
      return { bucket, suffix, label: labelParts.join(':') };
    });
    const shorthandSuffixesHandled = new Set();
    const hasTextAnchor =
      query.tokens.some((token) => /[a-z]/.test(token)) ||
      context.tokens.some((token) => /[a-z]/.test(token)) ||
      context.stateHints.length > 0 ||
      waypointTokens.length > 0 ||
      context.codeLikeTokens.length > 0;

    if (exactTails.length > 0 || shorthand.length > 0 || (suffixHints.length > 0 && hasTextAnchor)) {
      const [aircraftData, aircraftLocations] = await Promise.all([
        loadDynamicDataset('aircraft'),
        (exactTails.length > 0 || suffixHints.length > 0) ? loadDynamicDataset('aircraftLocations') : Promise.resolve(null)
      ]);

      if (exactTails.length > 0) {
        for (const tail of exactTails) {
          const profile = aircraftData && aircraftData.full ? aircraftData.full[tail] : '';
          if (profile) {
            addAircraftSignal(hints, `${tail.toUpperCase()} (${AIRCRAFT_PROFILE_LABELS[profile] || 'aircraft'})`, profile, 'strong');
          }

          const locationIndex = aircraftLocations && aircraftLocations.records
            ? aircraftLocations.records[tail]
            : null;
          const location = Number.isInteger(locationIndex) && aircraftLocations && Array.isArray(aircraftLocations.locations)
            ? aircraftLocations.locations[locationIndex]
            : null;

          if (profile || location) {
            const exactHint = {
              tail,
              profile,
              profiles: profile ? [profile] : [],
              label: location ? location[0] : '',
              city: location ? location[1] : '',
              state: location ? location[2] : '',
              lat: location && Number.isFinite(Number(location[3])) ? Number(location[3]) : null,
              lon: location && Number.isFinite(Number(location[4])) ? Number(location[4]) : null
            };
            hints.exactAircraft.push(exactHint);

            if (exactHint.profiles.length > 0 && exactHint.lat !== null && exactHint.lon !== null) {
              hints.aircraftConstraintSources.push({
                profiles: exactHint.profiles,
                locations: [{ lat: exactHint.lat, lon: exactHint.lon }]
              });
            }
          }
        }
      }

      if (aircraftData) {
        for (const item of shorthand) {
          const specificKey = `${item.bucket}:${item.suffix}`;
          const genericKey = `*:${item.suffix}`;
          const profiles = getAircraftProfilesFromData(aircraftData, [specificKey, genericKey]);
          const profile = (aircraftData.suffix && (aircraftData.suffix[specificKey] || aircraftData.suffix[genericKey])) || profiles[0] || '';
          if (profile) {
            addAircraftSignal(hints, `${item.label} (${AIRCRAFT_PROFILE_LABELS[profile] || 'aircraft'})`, profile, 'soft');
          }
        }
      }

      if (aircraftLocations && aircraftLocations.bucketSuffix3 && Array.isArray(aircraftLocations.locations)) {
        for (const item of shorthand) {
          if (!/^\d{3}$/.test(item.suffix)) continue;

          const key = `${item.bucket}:${item.suffix}`;
          const indexes = aircraftLocations.bucketSuffix3[key];
          if (!Array.isArray(indexes) || indexes.length === 0) continue;

          const locations = indexes
            .map((index) => aircraftLocations.locations[index])
            .filter(Boolean)
            .map((location) => ({
              label: location[0] || '',
              city: location[1] || '',
              state: location[2] || '',
              lat: Number.isFinite(Number(location[3])) ? Number(location[3]) : null,
              lon: Number.isFinite(Number(location[4])) ? Number(location[4]) : null
            }));

          if (locations.length === 0) continue;

          shorthandSuffixesHandled.add(item.suffix);
          const profiles = getAircraftProfilesFromData(aircraftData, [key, `*:${item.suffix}`]);
          const suffixHint = {
            suffix: item.suffix,
            label: item.label,
            profile: (aircraftData && aircraftData.suffix && (aircraftData.suffix[key] || aircraftData.suffix[`*:${item.suffix}`])) || profiles[0] || '',
            profiles,
            locations,
            specificity: 'maker'
          };
          hints.suffixAircraft.push(suffixHint);

          if (suffixHint.profiles.length > 0) {
            hints.aircraftConstraintSources.push({
              profiles: suffixHint.profiles,
              locations: suffixHint.locations
            });
          }
        }
      }

      if (aircraftLocations && aircraftLocations.suffix3 && Array.isArray(aircraftLocations.locations)) {
        for (const suffix of suffixHints) {
          if (shorthandSuffixesHandled.has(suffix)) continue;

          const indexes = aircraftLocations.suffix3[suffix];
          if (!Array.isArray(indexes) || indexes.length === 0) continue;

          const locations = indexes
            .map((index) => aircraftLocations.locations[index])
            .filter(Boolean)
            .map((location) => ({
              label: location[0] || '',
              city: location[1] || '',
              state: location[2] || '',
              lat: Number.isFinite(Number(location[3])) ? Number(location[3]) : null,
              lon: Number.isFinite(Number(location[4])) ? Number(location[4]) : null
            }));

          if (locations.length === 0) continue;

          const profiles = getAircraftProfilesFromData(aircraftData, [`*:${suffix}`]);
          const suffixHint = {
            suffix,
            profile: (aircraftData && aircraftData.suffix && aircraftData.suffix[`*:${suffix}`]) || profiles[0] || '',
            profiles,
            locations,
            specificity: 'generic'
          };
          hints.suffixAircraft.push(suffixHint);

          if (suffixHint.profiles.length > 0) {
            hints.aircraftConstraintSources.push({
              profiles: suffixHint.profiles,
              locations: suffixHint.locations
            });
          }
        }
      }
    }

    return hints;
  }

  function applyAircraftHintScore(airport, entry, reasons, hint, appliedAircraftHints) {
    let points = 0;

    if (hint.profile === 'h' && entry.isHeli) {
      points += hint.strength === 'strong' ? 190 : 150;
    } else if (hint.profile === 's' && entry.isSeaplane) {
      points += hint.strength === 'strong' ? 190 : 150;
    } else if (hint.profile === 'a') {
      if (entry.isScheduled) points += hint.strength === 'strong' ? 135 : 100;
      if (airport.t === 'Large') points += 70;
      else if (airport.t === 'Medium') points += 45;
    } else if (hint.profile === 'c') {
      if (entry.isScheduled) points += 85;
      if (airport.t === 'Large') points += 38;
      else if (airport.t === 'Medium') points += 26;
    } else if (hint.profile === 'b') {
      if (!entry.isScheduled) points += hint.strength === 'strong' ? 70 : 50;
      if (airport.t === 'Medium') points += 62;
      else if (airport.t === 'Large') points += 52;
      else if (airport.t === 'Small') points += 18;
    } else if (hint.profile === 't') {
      if (!entry.isScheduled) points += 35;
      if (airport.t === 'Medium') points += 52;
      else if (airport.t === 'Small') points += 48;
      else if (airport.t === 'Large') points += 18;
    } else if (hint.profile === 'm') {
      if (!entry.isScheduled) points += 40;
      if (airport.t === 'Small') points += 54;
      else if (airport.t === 'Medium') points += 48;
      else if (airport.t === 'Large') points += 10;
    } else if (hint.profile === 'g') {
      if (!entry.isScheduled) points += hint.strength === 'strong' ? 48 : 36;
      if (airport.t === 'Small') points += 60;
      else if (airport.t === 'Medium') points += 42;
      else if (airport.t === 'Large') points += 6;
    }

    if (points > 0) {
      addReason(reasons, hint.label, points);
      if (!appliedAircraftHints.includes(hint.label)) appliedAircraftHints.push(hint.label);
    }

    return points;
  }

  function getHintProfiles(hint) {
    return uniqueStrings(
      (hint && Array.isArray(hint.profiles) ? hint.profiles : [hint && hint.profile])
        .filter(Boolean)
    );
  }

  function aircraftProfileRadius(profile) {
    if (profile === 'h') return 100;
    if (profile === 'g') return 200;
    if (profile === 's') return 200;
    if (profile === 't') return 300;
    if (profile === 'm') return 500;
    if (profile === 'b' || profile === 'a' || profile === 'c') return Infinity;
    return Infinity;
  }

  function getAircraftRadiusForProfiles(profiles) {
    const normalizedProfiles = uniqueStrings((profiles || []).filter(Boolean));
    if (normalizedProfiles.length === 0) return Infinity;

    let maxRadius = 0;
    for (const profile of normalizedProfiles) {
      const radius = aircraftProfileRadius(profile);
      if (!Number.isFinite(radius)) return Infinity;
      if (radius > maxRadius) maxRadius = radius;
    }

    return maxRadius || Infinity;
  }

  function aircraftBaseDistancePointsForProfiles(profiles, distNm) {
    if (!Number.isFinite(distNm)) return 0;

    const radiusNm = getAircraftRadiusForProfiles(profiles);
    if (!Number.isFinite(radiusNm)) return 0;

    const ratio = distNm / radiusNm;
    if (ratio <= 0.12) return 230;
    if (ratio <= 0.35) return 195;
    if (ratio <= 0.65) return 155;
    if (ratio <= 1) return 110;
    return 0;
  }

  function getAircraftConstraintFactor(dynamicHints, airport) {
    const sources = dynamicHints && Array.isArray(dynamicHints.aircraftConstraintSources)
      ? dynamicHints.aircraftConstraintSources
      : [];
    if (sources.length === 0) return 1;

    const airportLat = Number(airport.lat);
    const airportLon = Number(airport.lon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) return 1;

    let sawUsableSource = false;
    let bestFactor = 0;

    for (const source of sources) {
      const profiles = getHintProfiles(source);
      const radiusNm = getAircraftRadiusForProfiles(profiles);
      if (!Number.isFinite(radiusNm)) return 1;

      const locations = Array.isArray(source.locations) ? source.locations : [];
      const withCoords = locations.filter((location) =>
        Number.isFinite(location && location.lat) && Number.isFinite(location && location.lon)
      );
      if (withCoords.length === 0) continue;

      sawUsableSource = true;

      const bestDist = Math.min(
        ...withCoords.map((location) => distanceNm(location.lat, location.lon, airportLat, airportLon))
      );

      if (bestDist <= radiusNm * 0.4) bestFactor = Math.max(bestFactor, 1);
      else if (bestDist <= radiusNm * 0.75) bestFactor = Math.max(bestFactor, 0.7);
      else if (bestDist <= radiusNm) bestFactor = Math.max(bestFactor, 0.45);
    }

    return sawUsableSource ? bestFactor : 1;
  }

  function hasFixedWingAircraftClue(dynamicHints) {
    if (!dynamicHints) return false;

    const pools = [
      dynamicHints.aircraftHints || [],
      dynamicHints.exactAircraft || [],
      dynamicHints.suffixAircraft || []
    ];

    for (const pool of pools) {
      for (const hint of pool) {
        if (getHintProfiles(hint).some(isFixedWingProfile)) return true;
      }
    }

    return false;
  }

  function fixedWingNameMatchBonus(query, airport, entry) {
    if (!query || !query.text || query.text.length < 4) return 0;
    if (entry.isHeli || entry.isSeaplane) return 0;
    if (!entry.nameText.startsWith(query.text)) return 0;
    if (!/\b(airport|field|airfield|airpark|municipal)\b/.test(entry.nameText)) return 0;

    if (airport.t === 'Medium') return 125;
    if (airport.t === 'Small') return 115;
    if (airport.t === 'Large') return 95;
    return 80;
  }

  function aircraftBaseCityPoints(profile, airport) {
    if (profile === 'h') return airport.t === 'Heliport' ? 140 : 90;
    if (profile === 'g' || profile === 'm') {
      if (airport.t === 'Small') return 130;
      if (airport.t === 'Medium') return 105;
      if (airport.t === 'Large') return 55;
      return 95;
    }
    if (profile === 't') {
      if (airport.t === 'Medium') return 110;
      if (airport.t === 'Small') return 95;
      if (airport.t === 'Large') return 60;
      return 80;
    }
    if (profile === 'b') {
      if (airport.t === 'Medium') return 90;
      if (airport.t === 'Large') return 80;
      if (airport.t === 'Small') return 55;
      return 70;
    }
    if (profile === 'a' || profile === 'c') return airport.t === 'Large' ? 35 : 20;
    return 70;
  }

  function aircraftBaseStatePoints(profile, airport, entry) {
    if (profile === 'h') return entry.isHeli ? 55 : 28;
    if (profile === 'g' || profile === 'm') {
      if (airport.t === 'Small') return 42;
      if (airport.t === 'Medium') return 34;
      return 18;
    }
    if (profile === 't') {
      if (airport.t === 'Medium') return 32;
      if (airport.t === 'Small') return 26;
      return 14;
    }
    if (profile === 'b') return airport.t === 'Large' ? 18 : 24;
    if (profile === 'a' || profile === 'c') return entry.isScheduled ? 12 : 6;
    return 16;
  }

  function getQueryAnchorTokens(query) {
    if (!query || !Array.isArray(query.tokens)) return [];
    return uniqueStrings(
      query.tokens.filter((token) =>
        token.length >= 3
        && /[a-z]/.test(token)
        && !STATE_CODES[token]
        && !STATE_CODE_SET.has(token)
      )
    );
  }

  function getAircraftQueryAlignmentPoints(query, entry, homeState, strength) {
    if (!query || !query.text || !homeState || entry.stateCode !== homeState) return 0;

    const anchorTokens = getQueryAnchorTokens(query);
    if (anchorTokens.length === 0) return 0;

    let matchedTokens = 0;
    for (const token of anchorTokens) {
      if (entry.searchText.includes(token) || entry.keywordText.includes(token)) matchedTokens++;
    }

    if (matchedTokens === 0) return 0;

    const phraseMatch = query.text.length >= 5
      && (entry.nameText.includes(query.text) || entry.cityText.includes(query.text) || entry.keywordText.includes(query.text));
    const strong = strength === 'strong';
    let points = 0;

    if (phraseMatch) points += strong ? 150 : 70;

    if (matchedTokens === anchorTokens.length) {
      points += strong ? 115 : 45;
    } else {
      points += Math.min(strong ? 80 : 35, matchedTokens * (strong ? 35 : 16));
    }

    return points;
  }

  function getAircraftQueryConflictPenalty(query, entry, homeState) {
    if (!query || !query.text || !homeState || entry.stateCode === homeState) return 0;

    const anchorTokens = getQueryAnchorTokens(query);
    if (anchorTokens.length < 2) return 0;

    let matchedTokens = 0;
    for (const token of anchorTokens) {
      if (entry.searchText.includes(token) || entry.keywordText.includes(token)) matchedTokens++;
    }

    if (matchedTokens === 0) return 0;

    const phraseMatch = query.text.length >= 5
      && (entry.nameText.includes(query.text) || entry.cityText.includes(query.text) || entry.keywordText.includes(query.text));

    if (phraseMatch && matchedTokens === anchorTokens.length) return 260;
    if (matchedTokens === anchorTokens.length) return 130;
    return Math.min(70, matchedTokens * 28);
  }

  function getAircraftSuffixConflictPenalty(query, entry, suffixHint) {
    if (!query || !query.text || !suffixHint || suffixHint.specificity !== 'maker') return 0;

    const anchorTokens = getQueryAnchorTokens(query);
    if (anchorTokens.length < 2) return 0;

    const stateSet = new Set(
      (suffixHint.locations || [])
        .map((location) => location.state)
        .filter(Boolean)
    );
    if (stateSet.size === 0 || stateSet.has(entry.stateCode)) return 0;

    let matchedTokens = 0;
    for (const token of anchorTokens) {
      if (entry.searchText.includes(token) || entry.keywordText.includes(token)) matchedTokens++;
    }
    if (matchedTokens === 0) return 0;

    const phraseMatch = query.text.length >= 5
      && (entry.nameText.includes(query.text) || entry.cityText.includes(query.text) || entry.keywordText.includes(query.text));

    let penalty = phraseMatch && matchedTokens === anchorTokens.length ? 210 : 110;
    if (stateSet.size <= 6) penalty += 30;
    if (stateSet.size === 1) penalty += 45;
    return penalty;
  }

  function applyAircraftLocationScore(airport, entry, reasons, aircraftHint, appliedAircraftHomes, query) {
    const homeLabel = aircraftHint.label || aircraftHint.tail.toUpperCase();
    const profiles = getHintProfiles(aircraftHint);
    let points = 0;

    if (aircraftHint.state && entry.stateCode === aircraftHint.state) {
      points += Math.round(aircraftBaseStatePoints(aircraftHint.profile, airport, entry) * 2.1);
    }

    if (aircraftHint.city && aircraftHint.state && entry.cityText === aircraftHint.city && entry.stateCode === aircraftHint.state) {
      points += aircraftBaseCityPoints(aircraftHint.profile, airport);
    }

    const airportLat = Number(airport.lat);
    const airportLon = Number(airport.lon);
    if (Number.isFinite(airportLat) && Number.isFinite(airportLon) && aircraftHint.lat !== null && aircraftHint.lon !== null) {
      points += aircraftBaseDistancePointsForProfiles(
        profiles,
        distanceNm(aircraftHint.lat, aircraftHint.lon, airportLat, airportLon)
      );
    }

    const alignmentPoints = getAircraftQueryAlignmentPoints(query, entry, aircraftHint.state, 'strong');
    if (alignmentPoints > 0) {
      points += alignmentPoints;
      addReason(reasons, 'tail clue aligns with guessed place', alignmentPoints);
    }

    points -= getAircraftQueryConflictPenalty(query, entry, aircraftHint.state);

    if (points > 0) {
      const label = `tail home area: ${homeLabel}`;
      addReason(reasons, label, points);
      if (!appliedAircraftHomes.includes(homeLabel)) appliedAircraftHomes.push(homeLabel);
    }

    return points;
  }

  function applyAircraftSuffixScore(airport, entry, reasons, suffixHint, appliedAircraftHomes, query) {
    const sameStateLocations = suffixHint.locations.filter((location) => location.state === entry.stateCode);
    if (sameStateLocations.length === 0) {
      return -getAircraftSuffixConflictPenalty(query, entry, suffixHint);
    }

    const profiles = getHintProfiles(suffixHint);
    const profile = suffixHint.profile || profiles[0] || '';
    const specificityMultiplier = suffixHint.specificity === 'maker' ? 1.65 : 1;
    let points = 0;

    const cityMatch = sameStateLocations.find((location) => location.city && location.city === entry.cityText);
    if (cityMatch) {
      points += Math.round(aircraftBaseCityPoints(profile, airport) * 0.55 * specificityMultiplier);
    } else {
      points += Math.round(aircraftBaseStatePoints(profile, airport, entry) * 1.35 * specificityMultiplier);
    }

    if (suffixHint.specificity === 'maker') {
      if (sameStateLocations.length === 1) points += 110;
      else if (sameStateLocations.length <= 2) points += 70;
    }

    const airportLat = Number(airport.lat);
    const airportLon = Number(airport.lon);
    if (Number.isFinite(airportLat) && Number.isFinite(airportLon)) {
      const withCoords = sameStateLocations.filter((location) => location.lat !== null && location.lon !== null);
      if (withCoords.length > 0) {
        const bestDist = Math.min(
          ...withCoords.map((location) => distanceNm(location.lat, location.lon, airportLat, airportLon))
        );
        points += Math.round(aircraftBaseDistancePointsForProfiles(profiles, bestDist) * 0.42 * specificityMultiplier);
      }
    }

    const alignmentPoints = getAircraftQueryAlignmentPoints(query, entry, entry.stateCode, 'soft');
    if (alignmentPoints > 0) {
      points += Math.round(alignmentPoints * specificityMultiplier);
      addReason(reasons, 'tail suffix aligns with guessed place', alignmentPoints);
    }

    if (points > 0) {
      const states = uniqueStrings(sameStateLocations.map((location) => location.state.toUpperCase()));
      const sourceLabel = suffixHint.label ? `${suffixHint.label} -> ` : '';
      const label = `${sourceLabel}tail suffix: ${suffixHint.suffix}${states.length === 1 ? ` (${states[0]})` : ''}`;
      addReason(reasons, label, points);
      if (!appliedAircraftHomes.includes(label)) appliedAircraftHomes.push(label);
    }

    return points;
  }

  function scoreAirport(entry, query, context, dynamicHints) {
    const airport = AIRPORTS[entry.i];
    const reasons = new Map();
    const appliedAircraftHints = [];
    const appliedAircraftHomes = [];
    let score = 0;

    const ident = compactWhitespace(airport.id || '');
    const iata = compactWhitespace(airport.iata || '');
    const icao = compactWhitespace(airport.icao || '');
    const localCode = compactWhitespace(airport.lc || '');
    const codeSet = new Set([ident, iata, icao, localCode].filter(Boolean));
    const navaids = entry.navaids || [];
    const waypointSignal = dynamicHints && dynamicHints.waypointAirports
      ? dynamicHints.waypointAirports.get(entry.airportIdent)
      : null;
    const aircraftConstraintFactor = getAircraftConstraintFactor(dynamicHints, airport);
    const fixedWingAircraftClue = hasFixedWingAircraftClue(dynamicHints);

    if (waypointSignal && waypointSignal.points > 0) {
      const waypointPoints = Math.round(waypointSignal.points * aircraftConstraintFactor);
      if (waypointPoints > 0) {
        score += waypointPoints;
        addReason(reasons, 'waypoint clue: ' + waypointSignal.labels[0], waypointPoints);
      }
    }

    if (query.text) {
      if (query.text.length <= 5) {
        if (ident === query.text) {
          score += 1100;
          addReason(reasons, 'exact ident match', 1100);
        } else if (iata === query.text) {
          score += 1000;
          addReason(reasons, 'exact IATA match', 1000);
        } else if (icao === query.text) {
          score += 960;
          addReason(reasons, 'exact ICAO match', 960);
        } else if (localCode === query.text) {
          score += 920;
          addReason(reasons, 'exact local code match', 920);
        }
      }

      for (const navaid of navaids) {
        const strength = navaidStrength(navaid);
        if (query.text.length <= 4 && navaid.identText === query.text) {
          const points = Math.round(220 * strength);
          score += points;
          addReason(reasons, 'NAVAID ident: ' + formatClueToken(navaid.ident), points);
        } else if (query.text.length >= 4 && navaid.nameText === query.text) {
          const points = Math.round(150 * strength);
          score += points;
          addReason(reasons, 'NAVAID name: ' + (navaid.name || navaid.ident), points);
        } else if (
          query.text.length >= 4 &&
          (navaid.searchTokens.has(query.text)
            || query.nameTokens.some((token) => token.length >= 4 && navaid.searchTokens.has(token)))
        ) {
          const points = Math.round(105 * strength);
          score += points;
          addReason(reasons, 'NAVAID name: ' + (navaid.name || navaid.ident), points);
        }
      }

      if (entry.nameText === query.text) {
        score += 820;
        addReason(reasons, 'exact airport name', 820);
      } else if (entry.nameText.startsWith(query.text)) {
        score += 520;
        addReason(reasons, 'name starts with clue', 520);
      } else if (entry.nameText.includes(query.text)) {
        score += 320;
        addReason(reasons, 'name contains clue', 320);
      }

      if (entry.cityText === query.text) {
        score += 420;
        addReason(reasons, 'exact city match', 420);
      } else if (entry.cityText.startsWith(query.text)) {
        score += 280;
        addReason(reasons, 'city starts with clue', 280);
      } else if (entry.cityText.includes(query.text)) {
        score += 170;
        addReason(reasons, 'city contains clue', 170);
      }

      if (entry.stateText === query.text || entry.stateCode === query.text) {
        score += 120;
        addReason(reasons, 'state match', 120);
      }

      if (entry.keywordText.includes(query.text)) {
        score += 220;
        addReason(reasons, 'alias/keyword match', 220);
      }

      if (query.tokens.length > 1) {
        let matchedTokens = 0;
        for (const token of query.tokens) {
          if (entry.searchText.includes(token)) matchedTokens++;
        }
        if (matchedTokens === query.tokens.length) {
          score += 360 + matchedTokens * 35;
          addReason(reasons, 'all query words matched', 360 + matchedTokens * 35);
        } else if (matchedTokens > 0) {
          score += matchedTokens * 70;
          addReason(reasons, 'partial multi-word match', matchedTokens * 70);
        }
      }

      if (score < 140 && query.text.length >= 3) {
        for (const word of entry.wordTokens) {
          if (word.length < 3) continue;

          const distance = levenshtein(query.text, word, 3);
          if (distance <= 1) {
            score += 190 - distance * 50;
            addReason(reasons, 'close spelling match', 190 - distance * 50);
          } else if (distance <= 2 && query.text.length >= 4) {
            score += 90;
            addReason(reasons, 'close spelling match', 90);
          } else if (distance <= 3 && query.text.length >= 6) {
            score += 40;
            addReason(reasons, 'close spelling match', 40);
          }

          const wordPhonetic = phonetic(word);
          if (wordPhonetic.length >= 3 && query.phonetic.length >= 3) {
            if (wordPhonetic === query.phonetic) {
              score += 170;
              addReason(reasons, 'phonetic match', 170);
            } else if (wordPhonetic.startsWith(query.phonetic) || query.phonetic.startsWith(wordPhonetic)) {
              score += 95;
              addReason(reasons, 'phonetic match', 95);
            } else {
              const phoneticDistance = levenshtein(query.phonetic, wordPhonetic, 2);
              if (phoneticDistance <= 1) {
                score += 80;
                addReason(reasons, 'phonetic match', 80);
              }
            }
          }
        }
      }
    }

    if (context.text) {
      for (const token of context.tokens) {
        if (token.length < 3) continue;

        if (entry.cityText === token) {
          score += 400;
          addReason(reasons, 'city clue: ' + formatClueToken(token), 400);
        } else if (entry.cityText.includes(token)) {
          score += token.length >= 4 ? 180 : 95;
          addReason(reasons, 'city clue: ' + formatClueToken(token), token.length >= 4 ? 180 : 95);
        }

        if (entry.stateText === token || entry.stateCode === token) {
          score += 130;
          addReason(reasons, 'state clue: ' + formatClueToken(token), 130);
        }

        if (entry.keywordText.includes(token)) {
          score += token.length >= 4 ? 95 : 55;
          addReason(reasons, 'keyword clue: ' + formatClueToken(token), token.length >= 4 ? 95 : 55);
        }

        if (entry.nameText.includes(token) && token.length >= 4) {
          score += 55;
          addReason(reasons, 'name clue: ' + formatClueToken(token), 55);
        }
      }

      for (const stateHint of context.stateHints) {
        if (entry.stateText === stateHint || entry.stateCode === stateHint) {
          score += 140;
          addReason(reasons, 'state clue: ' + formatClueToken(stateHint), 140);
        }
      }

      for (const token of context.codeLikeTokens) {
        if (codeSet.has(token)) {
          score += 220;
          addReason(reasons, 'code clue: ' + formatClueToken(token), 220);
        } else if (entry.keywordTokens.has(token)) {
          score += 120;
          addReason(reasons, 'keyword clue: ' + formatClueToken(token), 120);
        }
      }

      if (context.hasMilitary && entry.isMilitary) {
        score += 230;
        addReason(reasons, 'military clue', 230);
      }

      if (context.hasHeli && entry.isHeli) {
        score += 260;
        addReason(reasons, 'heliport clue', 260);
      }

      if (context.hasSeaplane && entry.isSeaplane) {
        score += 260;
        addReason(reasons, 'seaplane clue', 260);
      }

      if (context.hasCommercial) {
        if (entry.isScheduled) {
          score += 100;
          addReason(reasons, 'airline/callsign clue', 100);
        }
        if (airport.t === 'Large') score += 22;
        else if (airport.t === 'Medium') score += 10;
      }

      if (context.hasCargo) {
        if (entry.isScheduled) {
          score += 55;
          addReason(reasons, 'cargo clue', 55);
        }
        if (entry.keywordText.includes('cargo') || entry.keywordText.includes('freight')) {
          score += 80;
          addReason(reasons, 'cargo clue', 80);
        }
      }

      if (context.flightNumbers.length > 0) {
        if (entry.isScheduled) {
          score += 90;
          addReason(reasons, 'flight-number clue', 90);
        }
        if (airport.t === 'Large') score += 20;
      }

      if (context.tailNumbers.length > 0 && !context.hasCommercial && context.flightNumbers.length === 0) {
        if (!entry.isScheduled) {
          score += 40;
          addReason(reasons, 'tail-number clue', 40);
        }
        if (airport.t === 'Small') score += 22;
        else if (airport.t === 'Medium') score += 10;
      }

      if (context.hasPrivateOps && !context.hasCommercial && context.flightNumbers.length === 0) {
        if (!entry.isScheduled) {
          score += 45;
          addReason(reasons, 'private/GA clue', 45);
        }
      }

      for (const navaid of navaids) {
        const strength = navaidStrength(navaid);
        let matchedSignals = 0;
        let namePoints = 0;
        let nameReason = '';

        for (const token of context.codeLikeTokens) {
          if (navaid.identText === token) {
            const points = Math.round(330 * strength * aircraftConstraintFactor);
            if (points <= 0) continue;
            score += points;
            addReason(reasons, 'NAVAID ident: ' + formatClueToken(navaid.ident), points);
            matchedSignals++;
          }
        }

        if (context.text.length >= 4 && navaid.nameText) {
          if (context.text === navaid.nameText) {
            namePoints = Math.max(namePoints, Math.round(210 * strength * aircraftConstraintFactor));
            nameReason = 'NAVAID name: ' + (navaid.name || navaid.ident);
          } else if (context.text.includes(navaid.nameText)) {
            namePoints = Math.max(namePoints, Math.round(155 * strength * aircraftConstraintFactor));
            nameReason = 'NAVAID name: ' + (navaid.name || navaid.ident);
          }
        }

        for (const token of context.navaidTokens) {
          if (token.length < 4) continue;
          if (navaid.searchTokens.has(token)) {
            const points = Math.round((token.length >= 6 ? 145 : 110) * strength * aircraftConstraintFactor);
            if (points > namePoints) {
              namePoints = points;
              nameReason = 'NAVAID name: ' + (navaid.name || navaid.ident);
            }
          }
        }

        if (namePoints > 0) {
          score += namePoints;
          addReason(reasons, nameReason, namePoints);
          matchedSignals++;
        }

        for (const hint of context.frequencyHints) {
          if (navaid.freqKHz && navaid.freqKHz === hint.khz) {
            const points = Math.round(260 * strength * aircraftConstraintFactor);
            if (points <= 0) continue;
            score += points;
            addReason(reasons, 'NAVAID freq: ' + hint.label, points);
            matchedSignals++;
            break;
          }
        }

        for (const type of context.navaidTypes) {
          if (navaid.typeText === type || navaid.typeText.includes(type)) {
            const points = Math.round(45 * strength * aircraftConstraintFactor);
            if (points <= 0) continue;
            score += points;
            addReason(reasons, 'NAVAID type: ' + (navaid.type || '').toUpperCase(), points);
            matchedSignals++;
            break;
          }
        }

        if (matchedSignals >= 2) {
          const points = Math.round((matchedSignals >= 3 ? 210 : 125) * strength * aircraftConstraintFactor);
          if (points > 0) {
            score += points;
            addReason(reasons, 'NAVAID combo: ' + formatClueToken(navaid.ident || navaid.name), points);
          }
        }
      }
    }

    if (dynamicHints && dynamicHints.aircraftHints) {
      for (const hint of dynamicHints.aircraftHints) {
        score += applyAircraftHintScore(airport, entry, reasons, hint, appliedAircraftHints);
      }
    }

    if (dynamicHints && dynamicHints.exactAircraft) {
      for (const aircraftHint of dynamicHints.exactAircraft) {
        score += applyAircraftLocationScore(airport, entry, reasons, aircraftHint, appliedAircraftHomes, query);
      }
    }

    if (dynamicHints && dynamicHints.suffixAircraft) {
      for (const suffixHint of dynamicHints.suffixAircraft) {
        score += applyAircraftSuffixScore(airport, entry, reasons, suffixHint, appliedAircraftHomes, query);
      }
    }

    if (fixedWingAircraftClue) {
      if (entry.isHeli) {
        score -= 180;
      } else if (entry.isSeaplane) {
        score -= 120;
      }

      const fixedWingBonus = fixedWingNameMatchBonus(query, airport, entry);
      if (fixedWingBonus > 0) {
        score += fixedWingBonus;
        addReason(reasons, 'fixed-wing airport match', fixedWingBonus);
      }
    }

    if (score > 0) {
      if (airport.t === 'Large') score += 15;
      else if (airport.t === 'Medium') score += 8;
      if (entry.isScheduled) score += 5;
    }

    return {
      score,
      reasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label]) => label),
      linkedNavaids: navaids
        .slice()
        .sort((a, b) => {
          const rankDiff = navaidLinkRank(a) - navaidLinkRank(b);
          if (rankDiff !== 0) return rankDiff;
          return (a.distNm || 0) - (b.distNm || 0);
        })
        .slice(0, 4)
        .map(formatNavaidSummary),
      linkedWaypoints: waypointSignal ? waypointSignal.labels.slice(0, 3) : [],
      aircraftHints: appliedAircraftHints.slice(0, 2),
      aircraftHomes: appliedAircraftHomes.slice(0, 2)
    };
  }

  function escapeHtml(value) {
    return (value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function highlight(text, query) {
    if (!query || query.length < 2) return escapeHtml(text || '');
    const indexOf = normalizeText(text).indexOf(normalizeText(query));
    if (indexOf === -1) return escapeHtml(text || '');
    return escapeHtml(text.slice(0, indexOf))
      + '<span class="hl">' + escapeHtml(text.slice(indexOf, indexOf + query.length)) + '</span>'
      + escapeHtml(text.slice(indexOf + query.length));
  }

function renderCard(airport, queryRaw, matchInfo) {
  const title = airport.n || airport.id || "Unknown Airport";
  const icao = airport.icao || airport.id || "";
  const size = airport.t || "";
  const city = airport.city || "";
  const state = airport.st || "";
  const airportIdent = airport.icao || airport.id || "";
  const adsbUrl = buildAdsbAirportUrl(airport);

  const metaText = [size, city, state, icao].filter(Boolean).join(" • ");

  const seenReasonBuckets = new Set();
  const reasonText = (matchInfo.reasons || [])
    .filter(Boolean)
    .filter(reason => {
      const bucket =
        /name .* clue/i.test(reason) ? "name" :
        /city .* clue/i.test(reason) ? "city" :
        reason;
      if (seenReasonBuckets.has(bucket)) return false;
      seenReasonBuckets.add(bucket);
      return true;
    })
    .slice(0, 2)
    .join(" • ");

  return `
    <div class="airportLookupCard compact" data-airport-ident="${escapeHtml(airportIdent)}">
      <div class="airportLookupCardTitle">${highlight(title, queryRaw)}</div>
      ${metaText ? `<div class="airportLookupMetaLine">${escapeHtml(metaText)}</div>` : ""}
      <div class="airportLookupRunways" data-runway-row>${airportIdent ? "Loading runways..." : ""}</div>
      ${reasonText ? `<div class="airportLookupReasonLine">${escapeHtml(reasonText)}</div>` : ""}
      ${adsbUrl ? `
        <div class="airportLookupCardActions">
          <a class="airportLookupAdsbLink" href="${adsbUrl}" target="_blank" rel="noopener">
            Open in ADS-B
          </a>
        </div>
      ` : ""}
    </div>
  `;
}

  function renderEmpty(queryRaw, contextRaw) {
    if (!queryRaw && !contextRaw) {
      return `<div class="empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <div class="empty-title">Search US Airports</div>
        <div class="empty-sub">Use the top box for the airport guess and the second box for supporting clues.</div>
        <div class="tip">
          <strong>Useful combinations:</strong><br>
          <code>ohair</code> + <code>chicago</code><br>
          <code>logan</code> + <code>boston BOSOX</code><br>
          <code>unknown</code> + <code>ORD VOR 113.20</code><br>
          <code>unknown</code> + <code>AABEE atlanta</code><br>
          <code>mccarran</code> + <code>LAS Southwest</code><br>
          <code>unknown</code> + <code>N123AB Cessna AABEE</code><br>
          Location, airport/NAVAID codes, and waypoint fixes are the strongest signals. Exact tail numbers can also bias results toward a likely home area.
        </div>
      </div>`;
    }

    const subtitle = contextRaw
      ? 'Try a broader airport guess or remove a clue that may be too specific.'
      : 'Try a different spelling, a shorter query, or check the filters.';

    return `<div class="empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 8v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
      </svg>
      <div class="empty-title">No matches found</div>
      <div class="empty-sub">${subtitle}</div>
    </div>`;
  }

  function passesFilter(airport) {
    if (activeFilter === 'scheduled') return airport.sched === '1';
    if (activeFilter === 'all') return true;
    return airport.t === activeFilter;
  }

  async function doSearch() {
    const requestId = ++searchRequestId;
    const query = buildQueryInfo(input.value || '');
    const context = parseContext(contextInput ? contextInput.value || '' : '');

    if (!query.text && !context.text) {
      resultsEl.innerHTML = renderEmpty('', '');
      return;
    }

    const dynamicHints = await resolveDynamicHints(query, context);
    if (requestId !== searchRequestId) return;

    const seedTokens = uniqueStrings([
      ...query.tokens,
      ...context.tokens.filter((token) => token.length >= 3)
    ]);

    const scored = [];

    for (let idx = 0; idx < AIRPORTS.length; idx++) {
      const airport = AIRPORTS[idx];
      if (!passesFilter(airport)) continue;

      const entry = index[idx];
      let shouldCheck = seedTokens.length === 0;

      for (const token of seedTokens) {
        if (token.length <= 2 || entry.searchText.includes(token) || entry.searchText.includes(token.slice(0, 3))) {
          shouldCheck = true;
          break;
        }
      }

      if (!shouldCheck && (query.text.length >= 3 || context.codeLikeTokens.length > 0 || context.hasCommercial || context.hasMilitary || context.hasHeli || context.hasSeaplane || context.hasCargo || context.tailNumbers.length > 0)) {
        shouldCheck = true;
      }

      if (!shouldCheck) continue;

      const matchInfo = scoreAirport(entry, query, context, dynamicHints);
      if (matchInfo.score > 0) scored.push({ idx, score: matchInfo.score, matchInfo });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 50);

    if (top.length === 0) {
      resultsEl.innerHTML = renderEmpty(query.raw, context.raw);
      return;
    }

    const countText = scored.length > 50 ? `50 of ${scored.length}` : String(scored.length);
    const withContext = context.text ? ' ranked with context clues' : '';
    const countHtml = `<div class="result-count">${countText} result${scored.length !== 1 ? 's' : ''}${withContext}</div>`;
    const cardsHtml = top.map((result) => renderCard(AIRPORTS[result.idx], query.raw, result.matchInfo)).join('');

    resultsEl.innerHTML = countHtml + cardsHtml;
    resultsEl.querySelectorAll(".airportLookupCard").forEach(card => {
  card.addEventListener("click", (e) => {
    if (e.target.closest(".airportLookupAdsbLink")) return;

    const ident = card.dataset.airportIdent;
    if (!ident) return;

    openAirportInSandcat(ident);
  });
});
const cards = [...resultsEl.querySelectorAll(".airportLookupCard")];

for (const card of cards) {
  const ident = card.dataset.airportIdent;
  const runwayRow = card.querySelector("[data-runway-row]");
  if (!ident || !runwayRow) continue;

  const runways = await getSandcatRunwaysForAirport(ident);
  const text = formatAirportRunwaysFromList(runways);

  runwayRow.textContent = text || "";
  if (!text) runwayRow.remove();
}
    resultsEl.scrollTop = 0;
  }

  function debounceSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void doSearch();
    }, 140);
  }


  function openAirportInSandcat(ident) {
  const mainInput = document.getElementById("airportInput");
  const searchBtn = document.getElementById("searchBtn");
  if (!mainInput || !searchBtn || !ident) return;

  mainInput.value = ident.toUpperCase();
  mainInput.dispatchEvent(new Event("input", { bubbles: true }));
  searchBtn.click();
}

  input.addEventListener('input', debounceSearch);
  if (contextInput) contextInput.addEventListener('input', debounceSearch);

  filtersEl.addEventListener('click', (event) => {
    const button = event.target.closest('.filter-btn');
    if (!button) return;
    filtersEl.querySelectorAll('.filter-btn').forEach((node) => node.classList.remove('active'));
    button.classList.add('active');
    activeFilter = button.dataset.filter;
    void doSearch();
  });

  resultsEl.addEventListener('click', (event) => {
    const mapLink = event.target.closest('[data-map-link]');
    if (mapLink) return;

    const card = event.target.closest('.card');
    if (card) card.classList.toggle('expanded');
  });

  resultsEl.innerHTML = renderEmpty('', '');
  input.focus();
}


function extractReplayFromGlobalKey(raw) {
  if (!raw) return null;

  const text = String(raw);

  // NEW: 260122_0406_123.wav  => 2026-01-22-04:06
  const newMatch = text.match(/\b(\d{6})_(\d{4})_/);
  if (newMatch) {
    const yymmdd = newMatch[1];
    const hhmm = newMatch[2];

    const year = "20" + yymmdd.slice(0, 2);
    const month = yymmdd.slice(2, 4);
    const day = yymmdd.slice(4, 6);

    return `${year}-${month}-${day}-${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  }

  // OLD: something-Jan-12-2026-0406Z_123.wav => 2026-01-12-04:06
  const oldMatch = text.match(
    /-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{4})Z/i
  );

  if (oldMatch) {
    const monthMap = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04",
      May: "05", Jun: "06", Jul: "07", Aug: "08",
      Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };

    const month = monthMap[oldMatch[1]];
    const day = oldMatch[2].padStart(2, "0");
    const year = oldMatch[3];
    const hhmm = oldMatch[4];

    return `${year}-${month}-${day}-${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  }

  return null;
}

function buildAdsbAirportUrl(airport) {
  if (!airport) return "";

  const ident = airport.icao || airport.id || airport.iata || "";
  const lat = Number(airport.lat);
  const lon = Number(airport.lon);

  if (!ident || !Number.isFinite(lat) || !Number.isFinite(lon)) return "";

  const rawKey =
    document.getElementById("lbxKey")?.value?.trim() || "";

  const replay = extractReplayFromGlobalKey(rawKey);

  const params = new URLSearchParams();
  if (replay) params.set("replay", replay);

  params.set("lat", lat.toFixed(3));
  params.set("lon", lon.toFixed(3));
  params.set("zoom", "10");
  params.set("airport", ident);

  return `https://globe.adsbexchange.com/?${params.toString()}`;
}

function buildAdsbAirportUrl(ident) {
  if (!ident) return "";

  const rawKey =
    document.getElementById("lbxKey")?.value?.trim() ||
    "";

  const replay = extractReplayFromGlobalKey(rawKey);

  if (replay) {
    return `https://globe.adsbexchange.com/?replay=${encodeURIComponent(replay)}&airport=${encodeURIComponent(ident)}`;
  }

  return `https://globe.adsbexchange.com/?airport=${encodeURIComponent(ident)}`;
}

function openAirportInSandcat(ident) {
  const mainInput = document.getElementById("airportInput");
  const searchBtn = document.getElementById("searchBtn");
  if (!mainInput || !searchBtn || !ident) return;

  const value = String(ident).toUpperCase().trim();
  mainInput.value = value;

  mainInput.dispatchEvent(new Event("input", { bubbles: true }));
  mainInput.dispatchEvent(new Event("change", { bubbles: true }));

  searchBtn.click();
}

async function getSandcatRunwaysForAirport(ident) {
  if (!ident || !chrome?.runtime?.sendMessage) return [];
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "GET_AIRPORT_RUNWAYS",
      ident
    });
    return resp?.ok && Array.isArray(resp.runways) ? resp.runways : [];
  } catch {
    return [];
  }
}

function formatAirportRunwaysFromList(runways) {
  const list = Array.isArray(runways) ? runways : [];
  if (!list.length) return "";

  const seen = new Set();
  const labels = [];

  for (const r of list) {
    const a = normalizeRunwayLabel(r.ident1 || r.le_ident || r.low || r.runway1);
    const b = normalizeRunwayLabel(r.ident2 || r.he_ident || r.high || r.runway2);
    if (!a || !b) continue;

    const label = `${a}/${b}`;
    const reverse = `${b}/${a}`;
    if (seen.has(label) || seen.has(reverse)) continue;

    seen.add(label);
    seen.add(reverse);
    labels.push(label);
  }

  return labels.join(", ");
}

function normalizeRunwayLabel(value) {
  if (!value) return "";
  return String(value).trim().toUpperCase().replace(/^RWY\s+/, "");
}