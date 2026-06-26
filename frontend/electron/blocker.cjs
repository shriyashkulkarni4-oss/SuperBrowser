/**
 * blocker.cjs — Brave Shields–equivalent ad/tracker blocking engine
 *
 * Owns:
 *  - EasyList / EasyPrivacy filter list loading, caching, and weekly refresh
 *  - Network request interception via session.webRequest.onBeforeRequest
 *  - Cosmetic filter extraction for DOM element hiding
 *  - Per-hostname blocked-request counters
 *  - Per-domain whitelist enforcement
 *  - Independent blockAds / blockTrackers toggle support
 *
 * Consumed by main.cjs (init + IPC handlers).
 */

const path = require("path");
const fs = require("fs");
const { session, app } = require("electron");

// ---------------------------------------------------------------------------
// Lazy-loaded heavy deps (resolved after npm install)
// ---------------------------------------------------------------------------
let ElectronBlocker;
let Request;
let fetch;

function loadDeps() {
  if (!ElectronBlocker) {
    ({ ElectronBlocker } = require("@ghostery/adblocker-electron"));
    ({ Request } = require("@ghostery/adblocker"));
    fetch = require("cross-fetch");
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EASYLIST_URL = "https://easylist.to/easylist/easylist.txt";
const EASYPRIVACY_URL = "https://easylist.to/easylist/easyprivacy.txt";
const CACHE_FILENAME = "adblock-cache.bin";
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let blocker = null; // ElectronBlocker instance
let readSettingsFn = null; // injected from main.cjs
let writeSettingsFn = null; // injected from main.cjs
let mainWindow = null; // ref for sending IPC stats
let logEventFn = null; // injected logging

/** Per-hostname blocked request counters: Map<hostname, { ads: number, trackers: number }> */
const blockedCounts = new Map();

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
  const s = readSettingsFn ? readSettingsFn() : {};
  return {
    blockAds: s.blockAds !== false, // default true
    blockTrackers: s.blockTrackers !== false, // default true
    blockingWhitelist: Array.isArray(s.blockingWhitelist) ? s.blockingWhitelist : [],
    filterListsUpdatedAt: s.filterListsUpdatedAt || null,
  };
}

function isWhitelisted(hostname) {
  if (!hostname) return false;
  const { blockingWhitelist } = getSettings();
  // Match exact or parent domain (e.g. "ads.example.com" is covered by "example.com")
  return blockingWhitelist.some(
    (wl) => hostname === wl || hostname.endsWith(`.${wl}`)
  );
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function getCachePath() {
  return path.join(app.getPath("userData"), CACHE_FILENAME);
}

function loadCacheFromDisk() {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath);
    }
  } catch (err) {
    log("warn", "Failed to load blocker cache", { error: String(err) });
  }
  return undefined;
}

