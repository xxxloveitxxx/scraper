// background.js - Home Services Scraper with 2-Phase scraping

let _keepaliveTimer = null;
let popupWindowId = null;

function _ping() { chrome.storage.session.set({ _ka: Date.now() }).catch(() => {}); }
function startKeepalive() { _ping(); if (!_keepaliveTimer) _keepaliveTimer = setInterval(_ping, 20000); }
function stopKeepalive() { if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; } }

async function sleep(ms) {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(20000, remaining);
    await new Promise(r => setTimeout(r, chunk));
    _ping();
    remaining -= chunk;
  }
}

let state = {
  running: false, tabId: null, webTabId: null,
  results: [], seenUrls: new Set(),
  cities: [], totalLinks: 0, scraped: 0, failedCount: 0, noContactCount: 0,
  config: { maxBusinesses: 30, delay: 4 },
};

async function persistResults() {
  try {
    await chrome.storage.session.set({
      results: state.results, scraped: state.scraped,
      failedCount: state.failedCount, totalLinks: state.totalLinks,
      noContactCount: state.noContactCount,
    });
  } catch (e) {}
}

chrome.action.onClicked.addListener(async () => {
  const popupUrl = chrome.runtime.getURL('popup.html');
  const windows = await chrome.windows.getAll({ populate: true });
  const existing = windows.find(win => win.tabs && win.tabs.some(tab => tab.url === popupUrl));
  if (existing) {
    popupWindowId = existing.id;
    chrome.windows.update(popupWindowId, { focused: true });
  } else {
    chrome.windows.create({ url: popupUrl, type: 'popup', width: 420, height: 700 }, (win) => {
      if (win) popupWindowId = win.id;
    });
  }
});

chrome.windows.onRemoved.addListener((windowId) => { if (windowId === popupWindowId) popupWindowId = null; });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') { startScraping(msg.config); sendResponse({ ok: true }); return true; }
  if (msg.action === 'stop') { state.running = false; stopKeepalive(); sendState('Stopped.', 'idle'); sendResponse({ ok: true }); return true; }
  if (msg.action === 'getState') { sendResponse({ state: getPublicState() }); return true; }
  if (msg.action === 'getResults') { sendResponse({ results: state.results }); return true; }
  return true;
});

function getPublicState() {
  return { running: state.running, totalLinks: state.totalLinks, scraped: state.scraped, failedCount: state.failedCount, noContactCount: state.noContactCount, cities: state.cities, resultsLen: state.results.length };
}

function sendState(text, dotClass) { chrome.runtime.sendMessage({ action: 'stateUpdate', text, dotClass, stats: getPublicState() }).catch(() => {}); }
function log(text, level) { chrome.runtime.sendMessage({ action: 'log', text, level }).catch(() => {}); }

// Check if business has contact info (email or social)
function hasContactInfo(data) {
  if (data.email) return true;
  if (data.emails && data.emails.length > 0) return true;
  if (data.social_links && data.social_links.length > 0) return true;
  if (data.twitter_handle) return true;
  return false;
}

