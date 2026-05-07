// background.js — service worker

let state = {
  running: false,
  paused:  false,
  tabId:   null,
  queue:   [],           // profile URLs left to scrape
  results: [],           // scraped AgentProfile objects
  seenUrls: new Set(),   // profile URLs already processed or in queue
  failed:  [],           // URLs that failed
  cities:  [],
  currentCity: null,
  totalLinks: 0,
  scraped: 0,
  failedCount: 0,
  config: {
    maxAgents: 30,
    maxPages:  2,
    delay:     4,
  },
};

// ── Messages from popup ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === "start") {
    startScraping(msg.config);
    sendResponse({ ok: true });
  }

  if (msg.action === "stop") {
    state.running = false;
    state.paused  = false;
    sendState("Stopped by user.", "idle");
    sendResponse({ ok: true });
  }

  if (msg.action === "continue") {
    // User solved CAPTCHA — reload the tab and resume
    if (state.tabId) {
      state.paused = false;
      chrome.tabs.reload(state.tabId, {}, () => {
        setTimeout(() => resumeAfterCaptcha(), 3000);
      });
    }
    sendResponse({ ok: true });
  }

  if (msg.action === "getState") {
    sendResponse({ state: getPublicState() });
  }

  if (msg.action === "getResults") {
    sendResponse({ results: state.results });
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
    action:   "stateUpdate",
    text,
    dotClass,
    stats: getPublicState(),
  }).catch(() => {});  // popup may be closed
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

  // Open a dedicated tab
  const tab = await chrome.tabs.create({ url: "https://www.zillow.com", active: true });
  state.tabId = tab.id;
  await sleep(2500);

  for (const city of config.cities) {
    if (!state.running) break;
    state.currentCity = city;
    log(`Starting city: ${city}`, "info");
    sendState(`Scanning: ${city}`, "running");

    // ── Phase 1: collect profile links for this city ──────────────────
    const slug = city.toLowerCase().replace(/, /g, "-").replace(/ /g, "-");
    const links = [];

    for (let page = 1; page <= config.maxPages; page++) {
      if (!state.running) break;
      const url = `https://www.zillow.com/professionals/real-estate-agent-reviews/${slug}/?page=${page}`;
      log(`List page ${page}/${config.maxPages}: ${url}`, "info");

      const pageLinks = await fetchPageLinks(url);
      if (pageLinks === null) {
        // blocked — wait for user
        log("List page blocked — solve CAPTCHA then click Continue", "warn");
        sendCaptchaAlert(`List page blocked for ${city}, page ${page}. Solve the CAPTCHA in the Zillow tab then click Continue.`);
        await waitForResume();
        if (!state.running) break;
        // Retry same page once
        const retry = await fetchPageLinks(url);
        if (retry) {
          retry.forEach(l => {
            if (!links.includes(l) && !state.seenUrls.has(l)) {
              links.push(l);
            }
          });
        }
      } else {
        pageLinks.forEach(l => {
          if (!links.includes(l) && !state.seenUrls.has(l)) {
            links.push(l);
          }
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
        // blocked
        log("Profile blocked — solve CAPTCHA then click Continue", "warn");
        sendCaptchaAlert(`Blocked on: ${profileUrl}\nSolve the CAPTCHA in the Zillow tab then click Continue.`);
        await waitForResume();
        if (!state.running) break;
        // retry once
        const retry = await fetchProfile(profileUrl);
        if (retry) {
          if (isLeadWorthy(retry)) {
            state.results.push(retry);
            state.scraped++;
            log(`✓ Retry ok: ${retry.name || profileUrl}`, "ok");
          } else {
            state.failedCount++;
            log(`⊘ Retry skipped (no email / valid address): ${retry.name || profileUrl}`, "warn");
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
          log(`⊘ Skipped (no email / valid address): ${data.name || profileUrl}`, "warn");
        }
      }

      sendState(`${state.scraped} scraped, ${state.failedCount} failed`, "running");
      await sleep(config.delay * 1000);
    }
  }

  // Done
  state.running = false;
  if (state.tabId) {
    chrome.tabs.remove(state.tabId).catch(() => {});
    state.tabId = null;
  }

  const msg = `Done! ${state.scraped} agents from ${state.cities.length} cities.`;
  log(msg, "ok");
  sendState(msg, "done");
  chrome.runtime.sendMessage({ action: "done", resultsLen: state.results.length }).catch(() => {});
}

// ── Navigate tab and extract links ────────────────────────────────────────
async function fetchPageLinks(url) {
  await navigateTab(url);
  await sleep(3500);

  const resp = await sendToContent({ action: "extractLinks" });
  if (!resp) return null;
  if (resp.blocked) return null;
  return resp.links || [];
}

// ── Navigate tab and extract profile data ─────────────────────────────────
async function fetchProfile(url) {
  await navigateTab(url);
  await sleep(3500);

  const resp = await sendToContent({ action: "extractProfile" });
  if (!resp) return null;
  if (resp.blocked) return null;
  return resp.data || null;
}

async function resumeAfterCaptcha() {
  const resp = await sendToContent({ action: "ping" });
  if (resp && !resp.blocked) {
    log("CAPTCHA resolved, resuming...", "ok");
    chrome.runtime.sendMessage({ action: "captchaCleared" }).catch(() => {});
  }
}

// ── Navigate the shared tab ───────────────────────────────────────────────
function navigateTab(url) {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(); return; }
    chrome.tabs.update(state.tabId, { url }, () => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === state.tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });
  });
}

// ── Send message to content script in the scrape tab ─────────────────────
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
function waitForResume() {
  state.paused = true;
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (!state.paused || !state.running) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

function sendCaptchaAlert(msg) {
  chrome.runtime.sendMessage({ action: "captchaAlert", msg }).catch(() => {});
  sendState("⚠ CAPTCHA detected — waiting for you...", "blocked");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Lead quality gate ─────────────────────────────────────────────────────
function isLeadWorthy(data) {
  if (!data) return false;

  const forSale = (data.for_sale_address || "").trim().toLowerCase();
  const recentSale = (data.recent_sale_address || "").trim().toLowerCase();

  // STRICT RULE: If both addresses exist and are identical, DO NOT scrape.
  if (forSale && recentSale && forSale === recentSale) {
    return false; 
  }

  // Ensure we have at least some usable data (an email, or at least one address)
  const hasEmail = !!data.email;
  const hasForSale = !!data.for_sale_address;
  const hasSold = !!data.recent_sale_address;

  return hasEmail || hasForSale || hasSold;
}