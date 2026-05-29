// background.js — service worker

// ─────────────────────────────────────────────────────────────────────────────
// KEEPALIVE
// Chrome MV3 service workers are killed after ~30 s of no Chrome-API activity.
// We fix this in two complementary ways:
//   1. A global interval that pings chrome.storage every 20 s.
//   2. Our sleep() helper splits waits into ≤20 s chunks and pings between them.
// Together these ensure the SW is NEVER idle for more than 20 s while running.
// ─────────────────────────────────────────────────────────────────────────────
let _keepaliveTimer = null;
let popupWindowId = null;

function _ping() {
  chrome.storage.session.set({ _ka: Date.now() }).catch(() => {});
}

function startKeepalive() {
  _ping();
  if (!_keepaliveTimer) _keepaliveTimer = setInterval(_ping, 20_000);
}

function stopKeepalive() {
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
}

// Drop-in replacement for setTimeout-only sleep.
// Every ≤20 s chunk ends with a Chrome-API call so the SW timer resets.
async function sleep(ms) {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(20_000, remaining);
    await new Promise(r => setTimeout(r, chunk));
    _ping();
    remaining -= chunk;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// We keep the live state in memory AND mirror the parts that matter to
// chrome.storage.session so they survive a SW restart within the session.
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  running: false,
  paused:  false,
  tabId:   null,
  queue:   [],
  results: [],
  seenUrls: new Set(),
  failed:  [],
  cities:  [],
  currentCity: null,
  totalLinks: 0,
  scraped: 0,
  failedCount: 0,
  config: { maxAgents: 30, maxPages: 2, delay: 4 },
};

// Persist results + key counters after every profile so an export still works
// even if the SW is restarted mid-run.
async function persistResults() {
  try {
    await chrome.storage.session.set({
      results:     state.results,
      scraped:     state.scraped,
      failedCount: state.failedCount,
      totalLinks:  state.totalLinks,
    });
  } catch (_) {}
}

// ── Window Management ─────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async () => {
  const popupUrl = chrome.runtime.getURL("popup.html");
  
  // Try to find an existing window with our URL
  const windows = await chrome.windows.getAll({ populate: true });
  const existingWindow = windows.find(win => 
    win.tabs && win.tabs.some(tab => tab.url === popupUrl)
  );

  if (existingWindow) {
    popupWindowId = existingWindow.id;
    chrome.windows.update(popupWindowId, { focused: true });
  } else {
    createPopupWindow();
  }
});

function createPopupWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 420,
    height: 700
  }, (window) => {
    popupWindowId = window.id;
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// ── Messages from popup ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === "start") {
    startScraping(msg.config);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "stop") {
    state.running = false;
    state.paused  = false;
    stopKeepalive();
    sendState("Stopped by user.", "idle");
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "continue") {
    // User solved CAPTCHA — unpause; the waitForResume() loop will notice.
    if (state.paused) {
      state.paused = false;
      _ping(); // immediate ping so SW doesn't die right after unpausing
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "getState") {
    sendResponse({ state: getPublicState() });
    return true;
  }

  if (msg.action === "getResults") {
    if (state.results.length > 0) {
      sendResponse({ results: state.results });
    } else {
      // SW may have been restarted — restore from session storage
      chrome.storage.session.get(["results"], (data) => {
        sendResponse({ results: data.results || [] });
      });
      return true; // async
    }
    return true;
  }

  return true;
});

function getPublicState() {
  return {
    running:     state.running,
    paused:      state.paused,
    totalLinks:  state.totalLinks,
    scraped:     state.scraped,
    failedCount: state.failedCount,
    queueLen:    state.queue.length,
    cities:      state.cities,
    currentCity: state.currentCity,
    resultsLen:  state.results.length,
  };
}

function sendState(text, dotClass) {
  chrome.runtime.sendMessage({
    action: "stateUpdate",
    text,
    dotClass,
    stats: getPublicState(),
  }).catch(() => {});
}

function log(text, level = "info") {
  chrome.runtime.sendMessage({ action: "log", text, level }).catch(() => {});
}