function saveCacheToDisk(data) {
  try {
    fs.writeFileSync(getCachePath(), data);
    log("info", "Blocker cache saved", { path: getCachePath() });
  } catch (err) {
    log("warn", "Failed to save blocker cache", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Filter list loading
// ---------------------------------------------------------------------------

function getBundledFilterPath(name) {
  // In packaged app, look in resources; in dev, look relative to this file
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "electron", "filters", name);
  }
  return path.join(__dirname, "filters", name);
}

async function loadFilterLists() {
  const settings = getSettings();
  const now = Date.now();
  const needsRefresh =
    !settings.filterListsUpdatedAt ||
    now - new Date(settings.filterListsUpdatedAt).getTime() > REFRESH_INTERVAL_MS;

  // Strategy 1: Try loading from binary cache (fastest)
  if (!needsRefresh) {
    const cached = loadCacheFromDisk();
    if (cached) {
      log("info", "Loading blocker from cache");
      try {
        return ElectronBlocker.deserialize(cached);
      } catch (err) {
        log("warn", "Cache deserialization failed, will re-download", {
          error: String(err),
        });
      }
    }
  }

  // Strategy 2: Download fresh lists
  try {
    log("info", "Downloading filter lists...");
    const [easylistRes, easyprivacyRes] = await Promise.all([
      fetch(EASYLIST_URL),
      fetch(EASYPRIVACY_URL),
    ]);

    if (!easylistRes.ok || !easyprivacyRes.ok) {
      throw new Error(
        `Download failed: easylist=${easylistRes.status} easyprivacy=${easyprivacyRes.status}`
      );
    }

    const [easylistText, easyprivacyText] = await Promise.all([
      easylistRes.text(),
      easyprivacyRes.text(),
    ]);

    const instance = ElectronBlocker.parse(
      `${easylistText}\n${easyprivacyText}`
    );

    // Save cache
    const serialized = instance.serialize();
    saveCacheToDisk(Buffer.from(serialized));

    // Update timestamp
    if (writeSettingsFn) {
      writeSettingsFn({ filterListsUpdatedAt: new Date().toISOString() });
    }

    log("info", "Filter lists downloaded and cached");
    return instance;
  } catch (err) {
    log("warn", "Filter list download failed, trying cache fallback", {
      error: String(err),
    });
  }

  // Strategy 3: Try loading from cache even if stale
  const cached = loadCacheFromDisk();
  if (cached) {
    log("info", "Loading blocker from stale cache");
    try {
      return ElectronBlocker.deserialize(cached);
    } catch {
      // fall through to bundled
    }
  }

  // Strategy 4: Offline fallback — parse bundled .txt files
  log("info", "Loading bundled filter lists (offline fallback)");
  try {
    const lists = [];
    const easylistPath = getBundledFilterPath("easylist.txt");
    const easyprivacyPath = getBundledFilterPath("easyprivacy.txt");

    if (fs.existsSync(easylistPath)) {
      lists.push(fs.readFileSync(easylistPath, "utf8"));
    }
    if (fs.existsSync(easyprivacyPath)) {
      lists.push(fs.readFileSync(easyprivacyPath, "utf8"));
    }

    if (lists.length > 0) {
      const instance = ElectronBlocker.parse(lists.join("\n"));
      // Cache it for next time
      const serialized = instance.serialize();
      saveCacheToDisk(Buffer.from(serialized));
      return instance;
    }
  } catch (err) {
    log("error", "Bundled filter list parsing failed", { error: String(err) });
  }

  // Strategy 5: Absolute fallback — empty blocker (no blocking, but no crash)
  log("error", "All filter list loading strategies failed, creating empty blocker");
  return ElectronBlocker.parse("");
}

// ---------------------------------------------------------------------------
// Request matching & counting
// ---------------------------------------------------------------------------

/**
 * Determine the type category of a blocked request for counter bucketing.
 * EasyPrivacy rules tend to target tracking/analytics domains; EasyList rules
 * target ad domains. We use a heuristic based on the filter that matched.
 */
function classifyBlock(url) {
  const lower = url.toLowerCase();
  // Common tracker/analytics patterns
  const trackerPatterns = [
    "analytics",
    "tracker",
    "tracking",
    "telemetry",
    "pixel",
    "beacon",
    "collect",
    "metrics",
    "stats",
    "log.",
    "fingerprint",
    "tag-manager",
    "gtag",
    "ga.js",
    "fbevents",
    "hotjar",
    "mouseflow",
    "newrelic",
    "sentry",
    "bugsnag",
    "mixpanel",
    "amplitude",
    "segment.",
    "fullstory",
    "clarity",
  ];
  for (const pat of trackerPatterns) {
    if (lower.includes(pat)) return "tracker";
  }
  return "ad";
}

function incrementCount(hostname, url) {
  if (!hostname) return;
  if (!blockedCounts.has(hostname)) {
    blockedCounts.set(hostname, { ads: 0, trackers: 0 });
  }
  const counts = blockedCounts.get(hostname);
  const type = classifyBlock(url);
  if (type === "tracker") {
    counts.trackers += 1;
  } else {
    counts.ads += 1;
  }
}

function getBlockedStats(hostname) {
  const counts = blockedCounts.get(hostname) || { ads: 0, trackers: 0 };
  return {
    adsBlocked: counts.ads,
    trackersBlocked: counts.trackers,
  };
}

function resetStats(hostname) {
  if (hostname) {
    blockedCounts.delete(hostname);
  }
}

// ---------------------------------------------------------------------------
// Cosmetic filters
// ---------------------------------------------------------------------------

function getCosmeticFilters(url) {
  if (!blocker) return { styles: "", scripts: "" };
  try {
    const parsed = new URL(url);
    const cosmetics = blocker.engine
      ? blocker.engine.getCosmeticsFilters({
          url: parsed.href,
          hostname: parsed.hostname,
          domain: parsed.hostname.split(".").slice(-2).join("."),
        })
      : { styles: "", scripts: "" };

    // The library returns { styles: string, scripts: string }
    // styles = CSS to inject, scripts = JS to inject
    return {
      styles: cosmetics.styles || "",
      scripts: cosmetics.scripts || "",
    };
  } catch {
    return { styles: "", scripts: "" };
  }
}

// ---------------------------------------------------------------------------
// Core: request interception
// ---------------------------------------------------------------------------

function setupRequestInterception(ses) {
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    // Skip non-http(s) requests
    if (
      !details.url.startsWith("http://") &&
      !details.url.startsWith("https://")
    ) {
      return callback({ cancel: false });
    }

    // Determine the top-level page hostname from the webContents
    let pageHostname = "";
    try {
      if (details.webContents) {
        const pageUrl = details.webContents.getURL();
        if (pageUrl) {
          pageHostname = new URL(pageUrl).hostname;
        }
      }
      // Fallback: try referrer or the request URL itself for main_frame
      if (!pageHostname && details.referrer) {
        pageHostname = new URL(details.referrer).hostname;
      }
      if (!pageHostname && details.resourceType === "mainFrame") {
        pageHostname = new URL(details.url).hostname;
      }
    } catch {
      // ignore URL parse errors
    }

    // Check whitelist
    if (isWhitelisted(pageHostname)) {
      return callback({ cancel: false });
    }

    // Check global toggles
    const settings = getSettings();
    if (!settings.blockAds && !settings.blockTrackers) {
      return callback({ cancel: false });
    }

    // Match against filter engine
    if (!blocker) {
      return callback({ cancel: false });
    }

    try {
      const request = Request.fromRawDetails({
        url: details.url,
        type: mapResourceType(details.resourceType),
        sourceUrl: details.referrer || details.url,
      });

      const { match } = blocker.match(request);

      if (match) {
        // Check if we should block based on type toggles
        const blockType = classifyBlock(details.url);
        if (blockType === "tracker" && !settings.blockTrackers) {
          return callback({ cancel: false });
        }
        if (blockType === "ad" && !settings.blockAds) {
          return callback({ cancel: false });
        }

        // Block the request
        incrementCount(pageHostname, details.url);

        // Send stats update to renderer
        notifyStatsUpdate(pageHostname);

        return callback({ cancel: true });
      }
    } catch (err) {
      // On match error, allow the request through
      log("warn", "Blocker match error", { url: details.url, error: String(err) });
    }

    return callback({ cancel: false });
  });
}

