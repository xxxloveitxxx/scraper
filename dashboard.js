const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const leadCountEl = document.getElementById('leadCount');

function log(msg) {
  logEl.innerHTML += `> ${msg}<br>`;
  logEl.scrollTop = logEl.scrollHeight;
}

function updateLeadCount() {
  chrome.storage.local.get(['leads'], (data) => {
    const count = data.leads ? data.leads.length : 0;
    leadCountEl.textContent = `${count} leads collected`;
  });
}

// Initialize
updateLeadCount();

document.getElementById('startBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: "START_PHASE_1" }, (response) => {
    if (response && response.status === 'started') {
      document.getElementById('startBtn').style.display = 'none';
      log("Phase 1 started: Searching for companies...");
    } else {
      log("Error: Could not start scraping");
    }
  });
});

document.getElementById('resumeBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: "RESUME" }, (response) => {
    if (response && response.status === 'resumed') {
      document.getElementById('resumeBtn').style.display = 'none';
      log("Resuming execution...");
    }
  });
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await new Promise(resolve => {
    chrome.storage.local.get(["leads"], resolve);
  });
  const leads = data.leads || [];
  if (leads.length === 0) {
    alert("No data to export!");
    return;
  }

  const headers = Object.keys(leads[0]).join(",");
  const rows = leads.map(lead => Object.values(lead).join(",")).join("\n");
  const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(headers + "\n" + rows);
  
  const link = document.createElement("a");
  link.setAttribute("href", csvContent);
  link.setAttribute("download", "replyze_leads.csv");
  document.body.appendChild(link);
  link.click();
  log(`Exported ${leads.length} leads to CSV`);
});

document.getElementById('clearBtn').addEventListener('click', () => {
  chrome.storage.local.set({ leads: [], currentIndex: 0 }, () => {
    log("Data cleared.");
    statusEl.innerText = "IDLE";
    updateLeadCount();
  });
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "UPDATE_STATUS") {
    statusEl.innerText = msg.status;
    log(msg.message);
    if (msg.status === "PAUSED_BOT_DETECTION") {
      document.getElementById('resumeBtn').style.display = 'block';
    }
    if (msg.status === "SCRAPING") {
      updateLeadCount();
    }
    if (msg.status === "COMPLETE") {
      updateLeadCount();
      document.getElementById('startBtn').style.display = 'block';
    }
  }
  if (msg.action === "LEAD_COLLECTED") {
    updateLeadCount();
    log(`Lead collected: ${msg.name || 'Unknown'}`);
  }
  sendResponse({ received: true });
  return true;
});