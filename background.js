// background.js - Home Services Scraper (V3 Fixes + Timeouts Cleared)

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

function hasContactInfo(data) {
  if (data.email) return true;
  if (data.emails && data.emails.length > 0) return true;
  return false;
}

function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim().replace(/["']+$/, '').replace(/\/+$/, '');
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
    
    const pageLinks = await fetchPageLinks(url, config.maxPages || 2);
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
  
  log('=== Phase 2: Website Contacts ===', 'info');
  sendState('Phase 2: Scraping websites...', 'running');
  
  let emailCount = 0;
  for (let i = 0; i < state.results.length; i++) {
    if (!state.running) break;
    
    const data = state.results[i];
    
    if (hasContactInfo(data)) {
      log('P2 SKIP: ' + data.name + ' already has contact', 'info');
      continue;
    }
    
    const websiteUrls = data.website_urls || [];
    const hasWebsite = data.website || websiteUrls.length > 0;
    
    if (!hasWebsite) {
      state.noContactCount++;
      log('P2 SKIP: No website for ' + data.name, 'warn');
      continue;
    }
    
    const urlsToScrape = [data.website, ...websiteUrls].filter(Boolean);
    log('P2: Scraping ' + data.name + ' from ' + urlsToScrape.length + ' URL(s)', 'info');
    sendState('Phase 2: ' + (i + 1) + '/' + state.results.length + ' - ' + data.name, 'running');
    
    const websiteData = await scrapeWebsite(data.website, websiteUrls);
    
    if (websiteData) {
      let found = false;
      const emailToSave = websiteData.email || (websiteData.emails && websiteData.emails[0]) || null;
      
      if (emailToSave) {
        data.email = emailToSave;
        data.emails = websiteData.emails || [emailToSave];
        emailCount++;
        found = true;
        log('P2: ' + data.name + ' email = ' + emailToSave, 'ok');
      } else if (websiteData.emails?.length > 0) {
        data.emails = websiteData.emails;
        found = true;
      }
      
      if (websiteData.twitter_handle && emailToSave) {
        data.twitter_handle = websiteData.twitter_handle;
        log('P2: ' + data.name + ' Twitter = ' + data.twitter_handle, 'ok');
      }
      
      if (!found) {
        state.noContactCount++;
        log('P2: No contact found for ' + data.name, 'warn');
      }
    } else {
      state.noContactCount++;
      log('P2: No contact found for ' + data.name, 'warn');
    }
    
    await persistResults();
    await sleep(config.delay * 1000);
  }

  const withContact = state.results.filter(hasContactInfo);
  const withoutContact = state.results.filter(d => !hasContactInfo(d));
  
  log('=== Results ===', 'info');
  log('With contact info: ' + withContact.length, 'ok');
  log('Without contact: ' + withoutContact.length + ' (not exported)', 'warn');
  if (emailCount > 0) log('Emails found: ' + emailCount, 'ok');
  
  state.results = withContact;
  
  state.running = false;
  stopKeepalive();
  if (state.tabId) { chrome.tabs.remove(state.tabId).catch(() => {}); state.tabId = null; }
  if (state.webTabId) { chrome.tabs.remove(state.webTabId).catch(() => {}); state.webTabId = null; }
  
  await persistResults();
  log('=== DONE! ' + withContact.length + ' leads ===', 'ok');
  sendState('Done! ' + withContact.length + ' leads', 'done');
  chrome.runtime.sendMessage({ action: 'done', resultsLen: withContact.length }).catch(() => {});
}

// ==========================================
// NEW PAGINATION LOGIC (Manifest V3)
// ==========================================
async function fetchPageLinks(url, maxPages = 2) {
  await navigateTab(url);
  await sleep(3000);
  log('Scrolling to load more results...', 'info');
  const allLinks = new Set();
  for (let i = 0; i < maxPages; i++) {
    const resp = await sendToContent({ action: 'extractLinks' });
    if (resp && !resp.blocked && resp.links) resp.links.forEach(link => allLinks.add(link));
    await scrollToLoadMore();
    await sleep(2500);
    await clickNextButton();
    await sleep(3000);
  }
  const finalResp = await sendToContent({ action: 'extractLinks' });
  if (finalResp && !finalResp.blocked && finalResp.links) finalResp.links.forEach(link => allLinks.add(link));
  return Array.from(allLinks);
}

async function scrollToLoadMore() {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(); return; }
    chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => {
        const feedContainer = document.querySelector('div[role="feed"]');
        if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;
        else {
          const scrollContainer = document.querySelector('#pane') || 
                                  document.querySelector('[role="main"]') || 
                                  document.querySelector('.Nv2PK')?.closest('.m6QErb');
          if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
          else window.scrollTo(0, document.body.scrollHeight);
        }
        const loadMoreBtns = document.querySelectorAll('button, a');
        for (const btn of loadMoreBtns) {
          const text = (btn.innerText || '').toLowerCase();
          if (text.includes('more results') || text.includes('load more') || text.includes('see more')) {
            btn.click(); break;
          }
        }
      }
    }, () => resolve());
  });
}