/**
 * Map Electron's resourceType to the types expected by the adblocker engine.
 */
function mapResourceType(type) {
  const mapping = {
    mainFrame: "document",
    subFrame: "subdocument",
    stylesheet: "stylesheet",
    script: "script",
    image: "image",
    font: "font",
    object: "object",
    xhr: "xmlhttprequest",
    ping: "ping",
    media: "media",
    websocket: "websocket",
    other: "other",
  };
  return mapping[type] || "other";
}

// ---------------------------------------------------------------------------
// IPC notification
// ---------------------------------------------------------------------------

function notifyStatsUpdate(hostname) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("blocking:stats-update", getBlockedStats(hostname));
  } catch {
    // window might be closing
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message, meta = {}) {
  if (logEventFn) {
    logEventFn(level, `[Blocker] ${message}`, meta);
  } else {
    console.log(`[Blocker][${level}] ${message}`, meta);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the ad/tracker blocker.
 * Call from app.whenReady() in main.cjs.
 *
 * @param {object} opts
 * @param {Function} opts.readSettings - readSettings() from main.cjs
 * @param {Function} opts.writeSettings - writeSettings() from main.cjs
 * @param {Function} opts.logEvent - logEvent() from main.cjs
 * @param {Function} opts.getMainWindow - function returning the current BrowserWindow
 */
async function initBlocker(opts = {}) {
  readSettingsFn = opts.readSettings || (() => ({}));
  writeSettingsFn = opts.writeSettings || (() => {});
  logEventFn = opts.logEvent || null;

  log("info", "Initializing ad/tracker blocker...");

  // Load the heavy dependencies
  loadDeps();

  // Load filter lists (with cache + fallback chain)
  blocker = await loadFilterLists();

  // Wire up request interception on the default session
  setupRequestInterception(session.defaultSession);

  log("info", "Blocker initialized successfully", {
    filtersLoaded: blocker ? true : false,
  });
}

/**
 * Set the main window reference for IPC stats notifications.
 * Called from main.cjs after window creation.
 */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * Get blocker settings for the renderer.
 */
function getBlockerSettings() {
  return getSettings();
}

/**
 * Toggle blockAds or blockTrackers globally.
 * @param {'ads' | 'trackers'} type
 */
function toggleBlocking(type) {
  const current = getSettings();
  if (type === "ads") {
    writeSettingsFn({ blockAds: !current.blockAds });
  } else if (type === "trackers") {
    writeSettingsFn({ blockTrackers: !current.blockTrackers });
  }
  return getSettings();
}

/**
 * Add or remove a domain from the whitelist.
 * @param {string} hostname
 * @param {boolean} enabled - true = blocking enabled (remove from whitelist), false = shields down (add to whitelist)
 */
function setDomainEnabled(hostname, enabled) {
  if (!hostname) return;
  const { blockingWhitelist } = getSettings();

  if (enabled) {
    // Remove from whitelist (enable blocking)
    const filtered = blockingWhitelist.filter((d) => d !== hostname);
    writeSettingsFn({ blockingWhitelist: filtered });
  } else {
    // Add to whitelist (disable blocking)
    if (!blockingWhitelist.includes(hostname)) {
      writeSettingsFn({ blockingWhitelist: [...blockingWhitelist, hostname] });
    }
  }

  // Reset stats for this domain since blocking state changed
  resetStats(hostname);
}

module.exports = {
  initBlocker,
  setMainWindow,
  getBlockedStats,
  resetStats,
  getBlockerSettings,
  toggleBlocking,
  setDomainEnabled,
  isWhitelisted,
  getCosmeticFilters,
};