// ── Main entry ────────────────────────────────────────────────────────────
async function startScraping(config) {
  state = {
    ...state,
    running:     true,
    paused:      false,
    queue:       [],
    results:     [],
    seenUrls:    new Set(),
    failed:      [],
    totalLinks:  0,
    scraped:     0,
    failedCount: 0,
    config,
    cities: config.cities,
  };

  startKeepalive(); // ← keep SW alive for the entire run

  const tab = await chrome.tabs.create({ url: "https://www.zillow.com", active: true });
  state.tabId = tab.id;
  await sleep(2500);

  for (const city of config.cities) {
    if (!state.running) break;
    state.currentCity = city;
    log(`Starting city: ${city}`, "info");
    sendState(`Scanning: ${city}`, "running");

    // ── Phase 1: collect profile links ────────────────────────────────
    const slug = city.toLowerCase().replace(/, /g, "-").replace(/ /g, "-");
    const links = [];

    for (let page = 1; page <= config.maxPages; page++) {
      if (!state.running) break;
      const url = `https://www.zillow.com/professionals/real-estate-agent-reviews/${slug}/?page=${page}`;
      log(`List page ${page}/${config.maxPages}: ${url}`, "info");

      const pageLinks = await fetchPageLinks(url);
      if (pageLinks === null) {
        log("List page blocked — solve CAPTCHA then click Continue", "warn");
        sendCaptchaAlert(`List page blocked for ${city}, page ${page}. Solve the CAPTCHA in the Zillow tab then click Continue.`);
        await waitForResume();
        if (!state.running) break;
        const retry = await fetchPageLinks(url);
        if (retry) {
          retry.forEach(l => {
            if (!links.includes(l) && !state.seenUrls.has(l)) links.push(l);
          });
        }
      } else {
        pageLinks.forEach(l => {
          if (!links.includes(l) && !state.seenUrls.has(l)) links.push(l);
        });
      }

      if (links.length >= config.maxAgents) break;
      await sleep(config.delay * 1000);
    }

    const cityLinks = links.slice(0, config.maxAgents);
    cityLinks.forEach(l => state.seenUrls.add(l));
    state.totalLinks += cityLinks.length;
    log(`Found ${cityLinks.length} profiles in ${city}`, "ok");
    sendState(`Scraping ${cityLinks.length} profiles in ${city}...`, "running");

    // ── Phase 2: scrape each profile ──────────────────────────────────
    for (const profileUrl of cityLinks) {
      if (!state.running) break;

      log(`Profile: ${profileUrl}`, "info");
      const data = await fetchProfile(profileUrl);

      if (data === null) {
        log("Profile blocked — solve CAPTCHA then click Continue", "warn");
        sendCaptchaAlert(`Blocked on: ${profileUrl}\nSolve the CAPTCHA in the Zillow tab then click Continue.`);
        await waitForResume();
        if (!state.running) break;
        const retry = await fetchProfile(profileUrl);
        if (retry) {
          if (isLeadWorthy(retry)) {
            state.results.push(retry);
            state.scraped++;
            log(`✓ Retry ok: ${retry.name || profileUrl}`, "ok");
          } else {
            state.failedCount++;
            log(`⊘ Retry skipped (missing addresses): ${retry.name || profileUrl}`, "warn");
          }
        } else {
          state.failed.push(profileUrl);
          state.failedCount++;
          log(`✗ Retry failed, skipping`, "error");
        }
      } else {
        if (isLeadWorthy(data)) {
          state.results.push(data);
          state.scraped++;
          log(`✓ ${data.name || profileUrl}`, "ok");
        } else {
          state.failedCount++;
          log(`⊘ Skipped (missing addresses): ${data.name || profileUrl}`, "warn");
        }
      }

      await persistResults(); // ← save after every profile
      sendState(`${state.scraped} scraped, ${state.failedCount} failed`, "running");
      await sleep(config.delay * 1000);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────
  state.running = false;
  stopKeepalive();

  if (state.tabId) {
    chrome.tabs.remove(state.tabId).catch(() => {});
    state.tabId = null;
  }

  await persistResults();
  const doneMsg = `Done! ${state.scraped} agents from ${state.cities.length} cities.`;
  log(doneMsg, "ok");
  sendState(doneMsg, "done");
  chrome.runtime.sendMessage({ action: "done", resultsLen: state.results.length }).catch(() => {});
}

// ── Navigate tab and extract links ────────────────────────────────────────
async function fetchPageLinks(url) {
  await navigateTab(url);
  await sleep(3500);
  const resp = await sendToContent({ action: "extractLinks" });
  if (!resp || resp.blocked) return null;
  return resp.links || [];
}

// ── Navigate tab and extract profile data ─────────────────────────────────
async function fetchProfile(url) {
  await navigateTab(url);
  await sleep(3500);
  const resp = await sendToContent({ action: "extractProfile" });
  if (!resp || resp.blocked) return null;
  return resp.data || null;
}

// ── Navigate the shared tab ───────────────────────────────────────────────
// Fixed: adds a 30 s timeout so orphaned listeners can't stack up;
// uses a `resolved` flag so the listener fires exactly once.
function navigateTab(url) {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(); return; }

    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    const listener = (tabId, info) => {
      if (tabId === state.tabId && info.status === "complete") done();
    };

    chrome.tabs.update(state.tabId, { url }, (tab) => {
      if (chrome.runtime.lastError || !tab) { done(); return; }
      chrome.tabs.onUpdated.addListener(listener);
      // Safety timeout — never block forever
      setTimeout(done, 30_000);
    });
  });
}

// ── Send message to content script ───────────────────────────────────────
function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(null); return; }
    chrome.tabs.sendMessage(state.tabId, msg, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp);
    });
  });
}

// ── Wait for user to click "Continue" after CAPTCHA ──────────────────────
// Fixed: uses recursive setTimeout + _ping() so the SW stays alive the whole
// time the user is interacting with the CAPTCHA page.
function waitForResume() {
  state.paused = true;
  return new Promise((resolve) => {
    const check = () => {
      _ping(); // ← Chrome API call — resets the 30 s kill timer
      if (!state.paused || !state.running) {
        resolve();
      } else {
        setTimeout(check, 2_000);
      }
    };
    setTimeout(check, 2_000);
  });
}

function sendCaptchaAlert(msg) {
  chrome.runtime.sendMessage({ action: "captchaAlert", msg }).catch(() => {});
  sendState("⚠ CAPTCHA detected — waiting for you...", "blocked");
}

// ── Lead quality gate ─────────────────────────────────────────────────────
function isLeadWorthy(data) {
  if (!data) return false;
  const forSale   = (data.for_sale_address   || "").trim().toLowerCase();
  const recentSale = (data.recent_sale_address || "").trim().toLowerCase();

  // MUST have both addresses, and they MUST be different
  if (!forSale || !recentSale) return false;
  if (forSale === recentSale) return false;

  return true;
}
