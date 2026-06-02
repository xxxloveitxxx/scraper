// popup.js - Home Services Lead Scraper

const $ = id => document.getElementById(id);

// ── UI refs ───────────────────────────────────────────────────────────────
const btnStart    = $("btn-start");
const btnStop     = $("btn-stop");
const btnExport   = $("btn-export");
const btnContinue = $("btn-continue");
const statusDot   = $("status-dot");
const statusText  = $("status-text");
const progressBar = $("progress-bar");
const captchaBox  = $("captcha-alert");
const captchaMsg  = $("captcha-msg");
const logEl       = $("log");

// Stats
const statCities  = $("stat-cities");
const statLinks   = $("stat-links");
const statScraped = $("stat-scraped");
const statFailed  = $("stat-failed");

// ── Load saved config ─────────────────────────────────────────────────────
chrome.storage.local.get(["cities", "maxBusinesses", "maxPages", "delay"], (data) => {
  if (data.cities)         $("cities").value         = data.cities;
  if (data.maxBusinesses)  $("maxBusinesses").value  = data.maxBusinesses;
  if (data.maxPages)       $("maxPages").value        = data.maxPages;
  if (data.delay)          $("delay").value           = data.delay;
});

// ── Sync state from background on open ───────────────────────────────────
chrome.runtime.sendMessage({ action: "getState" }, (resp) => {
  if (resp?.state) applyState(resp.state);
});

// ── Start ─────────────────────────────────────────────────────────────────
btnStart.addEventListener("click", () => {
  const citiesRaw = $("cities").value.trim();
  if (!citiesRaw) { addLog("Enter at least one city.", "error"); return; }

  const cities = citiesRaw
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const config = {
    cities,
    maxBusinesses: parseInt($("maxBusinesses").value) || 30,
    maxPages:      parseInt($("maxPages").value)     || 2,
    delay:         parseInt($("delay").value)          || 4,
  };

  // Save config
  chrome.storage.local.set({
    cities:         $("cities").value,
    maxBusinesses:   config.maxBusinesses,
    maxPages:        config.maxPages,
    delay:           config.delay,
  });

  setUI("running");
  captchaBox.style.display = "none";
  clearLog();
  addLog(`Starting ${cities.length} cities...`, "info");

  chrome.runtime.sendMessage({ action: "start", config });
});

// ── Stop ──────────────────────────────────────────────────────────────────
btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop" });
  setUI("idle");
  captchaBox.style.display = "none";
  addLog("Stopping...", "warn");
});

// ── Continue after CAPTCHA ────────────────────────────────────────────────
btnContinue.addEventListener("click", () => {
  captchaBox.style.display = "none";
  chrome.runtime.sendMessage({ action: "continue" });
  addLog("Resuming after CAPTCHA...", "info");
  setDot("running");
  statusText.textContent = "Resuming...";
});

// ── Export CSV ────────────────────────────────────────────────────────────
btnExport.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "getResults" }, (resp) => {
    if (!resp?.results?.length) {
      addLog("No results to export.", "error");
      return;
    }
    downloadCSV(resp.results);
    addLog(`Exported ${resp.results.length} businesses to CSV.`, "ok");
  });
});

// ── Listen for messages from background ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {

  if (msg.action === "stateUpdate") {
    statusText.textContent = msg.text;
    setDot(msg.dotClass);
    if (msg.stats) updateStats(msg.stats);
  }

  if (msg.action === "log") {
    addLog(msg.text, msg.level);
  }

  if (msg.action === "captchaAlert") {
    captchaMsg.textContent = msg.msg;
    captchaBox.style.display = "block";
    setDot("blocked");
  }

  if (msg.action === "captchaCleared") {
    captchaBox.style.display = "none";
    setDot("running");
  }

  if (msg.action === "done") {
    setUI("done");
    if (msg.resultsLen > 0) btnExport.disabled = false;
    captchaBox.style.display = "none";
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

function setUI(mode) {
  if (mode === "running") {
    btnStart.disabled  = true;
    btnStop.disabled   = false;
    btnExport.disabled = true;
    setDot("running");
    statusText.textContent = "Running...";
  } else if (mode === "done") {
    btnStart.disabled  = false;
    btnStop.disabled   = true;
    setDot("done");
    statusText.textContent = "Done!";
  } else {
    btnStart.disabled  = false;
    btnStop.disabled   = true;
    setDot("idle");
    statusText.textContent = "Ready";
  }
}

function applyState(s) {
  if (s.running && !s.paused) setUI("running");
  else if (!s.running && s.resultsLen > 0) {
    setUI("done");
    btnExport.disabled = false;
  }
  updateStats(s);
}

function updateStats(s) {
  statCities.textContent  = s.cities?.length || 0;
  statLinks.textContent   = s.totalLinks     || 0;
  statScraped.textContent = s.scraped        || 0;
  statFailed.textContent  = s.failedCount    || 0;

  const total = s.totalLinks || 0;
  const done  = (s.scraped || 0) + (s.failedCount || 0);
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + "%";
}

function setDot(cls) {
  statusDot.className = "status-dot " + cls;
}

function addLog(text, level = "info") {
  const line = document.createElement("div");
  line.className = "log-" + level;
  const time = new Date().toLocaleTimeString("en", { hour12: false });
  line.textContent = "[" + time + "] " + text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // Keep last 200 lines
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

function clearLog() {
  logEl.innerHTML = "";
}

// ── CSV Export ────────────────────────────────────────────────────────────
function downloadCSV(businesses) {
  // Only export businesses that have an email address
  const businessesWithEmail = businesses.filter(b => b.email || (b.emails && b.emails.length > 0));
  
  if (businessesWithEmail.length === 0) {
    addLog("No leads with email to export.", "warn");
    return;
  }
  
  const fields = [
    "name", "category", "rating", "review_count", "address", "phone",
    "email", "twitter_handle", "website", "services", "about", "hours",
    "service_area", "owner", "years_in_business",
    "profile_url", "scraped_at",
  ];

  const escape = v => {
    if (v === null || v === undefined) return "";
    const str = Array.isArray(v) ? v.join(" | ") : String(v);
    return "\"" + str.replace(/"/g, "\"\"") + "\"";
  };

  const header = fields.join(",");
  const rows = businessesWithEmail.map(b => {
    // Use first email as primary, twitter only if email exists
    const primaryEmail = b.email || (b.emails && b.emails[0]) || "";
    
    return fields.map(f => {
      if (f === "email") return escape(primaryEmail);
      if (f === "twitter_handle") return escape(b.twitter_handle || "");
      return escape(b[f]);
    }).join(",");
  });

  const csv = [header, ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);

  const ts   = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  chrome.downloads.download({
    url,
    filename: "home_services_leads_" + ts + ".csv",
    saveAs: false,
  });
  
  addLog("Exported " + businessesWithEmail.length + " leads (email only) to CSV.", "ok");
}
