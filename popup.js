document.getElementById('openDash').addEventListener('click', () => {
  // Open dashboard using chrome.runtime.getURL for proper extension path resolution
  const dashUrl = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.create({ url: dashUrl });
});

document.getElementById('quickScrape').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: "START_PHASE_1" }, (response) => {
    const status = document.getElementById('quickStatus');
    if (response && response.status === 'started') {
      status.textContent = "Scraping started!";
      status.style.color = "#c8a96e";
    } else {
      status.textContent = "Error starting scrape";
      status.style.color = "#e05252";
    }
    setTimeout(() => { status.textContent = ""; }, 2000);
  });
});

// Show lead count on load
chrome.storage.local.get(['leads'], (data) => {
  const count = data.leads ? data.leads.length : 0;
  document.getElementById('leadCount').textContent = count > 0 ? `${count} leads` : "No leads yet";
});