// Normalize URL
function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  url = url.replace(/["']+$/, '');
  url = url.replace(/\/+$/, '');
  if (url.includes('google.com/url')) {
    try {
      const match = url.match(/url=([^&]+)/);
      if (match) url = decodeURIComponent(match[1]);
    } catch (e) {}
  }
  try { url = decodeURIComponent(url); } catch (e) {}
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

async function startScraping(config) {
  state = { ...state, running: true, results: [], seenUrls: new Set(), totalLinks: 0, scraped: 0, failedCount: 0, noContactCount: 0, config, cities: config.cities };
  startKeepalive();
  
  log('=== Phase 1: Google Maps ===', 'info');
  sendState('Phase 1: Scraping Google Maps...', 'running');
  
  const tab = await chrome.tabs.create({ url: 'https://www.google.com/maps', active: true });
  state.tabId = tab.id;
  const webTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  state.webTabId = webTab.id;
  
  await sleep(3000);

  for (const city of config.cities) {
    if (!state.running) break;
    
    log('Searching: home services in ' + city, 'info');
    sendState('Phase 1: ' + city, 'running');
    
    const searchQuery = encodeURIComponent('home services in ' + city);
    const url = 'https://www.google.com/maps/search/' + searchQuery;
    
    const pageLinks = await fetchPageLinks(url);
    log('Found ' + (pageLinks?.length || 0) + ' business links', 'info');
    
    if (!pageLinks || pageLinks.length === 0) continue;
    
    const cityLinks = pageLinks.slice(0, config.maxBusinesses);
    state.totalLinks += cityLinks.length;
    
    for (const profileUrl of cityLinks) {
      if (!state.running) break;
      
      const data = await fetchBusiness(profileUrl);
      
      if (data && data.name) {
        if (data.website) data.website = normalizeUrl(data.website);
        state.results.push(data);
        state.scraped++;
        const webStatus = data.website ? ' [' + data.website + ']' : ' [no website]';
        log('P1 OK: ' + data.name + webStatus, 'ok');
      } else {
        state.failedCount++;
        log('P1 FAIL: ' + profileUrl, 'warn');
      }
      
      await persistResults();
      sendState('Phase 1: ' + state.scraped + ' businesses', 'running');
      await sleep(config.delay * 1000);
    }
  }

  log('Phase 1 done: ' + state.scraped + ' businesses', 'ok');
  sendState('Phase 1: ' + state.scraped + ' collected', 'running');
  
  // PHASE 2: Website emails & social
  log('=== Phase 2: Website Contacts ===', 'info');
  sendState('Phase 2: Scraping websites...', 'running');
  
  let emailCount = 0;
  for (let i = 0; i < state.results.length; i++) {
    if (!state.running) break;
    
    const data = state.results[i];
    
    // Skip if already has contact info
    if (hasContactInfo(data)) {
      log('P2 SKIP: ' + data.name + ' already has contact', 'info');
      continue;
    }
    
    if (!data.website) {
      state.noContactCount++;
      log('P2 SKIP: No website for ' + data.name, 'warn');
      continue;
    }
    
    log('P2: Scraping ' + data.website, 'info');
    sendState('Phase 2: ' + (i + 1) + '/' + state.results.length + ' - ' + data.name, 'running');
    
    const websiteData = await scrapeWebsite(data.website);
    
    if (websiteData) {
      let found = false;
      if (websiteData.email) {
        data.email = websiteData.email;
        emailCount++;
        found = true;
        log('P2: ' + data.name + ' email = ' + data.email, 'ok');
      }
      if (websiteData.emails?.length > 0) {
        data.emails = websiteData.emails;
        found = true;
      }
      if (websiteData.social_links?.length > 0) {
        data.social_links = websiteData.social_links;
        found = true;
      }
      if (websiteData.twitter_handle) {
        data.twitter_handle = websiteData.twitter_handle;
        found = true;
        log('P2: ' + data.name + ' Twitter = ' + data.twitter_handle, 'ok');
      }
      if (!found) {
        state.noContactCount++;
        log('P2: No contact at ' + data.website, 'warn');
      }
    } else {
      state.noContactCount++;
      log('P2: Failed to load ' + data.website, 'warn');
    }
    
    await persistResults();
    await sleep(config.delay * 1000);
  }

  // Filter out businesses without contact info
  const withContact = state.results.filter(hasContactInfo);
  const withoutContact = state.results.filter(d => !hasContactInfo(d));
  
  log('=== Results ===', 'info');
  log('With contact info: ' + withContact.length, 'ok');
  log('Without contact: ' + withoutContact.length + ' (not exported)', 'warn');
  if (emailCount > 0) log('Emails found: ' + emailCount, 'ok');
  
  // Only keep businesses with contact info
  state.results = withContact;
  
  state.running = false;
  stopKeepalive();
  if (state.tabId) { chrome.tabs.remove(state.tabId).catch(() => {}); state.tabId = null; }
  if (state.webTabId) { chrome.tabs.remove(state.webTabId).catch(() => {}); state.webTabId = null; }
  
  await persistResults();
  log('=== DONE! ' + withContact.length + ' leads with contact info ===', 'ok');
  sendState('Done! ' + withContact.length + ' leads (skipped ' + withoutContact.length + ' without contact)', 'done');
  chrome.runtime.sendMessage({ action: 'done', resultsLen: withContact.length }).catch(() => {});
}

async function fetchPageLinks(url) {
  await navigateTab(url);
  await sleep(5000);
  const resp = await sendToContent({ action: 'extractLinks' });
  return (resp && !resp.blocked) ? resp.links || [] : null;
}

async function fetchBusiness(url) {
  await navigateTab(url);
  await sleep(4000);
  const resp = await sendToContent({ action: 'extractProfile' });
  return (resp && !resp.blocked) ? resp.data || null : null;
}

function navigateTab(url) {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(); return; }
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (tabId, info) => { if (tabId === state.tabId && info.status === 'complete') done(); };
    chrome.tabs.update(state.tabId, { url }, (tab) => {
      if (chrome.runtime.lastError || !tab) { done(); return; }
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 30000);
    });
  });
}

function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(null); return; }
    chrome.tabs.sendMessage(state.tabId, msg, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp);
    });
  });
}

async function scrapeWebsite(url) {
  if (!url || !state.webTabId) return null;
  try {
    url = normalizeUrl(url);
    
    // Try main page
    await navigateWebTab(url);
    await sleep(5000);
    let resp = await sendToWebTab({ action: 'extractWebsiteData' });
    if (resp && resp.data) return resp.data;
    
    // Try contact pages
    const pages = ['/contact', '/contact-us', '/about', '/about-us', '/contact.html', '/contact.php'];
    for (const p of pages) {
      await navigateWebTab(url + p);
      await sleep(4000);
      resp = await sendToWebTab({ action: 'extractWebsiteData' });
      if (resp && resp.data && (resp.data.email || resp.data.social_links?.length > 0)) {
        return resp.data;
      }
    }
    return null;
  } catch (e) { return null; }
}

function navigateWebTab(url) {
  return new Promise((resolve) => {
    if (!state.webTabId) { resolve(); return; }
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (tabId, info) => { if (tabId === state.webTabId && info.status === 'complete') done(); };
    chrome.tabs.update(state.webTabId, { url }, (tab) => {
      if (chrome.runtime.lastError || !tab) { done(); return; }
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 30000);
    });
  });
}

function sendToWebTab(msg) {
  return new Promise((resolve) => {
    if (!state.webTabId) { resolve(null); return; }
    chrome.tabs.sendMessage(state.webTabId, msg, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp);
    });
  });
}