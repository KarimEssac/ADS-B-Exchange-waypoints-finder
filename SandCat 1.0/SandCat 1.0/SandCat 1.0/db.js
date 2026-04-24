// db.js
// IndexedDB wrapper for airports, runways, bins, and NASR procedures + routes.

const DB_NAME = "nearby_airports_db_v4"; // bumped to add approach cache store cleanly
const DB_VERSION = 1;

const STORES = {
  meta: "meta",
  airports: "airports",       // key: id -> airportRec
  lookup: "lookup",           // key: ident string -> airportId
  bins: "bins",               // key: "lat|lon" -> [airportId...]
  runways: "runways",         // key: airportId -> [runways...]
  procIndex: "procIndex",     // key: airportICAO -> { departures:[{name,code}], arrivals:[{name,code}] }
  procRoutes: "procRoutes",   // key: `${TYPE}|${CODE}|${NAME}` -> [fixes...]
  approachIndex: "approachIndex" // key: ident string -> {cycle,fetchedAt,approaches:[...]}
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      for (const storeName of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}


function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function get(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readonly").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readwrite").put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

function del(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readwrite").delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

function bulkPutPairs(db, store, pairs) {
  return new Promise((resolve, reject) => {
    const os = tx(db, store, "readwrite");
    let i = 0;
    function step() {
      if (i >= pairs.length) return resolve(true);
      const [key, value] = pairs[i++];
      const r = os.put(value, key);
      r.onsuccess = step;
      r.onerror = () => reject(r.error);
    }
    step();
  });
}

const DB = {
  
  async getMeta() {
    const db = await openDB();
    return await get(db, STORES.meta, "meta");
  },

  async putMeta(meta) {
    const db = await openDB();
    return await put(db, STORES.meta, "meta", meta);
  },

    async putNavaids(obj) {
    const db = await openDB();
    return await put(db, STORES.meta, "navaids_index", obj);
  },

  async getNavaids() {
    const db = await openDB();
    return await get(db, STORES.meta, "navaids_index");
  },

  async bulkPutAirports(airports) {
    const db = await openDB();
    const pairs = airports.map(a => [a.id, a]);
    return await bulkPutPairs(db, STORES.airports, pairs);
  },

  async getAirport(id) {
    const db = await openDB();
    return await get(db, STORES.airports, id);
  },

  async getAllAirports() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORES.airports, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
},

async getAllBins() {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.bins, "readonly");
    const store = tx.objectStore(STORES.bins);
    const req = store.getAllKeys();
    const reqVals = store.getAll();

    tx.oncomplete = () => {
      const keys = req.result;
      const vals = reqVals.result;
      resolve(keys.map((k, i) => [k, vals[i]]));
    };
    tx.onerror = () => reject(tx.error);
  });
},

async getAllProcIndexes() {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.procIndex, "readonly");
    const store = tx.objectStore(STORES.procIndex);
    const reqKeys = store.getAllKeys();
    const reqVals = store.getAll();

    tx.oncomplete = () => {
      resolve(reqKeys.result.map((k, i) => [k, reqVals.result[i]]));
    };
    tx.onerror = () => reject(tx.error);
  });
},

async getAllProcRoutes() {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.procRoutes, "readonly");
    const store = tx.objectStore(STORES.procRoutes);
    const reqKeys = store.getAllKeys();
    const reqVals = store.getAll();

    tx.oncomplete = () => {
      resolve(reqKeys.result.map((k, i) => [k, reqVals.result[i]]));
    };
    tx.onerror = () => reject(tx.error);
  });
},

async getAllRunways() {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.runways, "readonly");
    const store = tx.objectStore(STORES.runways);
    const reqKeys = store.getAllKeys();
    const reqVals = store.getAll();

    tx.oncomplete = () => {
      resolve(reqKeys.result.map((k, i) => [k, reqVals.result[i]]));
    };
    tx.onerror = () => reject(tx.error);
  });
},


  async bulkPutLookup(pairs) {
    const db = await openDB();
    return await bulkPutPairs(db, STORES.lookup, pairs);
  },

  async lookupAirportId(ident) {
    const db = await openDB();
    return await get(db, STORES.lookup, String(ident || "").toUpperCase());
  },

  async bulkPutBins(pairs) {
    const db = await openDB();
    return await bulkPutPairs(db, STORES.bins, pairs);
  },

  async getBin(key) {
    const db = await openDB();
    return await get(db, STORES.bins, key);
  },

  async bulkPutRunways(pairs) {
    const db = await openDB();
    return await bulkPutPairs(db, STORES.runways, pairs);
  },

  async getRunways(airportId) {
    const db = await openDB();
    return await get(db, STORES.runways, airportId);
  },

  async putProcIndex(airportKey, value) {
    const db = await openDB();
    return await put(db, STORES.procIndex, String(airportKey || "").toUpperCase(), value);
  },

  async getProcIndex(airportKey) {
    const db = await openDB();
    return await get(db, STORES.procIndex, String(airportKey || "").toUpperCase());
  },

  async putProcRoute(key, fixes) {
    const db = await openDB();
    return await put(db, STORES.procRoutes, key, fixes);
  },

  async getProcRoute(key) {
    const db = await openDB();
    return await get(db, STORES.procRoutes, key);
  },

  // ✅ Approach cache helpers
  async putApproachIndex(ident, value) {
    const db = await openDB();
    return await put(db, STORES.approachIndex, String(ident || "").toUpperCase(), value);
  },

  async getApproachIndex(ident) {
    const db = await openDB();
    return await get(db, STORES.approachIndex, String(ident || "").toUpperCase());
  },

  async deleteApproachIndex(ident) {
    const db = await openDB();
    return await del(db, STORES.approachIndex, String(ident || "").toUpperCase());
  }
};

self.DB = DB;