async function clickNextButton() {
  return new Promise((resolve) => {
    if (!state.tabId) { resolve(); return; }
    chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => {
        const nextBtn = Array.from(document.querySelectorAll('button, a')).find(el => {
          const text = (el.innerText || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return (text.includes('next') || aria.includes('next')) && 
                 !text.includes('search') && !aria.includes('search');
        });
        if (nextBtn && !nextBtn.disabled) nextBtn.click();
      }
    }, () => resolve());
  });
}

async function fetchBusiness(url) {
  await navigateTab(url);
  await sleep(6000); 
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

async function scrapeWebsite(url, allUrls = []) {
  if (!url && (!allUrls || allUrls.length === 0)) return null;
  const urlsToTry = (allUrls && allUrls.length > 0) ? allUrls : (url ? [url] : []);
  
  try {
    for (const urlToTry of urlsToTry) {
      if (!state.running) break;
      const urlToScrape = normalizeUrl(urlToTry);
      if (!urlToScrape) continue;
      
      log('P2: Scraping: ' + urlToScrape, 'info');
      await navigateWebTab(urlToScrape);
      await sleep(2000);
      
      try {
        await chrome.scripting.executeScript({ target: { tabId: state.webTabId }, files: ['content.js'] });
        await sleep(300);
      } catch (e) { }
      
      let resp = await sendToWebTab({ action: 'extractWebsiteData' });
      const hasEmail = resp && resp.data && (resp.data.email || (resp.data.emails && resp.data.emails.length > 0));
      if (hasEmail) return resp.data;
      
      if (resp && resp.data) {
        let baseUrl;
        try {
          const urlObj = new URL(urlToScrape);
          baseUrl = urlObj.origin;
        } catch (e) {
          baseUrl = urlToScrape.replace(/\/[^\/]*$/, '').replace(/\?.*$/, '');
        }
        
        const contactPages = ['/contact', '/contact-us', '/about', '/about-us'];
        for (const p of contactPages) {
          if (!state.running) break;
          await navigateWebTab(baseUrl + p);
          await sleep(1500);
          try {
            await chrome.scripting.executeScript({ target: { tabId: state.webTabId }, files: ['content.js'] });
            await sleep(300);
          } catch (e) {}
          
          resp = await sendToWebTab({ action: 'extractWebsiteData' });
          const contactHasEmail = resp && resp.data && (resp.data.email || (resp.data.emails && resp.data.emails.length > 0));
          if (contactHasEmail) return resp.data;
        }
      }
    }
    return null;
  } catch (e) { return null; }
}

let webTabTimeoutTimer = null;

function navigateWebTab(url) {
  return new Promise((resolve) => {
    if (!state.webTabId) { resolve(); return; }
    
    // Clear any existing timer to prevent overlapping timeouts
    if (webTabTimeoutTimer) {
      clearTimeout(webTabTimeoutTimer);
      webTabTimeoutTimer = null;
    }

    let resolved = false;
    const listener = (tabId, info) => { 
      if (tabId === state.webTabId && info.status === 'complete') done(); 
    };

    const done = () => { 
      if (!resolved) { 
        resolved = true; 
        chrome.tabs.onUpdated.removeListener(listener); 
        if (webTabTimeoutTimer) {
            clearTimeout(webTabTimeoutTimer);
            webTabTimeoutTimer = null;
        }
        resolve(); 
      } 
    };
    
    chrome.tabs.update(state.webTabId, { url }, (tab) => {
      if (chrome.runtime.lastError || !tab) { done(); return; }
      chrome.tabs.onUpdated.addListener(listener);
      // Fixed 15 sec timeout for P2 is better than 45s to speed things up
      webTabTimeoutTimer = setTimeout(done, 15000);
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
