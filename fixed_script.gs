//  LEAD CLEANER + SCORER  —  Google Apps Script  v7.1 (FIXED)
//
//  ✅ Supports TWO sheet layouts — auto-detected from header row:
//
//  LAYOUT A — "Original":
//    A: name          B: city          D: openHouse     F: lastSale
//    H: lastSaleDate  I: brokerage     J: email         L: yearsExp
//    M: workNumber    O: personalNum   Q: teamSolo      R: last12Sales
//    S: teamMembers   T: activeListings U: reviews       V: verifyStatus
//
//  LAYOUT B — "CSV" (scraped Zillow):
//    A: name          B: profile_url   C: location      D: brokerage
//    E: rating        F: review_count  G: years_exp     H: recent_sales
//    I: for_sale_count J: for_sale_addr K: recent_sale_addr L: phone
//    M: email         N: specialties   O: languages     P: about
//    Q: scraped_at
//
//  Detection: if header row contains "profile_url" → Layout B, else → Layout A
//
//  FILTER RULES (both layouts):
//    Active Listings : 1–7      Sales: 3+
//    Email / Name / City+Location / Brokerage
//
//  SCORING:
//    Layout A → Sales 35 | Listings 25 | TeamSize 20 | YearsExp 10 | 40+reviews +10
//    Layout B → Sales 35 | Listings 25 | Rating   20 | YearsExp 10 | 40+reviews +10
//
//  v7.1 CHANGES:
//    • FIXED QuickEmailVerification URL (removed double ? error)
//    • FIXED QuickEmailVerification parameter name (key → apikey)
//    • FIXED QuickEmailVerification credit check (uses sandbox header instead of non-existent quota endpoint)
//    • IMPROVED QuickEmailVerification risk detection (added accept_all & safe_to_send checks)
// ============================================================


// ─────────────────────────────────────────────
//  API CONFIG
//  Add as many keys as you have for each provider.
//  The script will check credits upfront, skip zero-credit tokens,
//  then exhaust each key before rotating to the next.
// ─────────────────────────────────────────────
const EMAIL_VERIFY_CONFIG = {
  myemailverifier: {
    keys: [
      'f7IwAQBrGFHt1KOx',   // token 1
      // 'YOUR_KEY_2',        // token 2 — uncomment and paste
      // 'YOUR_KEY_3',        // token 3
    ],
    url:          'https://api.myemailverifier.com/api/validate_single.php',
    creditsUrl:   'https://client.myemailverifier.com/verifier/getcredits/', // key appended as path segment
    rateLimit:    30,  // requests per 60-second window per token
    fields: { status:'Status', disposable:'Disposable_Domain', role:'Role_Based', free:'Free_Domain', diagnosis:'Diagnosis' }
  },
  emailverifyio: {
    keys: [
      '7edbb5f1abac7c149a848e76581b090b4a27a3c2a30494b026e0014ed15f',  // token 1
      // 'YOUR_KEY_2',        // token 2 — uncomment and paste
      // 'YOUR_KEY_3',        // token 3
    ],
    url:          'https://api.quickemailverification.com/v1/verify',
    sandboxUrl:   'https://api.quickemailverification.com/v1/verify/sandbox',
    rateLimit:    60,  // requests per 60-second window per token
    fields: { status:'result', disposable:'disposable', role:'role', accept_all:'accept_all', safe_to_send:'safe_to_send' }
  },
  fallbackToRegex: true,   // used by clean/score passes — NOT by verifyEmailsViaApi
  cacheTtlHours:   24
};

let SKIP_API_IN_CLEAN_SCORE = false;


// ─────────────────────────────────────────────
//  COLUMN MAPS  (0-indexed)
// ─────────────────────────────────────────────

// Layout A — Original spreadsheet
const COLS_A = {
  name:           0,   // A
  city:           1,   // B
  openHouse:      3,   // D
  lastSale:       5,   // F
  lastSaleDate:   7,   // H
  brokerage:      8,   // I
  email:          9,   // J
  yearsExp:       11,  // L
  workNumber:     12,  // M
  personalNum:    14,  // O
  teamSolo:       16,  // Q
  last12Sales:    17,  // R
  teamMembers:    18,  // S
  activeListings: 19,  // T
  reviews:        20,  // U
  verifyStatus:   21,  // V
};

// Layout B — Scraped CSV (Zillow)
const COLS_B = {
  name:           0,   // A
  profileUrl:     1,   // B
  location:       2,   // C  ← city equivalent
  brokerage:      3,   // D
  rating:         4,   // E
  reviewCount:    5,   // F
  yearsExp:       6,   // G
  recentSales:    7,   // H  ← last12Sales equivalent
  forSaleCount:   8,   // I  ← activeListings equivalent
  forSaleAddr:    9,   // J
  recentSaleAddr: 10,  // K
  phone:          11,  // L
  email:          12,  // M
  specialties:    13,  // N
  languages:      14,  // O
  about:          15,  // P
  scrapedAt:      16,  // Q
  verifyStatus:   17,  // R  — appended by script
};


// ─────────────────────────────────────────────
//  FILTER THRESHOLDS  (shared)
// ─────────────────────────────────────────────
const MIN_ACTIVE_LISTINGS = 1;
const MAX_ACTIVE_LISTINGS = 7;
const MIN_SALES           = 3;
const MAX_SALES           = 9999;


// ─────────────────────────────────────────────
//  VERIFIER STATE
//
//  counters     — per-token request counts; reset every 60 seconds
//  activeKeyIdx — which token index is currently active per provider
//  zeroCredits  — per-token boolean; set at run start if credits = 0,
//                 NEVER reset during the run (permanent skip)
//  lastReset    — epoch ms of last counter reset
//  cache        — in-memory Map keyed by lowercase email
// ─────────────────────────────────────────────
const verifyState = {
  counters:     { myemailverifier: [], emailverifyio: [] },
  activeKeyIdx: { myemailverifier: 0,  emailverifyio: 0  },
  zeroCredits:  { myemailverifier: [], emailverifyio: [] },
  lastReset:    Date.now(),
  cache:        new Map()
};

/** Resets rate-limit counters every 60 s. Does NOT touch zeroCredits. */
function maybeResetCounters_() {
  if (Date.now() - verifyState.lastReset > 60000) {
    verifyState.counters     = { myemailverifier: [], emailverifyio: [] };
    verifyState.activeKeyIdx = { myemailverifier: 0,  emailverifyio: 0  };
    // ⚠️  zeroCredits intentionally NOT reset — zero-credit tokens stay
    //     skipped for the entire run regardless of counter resets.
    verifyState.lastReset = Date.now();
  }
}

/** Lazy-initialises the per-token counter array to the correct length. */
function ensureCounters_(provider, keyCount) {
  if (verifyState.counters[provider].length !== keyCount) {
    verifyState.counters[provider] = new Array(keyCount).fill(0);
  }
}


// ─────────────────────────────────────────────
//  CREDIT CHECK HELPERS
// ─────────────────────────────────────────────

/**
 * Fetches the remaining credit balance for a single token.
 * Returns { credits: <number|null>, raw: <string>, error: <string|null> }
 *
 * MyEmailVerifier  → GET https://client.myemailverifier.com/verifier/getcredits/API_KEY
 *                    Response: plain number  OR  JSON with a credits/balance field
 *
 * QuickEmailVerification → GET https://api.quickemailverification.com/v1/verify/sandbox?email=test@example.com&apikey=KEY
 *                    Response: Header 'X-QEV-Remaining-Credits' contains balance.
 */
function fetchTokenCredits_(provider, key) {
  try {
    let url;
    if (provider === 'myemailverifier') {
      url = `${EMAIL_VERIFY_CONFIG.myemailverifier.creditsUrl}${encodeURIComponent(key)}`;
    } else {
      // QuickEmailVerification: use sandbox endpoint to get credits from headers without wasting credits
      url = `${EMAIL_VERIFY_CONFIG.emailverifyio.sandboxUrl}?apikey=${encodeURIComponent(key)}&email=credits-check@example.com`;
    }

    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const code = resp.getResponseCode();
    const text = resp.getContentText().trim();

    if (code === 401 || code === 403) return { credits: null, raw: text, error: `Auth failed (${code})` };
    if (code === 402)                 return { credits: 0,    raw: text, error: null };
    if (code !== 200)                 return { credits: null, raw: text, error: `HTTP ${code}` };

    // QuickEmailVerification: credits are in headers
    if (provider === 'emailverifyio') {
      const headers = resp.getAllHeaders();
      const credits = headers['X-QEV-Remaining-Credits'] || headers['x-qev-remaining-credits'];
      if (credits !== undefined) {
        const n = parseInt(credits, 10);
        return { credits: isNaN(n) ? null : n, raw: `Header: ${credits}`, error: null };
      }
    }

    // ── Try JSON ──
    try {
      const json = JSON.parse(text);
      // MyEmailVerifier or QuickEmailVerification JSON fields (if any)
      for (const field of ['credits', 'balance', 'remaining', 'quota_remaining', 'quota']) {
        if (json[field] !== undefined) {
          const n = parseInt(json[field], 10);
          return { credits: isNaN(n) ? null : n, raw: text, error: null };
        }
      }
      // Fallback: first integer found anywhere in the JSON string
      const m = text.match(/\d+/);
      return { credits: m ? parseInt(m[0], 10) : null, raw: text, error: null };
    } catch (_) {
      // ── Plain text (e.g. MyEmailVerifier returns "1500") ──
      const n = parseInt(text.replace(/[^0-9]/g, ''), 10);
      return { credits: isNaN(n) ? null : n, raw: text, error: null };
    }
  } catch (e) {
    return { credits: null, raw: '', error: e.message };
  }
}

/**
 * Checks credits for every token on every provider before the run starts.
 * Marks tokens with 0 credits in verifyState.zeroCredits (permanent skip).
 * Returns a human-readable summary string and a boolean indicating whether
 * at least one usable token exists.
 */
function checkAllCreditsBeforeRun_() {
  const lines    = [];
  let usableCount = 0;

  for (const provider of ['myemailverifier', 'emailverifyio']) {
    const keys = (EMAIL_VERIFY_CONFIG[provider].keys || []).filter(k => k && k.toString().trim().length > 4);
    // Initialise zeroCredits array for this provider
    verifyState.zeroCredits[provider] = new Array(keys.length).fill(false);

    if (keys.length === 0) {
      lines.push(`\n${provider}:\n  ⚠️  No keys configured`);
      continue;
    }

    lines.push(`\n${provider}:`);

    for (let idx = 0; idx < keys.length; idx++) {
      const result   = fetchTokenCredits_(provider, keys[idx]);
      const keyLabel = `  Token [${idx}]`;

      if (result.error) {
        lines.push(`${keyLabel}: ⚠️  Credit check failed — ${result.error}`);
        // Treat as usable; let the actual API call decide
        usableCount++;

      } else if (result.credits === null) {
        lines.push(`${keyLabel}: ❓ Could not parse credits (raw: "${(result.raw || '').substring(0, 60)}")`);
        usableCount++;  // assume usable if we can't parse

      } else if (result.credits === 0) {
        verifyState.zeroCredits[provider][idx] = true;
        lines.push(`${keyLabel}: ❌ 0 credits — will be SKIPPED`);

      } else {
        lines.push(`${keyLabel}: ✅ ${result.credits.toLocaleString()} credits remaining`);
        usableCount++;
      }
    }
  }

  return { summary: lines.join('\n'), hasUsable: usableCount > 0 };
}


// ─────────────────────────────────────────────
//  LAYOUT AUTO-DETECTION
// ─────────────────────────────────────────────

function detectLayout(headerRow) {
  const headers = headerRow.map(h => h.toString().toLowerCase().trim());
  if (headers.includes('profile_url') || headers.includes('for_sale_count') || headers.includes('recent_sales')) {
    return 'B';
  }
  return 'A';
}

function getLayout(headerRow) {
  const layout = detectLayout(headerRow);
  return {
    id:   layout,
    cols: layout === 'B' ? COLS_B : COLS_A,
    name: layout === 'B' ? 'CSV / Zillow Scrape' : 'Original Spreadsheet'
  };
}


// ─────────────────────────────────────────────
//  MENU
// ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🛠️ Data Cleaner')
    .addItem('Clean, Validate & Score Leads',          'cleanAndValidateLeads')
    .addItem('Score & Segment (no cleaning)',           'scoreAndSegmentLeads')
    .addItem('Check Email Quality',                     'checkEmailQuality')
    .addItem('Verify Emails via API',                   'verifyEmailsViaApi')
    .addItem('Test Single Email',                       'testVerifyOneEmail')
    .addSeparator()
    .addItem('🔽 Filter by VerifyStatus',               'filterByVerifyStatus')
    .addItem('ℹ️ Show Detected Layout',                 'showDetectedLayout')
    .addToUi();
}

function showDetectedLayout() {
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const header = sheet.getDataRange().getValues()[0];
  const layout = getLayout(header);
  SpreadsheetApp.getUi().alert(
    `🔍 Detected Layout: ${layout.name} (${layout.id})\n\n` +
    (layout.id === 'B'
      ? 'Email column → M  |  Active Listings → I  |  Recent Sales → H'
      : 'Email column → J  |  Active Listings → T  |  Last 12mo Sales → R')
  );
}


// ─────────────────────────────────────────────
//  MAIN: Clean → Validate → Score → Segment
//  (regex fallback remains active here)
// ─────────────────────────────────────────────
function cleanAndValidateLeads() {
  loadPersistentCache();

  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const range  = sheet.getDataRange();
  const values = range.getValues();

  if (values.length <= 1) { SpreadsheetApp.getUi().alert('No data to clean!'); return; }

  const header = values[0];
  const layout = getLayout(header);
  const C      = layout.cols;

  Logger.log(`📐 Layout detected: ${layout.name}`);

  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 90);

  const seenEmails = new Set();
  let removedCount = {
    noEmail:0, invalidEmail:0, duplicate:0,
    missingName:0, missingCity:0, missingBrokerage:0,
    noActiveOpenHouse:0, oldLastSale:0,
    listingsOutOfRange:0, salesOutOfRange:0,
  };

  const normalised = values.slice(1).map(row => {
    const r = [...row];
    if (layout.id === 'A') {
      const emailJ = extractEmail(r[COLS_A.email]);
      if (emailJ) { r[COLS_A.email] = emailJ; return r; }
      const emailM = extractEmail(r[COLS_A.workNumber]);
      if (emailM) { r[COLS_A.email] = emailM; return r; }
      const emailO = extractEmail(r[COLS_A.personalNum]);
      if (emailO) { r[COLS_A.email] = emailO; return r; }
      r[COLS_A.email] = '';
    } else {
      r[COLS_B.email] = extractEmail(r[COLS_B.email]) || '';
    }
    return r;
  });

  // Regex-only pass during clean/score
  const savedFlag = SKIP_API_IN_CLEAN_SCORE;
  SKIP_API_IN_CLEAN_SCORE = true;

  const filteredRows = normalised.filter(row => {
    const email     = (row[C.email]     || '').toString().trim().toLowerCase();
    const name      = (row[C.name]      || '').toString().trim();
    const city      = (row[layout.id === 'B' ? C.location : C.city] || '').toString().trim();
    const brokerage = (row[C.brokerage] || '').toString().trim();

    if (!email)                             { removedCount.noEmail++;        return false; }
    const v = verifyEmailWithRotation(email, false);
    if (!v.valid)                           { removedCount.invalidEmail++;
                                              Logger.log(`🗑️ ${email}: ${v.detail}`); return false; }
    if (seenEmails.has(email))              { removedCount.duplicate++;      return false; }
    seenEmails.add(email);
    if (!name      || name.length < 2)      { removedCount.missingName++;    return false; }
    if (!city      || city.length < 2)      { removedCount.missingCity++;    return false; }
    if (!brokerage || brokerage.length < 2) { removedCount.missingBrokerage++; return false; }

    if (layout.id === 'A') {
      const openHouse    = (row[C.openHouse]    || '').toString().trim();
      const lastSale     = (row[C.lastSale]     || '').toString().trim();
      const lastSaleDate = (row[C.lastSaleDate] || '').toString().trim();
      if (openHouse === lastSale) {
        if (!lastSaleDate) { removedCount.noActiveOpenHouse++; return false; }
        try {
          const d = parseFlexibleDate(lastSaleDate);
          if (!d || d < thresholdDate) { removedCount.oldLastSale++; return false; }
        } catch (e) { removedCount.oldLastSale++; return false; }
      }
    }

    const listingsRaw = layout.id === 'B' ? row[C.forSaleCount] : row[C.activeListings];
    const listings    = layout.id === 'B' ? parseLeadingNumber(listingsRaw) : parseActiveListings(listingsRaw);
    if (listings < MIN_ACTIVE_LISTINGS || listings > MAX_ACTIVE_LISTINGS) {
      removedCount.listingsOutOfRange++; return false;
    }

    const salesRaw = layout.id === 'B' ? row[C.recentSales] : row[C.last12Sales];
    const sales    = parseLeadingNumber(salesRaw);
    if (sales < MIN_SALES || sales > MAX_SALES) {
      removedCount.salesOutOfRange++; return false;
    }

    return true;
  });

  SKIP_API_IN_CLEAN_SCORE = savedFlag;

  const scoredRows = filteredRows.map(row => scoreRow(row, layout.id));

  let newHeader = [...header];
  ['Score','Segment','VerifyStatus','VerifyDetail'].forEach(col => {
    if (!newHeader.includes(col)) newHeader.push(col);
  });

  const emailCol = layout.id === 'B' ? COLS_B.email : COLS_A.email;
  const finalRows = scoredRows.map(row => {
    const email  = (row[emailCol] || '').toString().trim().toLowerCase();
    const cached = verifyState.cache.get(email);
    return [...row, cached?.status || 'not-checked', cached?.detail || ''];
  });

  const finalData    = [newHeader, ...finalRows];
  const removedTotal = Object.values(removedCount).reduce((a, b) => a + b, 0);

  range.clearContent();
  sheet.getRange(1, 1, finalData.length, finalData[0].length).setValues(finalData);
  applySegmentColors(sheet, finalRows, finalData[0].length);
  savePersistentCache();

  SpreadsheetApp.getUi().alert(
    `✅ Cleanup + Scoring Complete!\n` +
    `📐 Layout: ${layout.name}\n\n` +
    `Kept:    ${filteredRows.length} valid leads\n` +
    `Removed: ${removedTotal} invalid leads\n\n` +
    `Breakdown:\n` +
    `  • No email:                     ${removedCount.noEmail}\n` +
    `  • Invalid email (regex):        ${removedCount.invalidEmail}\n` +
    `  • Duplicates:                   ${removedCount.duplicate}\n` +
    `  • Missing name:                 ${removedCount.missingName}\n` +
    `  • Missing city/location:        ${removedCount.missingCity}\n` +
    `  • Missing brokerage:            ${removedCount.missingBrokerage}\n` +
    (layout.id === 'A'
      ? `  • No active open house:         ${removedCount.noActiveOpenHouse}\n` +
        `  • Old last sale:                ${removedCount.oldLastSale}\n`
      : '') +
    `  • Listings out of range (1–7):  ${removedCount.listingsOutOfRange}\n` +
    `  • Sales out of range (3+):      ${removedCount.salesOutOfRange}\n\n` +
    `Added columns: Score | Segment | VerifyStatus | VerifyDetail`
  );
}


// ─────────────────────────────────────────────
//  Filter by VerifyStatus
// ─────────────────────────────────────────────
function filterByVerifyStatus() {
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const range  = sheet.getDataRange();
  const values = range.getValues();
  if (values.length <= 1) { SpreadsheetApp.getUi().alert('No data to filter!'); return; }

  const header = values[0];

  let vsIdx = header.findIndex(h => h.toString().toLowerCase().includes('verifystatus'));
  if (vsIdx === -1) {
    const layout = getLayout(header);
    vsIdx = layout.id === 'B' ? COLS_B.verifyStatus : COLS_A.verifyStatus;
  }

  let kept = 0, removed = 0, emptyKept = 0, validKept = 0, otherRemoved = 0;

  const filteredRows = values.slice(1).filter(row => {
    const v = (row[vsIdx] || '').toString().trim().toLowerCase();
    if (v === '')      { emptyKept++;  kept++;    return true; }
    if (v === 'valid') { validKept++;  kept++;    return true; }
    otherRemoved++; removed++;
    return false;
  });

  const finalData = [header, ...filteredRows];
  range.clearContent();
  sheet.getRange(1, 1, finalData.length, finalData[0].length).setValues(finalData);

  if (header.findIndex(h => h.toString().toLowerCase().includes('segment')) !== -1) {
    applySegmentColors(sheet, filteredRows, finalData[0].length);
  }

  SpreadsheetApp.getUi().alert(
    `✅ VerifyStatus Filter Complete!\n\n` +
    `Original rows: ${values.length - 1}\n` +
    `Kept:          ${kept}\n` +
    `Removed:       ${removed}\n\n` +
    `  • Empty (kept):     ${emptyKept}\n` +
    `  • "valid" (kept):   ${validKept}\n` +
    `  • Other (removed):  ${otherRemoved}\n\n` +
    `✅ KEEP: empty or "valid"\n` +
    `❌ REMOVE: anything else`
  );
}


// ─────────────────────────────────────────────
//  Score & Segment WITHOUT cleaning
//  (regex fallback remains active here)
// ─────────────────────────────────────────────
function scoreAndSegmentLeads() {
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const range  = sheet.getDataRange();
  const values = range.getValues();
  if (values.length <= 1) { SpreadsheetApp.getUi().alert('No data!'); return; }

  const layout = getLayout(values[0]);
  let header   = [...values[0]];
  ['Score','Segment','VerifyStatus','VerifyDetail'].forEach(c => {
    if (!header.includes(c)) header.push(c);
  });

  const scoredRows = values.slice(1).map(row => {
    const scored = scoreRow(row, layout.id);
    scored.push('not-checked', '');
    return scored;
  });

  const finalData = [header, ...scoredRows];
  range.clearContent();
  sheet.getRange(1, 1, finalData.length, finalData[0].length).setValues(finalData);
  applySegmentColors(sheet, scoredRows, finalData[0].length);

  const counts = { '🔥 Hot':0, '🌡️ Warm':0, '❄️ Cool':0, '🧊 Cold':0 };
  scoredRows.forEach(r => { const s = r[r.length - 4]; if (counts[s] !== undefined) counts[s]++; });

  SpreadsheetApp.getUi().alert(
    `📊 Scoring Complete!  (${layout.name})\n\n` +
    `🔥 Hot  (75–100): ${counts['🔥 Hot']}\n` +
    `🌡️ Warm (50–74):  ${counts['🌡️ Warm']}\n` +
    `❄️ Cool (25–49):  ${counts['❄️ Cool']}\n` +
    `🧊 Cold (0–24):   ${counts['🧊 Cold']}`
  );
}


// ─────────────────────────────────────────────
//  SCORING ENGINE  (layout-aware)
// ─────────────────────────────────────────────
function scoreRow(row, layoutId) {
  const score = calcScore(row, layoutId);
  return [...row, score, getSegment(score)];
}

function calcScore(row, layoutId) {
  let total = 0;

  if (layoutId === 'B') {
    const sales    = parseLeadingNumber(row[COLS_B.recentSales]);
    total += sales >= 35 ? 35 : sales >= 25 ? 25 : sales >= 10 ? 15 : 5;

    const listings = parseLeadingNumber(row[COLS_B.forSaleCount]);
    total += listings >= 12 ? 25 : listings >= 8 ? 18 : listings >= 4 ? 12 : 5;

    const rating = parseFloat((row[COLS_B.rating] || '0').toString()) || 0;
    total += rating >= 4.8 ? 20 : rating >= 4.5 ? 14 : rating >= 4.0 ? 8 : 2;

    const yrs = parseLeadingNumber(row[COLS_B.yearsExp]);
    total += yrs >= 20 ? 10 : yrs >= 10 ? 7 : 3;

    if (parseLeadingNumber(row[COLS_B.reviewCount]) >= 40) total += 10;

  } else {
    const sales = parseLeadingNumber(row[COLS_A.last12Sales]);
    total += sales >= 35 ? 35 : sales >= 25 ? 25 : 15;

    const listings = parseActiveListings(row[COLS_A.activeListings]);
    total += listings >= 12 ? 25 : listings >= 8 ? 18 : 10;

    let teamSize = parseTeamMembers(row[COLS_A.teamMembers]) || 1;
    if (teamSize === 0) {
      const solo = (row[COLS_A.teamSolo] || '').toString().trim().toLowerCase();
      teamSize = solo === 'team' ? 5 : 1;
    }
    total += teamSize <= 3 ? 20 : teamSize <= 9 ? 12 : teamSize <= 19 ? 6 : 2;

    const yrs = parseLeadingNumber(row[COLS_A.yearsExp]);
    total += yrs >= 20 ? 10 : yrs >= 10 ? 7 : 3;

    if (parseReviewCount(row[COLS_A.reviews]) >= 40) total += 10;
  }

  return Math.min(100, Math.max(0, total));
}

function getSegment(score) {
  if (score >= 75) return '🔥 Hot';
  if (score >= 50) return '🌡️ Warm';
  if (score >= 25) return '❄️ Cool';
  return '🧊 Cold';
}

function applySegmentColors(sheet, scoredRows, totalCols) {
  const colors = { '🔥 Hot':'#fce8e6', '🌡️ Warm':'#fef9e7', '❄️ Cool':'#e8f4fd', '🧊 Cold':'#f3f3f3' };
  scoredRows.forEach((row, i) => {
    const seg = row[row.length - 4];
    sheet.getRange(i + 2, 1, 1, totalCols).setBackground(colors[seg] || '#fff');
  });
}


// ─────────────────────────────────────────────
//  EMAIL QUALITY CHECK
// ─────────────────────────────────────────────
function checkEmailQuality() {
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) { SpreadsheetApp.getUi().alert('No data!'); return; }

  const layout   = getLayout(values[0]);
  const emailCol = layout.id === 'B' ? COLS_B.email : COLS_A.email;

  const domains = {};
  values.slice(1).forEach(row => {
    const email = (row[emailCol] || '').toString().trim().toLowerCase();
    if (email.includes('@')) {
      const d = email.split('@')[1];
      domains[d] = (domains[d] || 0) + 1;
    }
  });

  const top = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 10);
  SpreadsheetApp.getUi().alert(
    `📊 Top Email Domains  (${layout.name}):\n\n` +
    top.map(([d, c]) => `${d}: ${c}`).join('\n')
  );
}


// ─────────────────────────────────────────────
//  ROTATING EMAIL VERIFIER
//
//  Parameters:
//    email             — address to verify
//    skipRegexFallback — true  → API-only; returns 'unknown' if all exhausted
//                        false → falls back to regex if all APIs exhausted
//                                (default; used by clean/score passes)
//
//  Token rotation strategy (exhaust-then-rotate, cross-provider):
//    1. For each provider (myemailverifier → emailverifyio):
//       a. Starting from activeKeyIdx, iterate through all tokens.
//       b. Skip any token that is rate-exhausted OR zero-credit.
//       c. On a successful call → cache result, return.
//       d. On 429 / rate-limit error → mark token exhausted, try next token.
//       e. On other error → log, skip token (don't exhaust count).
//    2. If ALL tokens of provider A are unusable → fall through to provider B.
//    3. If ALL providers are exhausted:
//       • skipRegexFallback=false → regex fallback (clean/score)
//       • skipRegexFallback=true  → return 'unknown' (verifyEmailsViaApi)
// ─────────────────────────────────────────────
function verifyEmailWithRotation(email, skipRegexFallback) {
  if (skipRegexFallback === undefined) skipRegexFallback = false;

  const emailLower = email.toLowerCase();

  // ── Cache hit ──
  const cached = verifyState.cache.get(emailLower);
  if (cached && (Date.now() - cached.timestamp) < EMAIL_VERIFY_CONFIG.cacheTtlHours * 3600000) {
    return {
      valid:  cached.status === 'valid',
      status: cached.status,
      detail: cached.detail,
      source: cached.provider + ' (cached)'
    };
  }

  // ── Clean pass: skip APIs entirely, regex only ──
  if (SKIP_API_IN_CLEAN_SCORE) {
    if (EMAIL_VERIFY_CONFIG.fallbackToRegex) {
      const ok = isValidEmail(email);
      verifyState.cache.set(emailLower, {
        status: ok ? 'valid' : 'invalid', detail: 'regex-only',
        provider: 'regex', timestamp: Date.now()
      });
      return { valid: ok, status: ok ? 'valid' : 'invalid', detail: 'regex-only', source: 'regex' };
    }
    return { valid: false, status: 'invalid', detail: 'no-api-no-regex', source: 'none' };
  }

  // ── Reset rate-limit counters every 60 s (zeroCredits untouched) ──
  maybeResetCounters_();

  // ── Try each provider in order; cross-provider fallback is automatic ──
  for (const provider of ['myemailverifier', 'emailverifyio']) {
    const config = EMAIL_VERIFY_CONFIG[provider];
    const keys   = (config.keys || []).filter(k => k && k.toString().trim().length > 4);
    if (!keys.length) continue;

    ensureCounters_(provider, keys.length);

    const startIdx = verifyState.activeKeyIdx[provider] || 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = (startIdx + attempt) % keys.length;

      // Skip rate-exhausted tokens
      if (verifyState.counters[provider][idx] >= config.rateLimit) {
        Logger.log(`⏭️ ${provider}[${idx}] rate-exhausted — trying next`);
        continue;
      }

      // Skip zero-credit tokens (permanent for this run)
      if (verifyState.zeroCredits[provider] && verifyState.zeroCredits[provider][idx]) {
        Logger.log(`⏭️ ${provider}[${idx}] zero-credit — skipping`);
        continue;
      }

      try {
        const result = callVerifierAPI(provider, email, keys[idx]);
        verifyState.counters[provider][idx]++;
        verifyState.activeKeyIdx[provider] = idx;

        verifyState.cache.set(emailLower, {
          status:    result.status,
          detail:    result.detail,
          provider:  `${provider}[${idx}]`,
          timestamp: Date.now()
        });

        return {
          valid:  result.status === 'valid',
          status: result.status,
          detail: result.detail,
          source: `${provider}[${idx}]`
        };

      } catch (e) {
        if (e.message.includes('429') || e.message.toLowerCase().includes('rate limit')) {
          // Exhaust this token and immediately try the next one
          verifyState.counters[provider][idx] = config.rateLimit;
          verifyState.activeKeyIdx[provider]  = (idx + 1) % keys.length;
          Logger.log(`⚠️ ${provider}[${idx}] 429 — rotating to next token`);
          continue;
        }
        // Non-rate error: log but don't exhaust the token
        Logger.log(`❌ ${provider}[${idx}] error: ${e.message}`);
      }
    }

    Logger.log(`🚫 All tokens for ${provider} unusable — falling through to next provider`);
  }

  // ── All providers / tokens exhausted ──
  if (!skipRegexFallback && EMAIL_VERIFY_CONFIG.fallbackToRegex) {
    const ok = isValidEmail(email);
    verifyState.cache.set(emailLower, {
      status: ok ? 'valid' : 'invalid', detail: 'regex-fallback',
      provider: 'regex', timestamp: Date.now()
    });
    return { valid: ok, status: ok ? 'valid' : 'invalid', detail: 'regex-fallback', source: 'regex' };
  }

  return { valid: false, status: 'unknown', detail: 'all-providers-exhausted', source: 'none' };
}


// ─────────────────────────────────────────────
//  CALL VERIFIER API
//  key is passed explicitly — no longer read from config.
// ─────────────────────────────────────────────
function callVerifierAPI(provider, email, key) {
  const config = EMAIL_VERIFY_CONFIG[provider];
  const fields = config.fields;

  // Robust URL building
  let url = config.url;
  url += (url.includes('?') ? '&' : '?');

  if (provider === 'myemailverifier') {
    url += `apikey=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  } else {
    // FIXED: QuickEmailVerification uses 'apikey' parameter, not 'key'
    url += `apikey=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  }

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const code     = response.getResponseCode();
  const text     = response.getContentText();

  if (code === 429) throw new Error('429 rate limit');
  if (code === 401 || code === 403) throw new Error(`Auth failed (${code})`);
  if (code === 402) throw new Error('402 out of credits');
  if (code < 200 || code >= 300)   throw new Error(`HTTP ${code}: ${text.substring(0, 200)}`);

  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`JSON parse error: ${e.message}`); }

  if (provider === 'myemailverifier') {
    const statusRaw    = (json[fields.status]     || '').toString().toLowerCase();
    const isDisposable = (json[fields.disposable] || 'false').toString().toLowerCase() === 'true';
    const isRole       = (json[fields.role]       || 'false').toString().toLowerCase() === 'true';
    const diagnosis    = json[fields.diagnosis]   || '';
    let status = statusRaw === 'valid'     ? 'valid'
               : statusRaw === 'catch-all' ? 'risky'
               : statusRaw === 'unknown'   ? 'unknown'
               : 'invalid';
    if (status === 'valid' && (isDisposable || isRole)) status = 'risky';
    return { status, detail: diagnosis || `Status:${statusRaw}|Disposable:${isDisposable}|Role:${isRole}` };

  } else if (provider === 'emailverifyio') {
    const statusRaw    = (json[fields.status]     || '').toString().toLowerCase();
    const isDisposable = (json[fields.disposable] || 'false').toString().toLowerCase() === 'true';
    const isRole       = (json[fields.role]       || 'false').toString().toLowerCase() === 'true';
    const isAcceptAll  = (json[fields.accept_all]  || 'false').toString().toLowerCase() === 'true';
    const isSafe       = (json[fields.safe_to_send] || 'false').toString().toLowerCase() === 'true';

    let status = statusRaw.includes('deliverable') || statusRaw === 'valid' ? 'valid'
               : statusRaw.includes('catch')       || statusRaw.includes('risky') ? 'risky'
               : statusRaw.includes('unknown')     ? 'unknown'
               : 'invalid';

    // Improved risk detection
    if (status === 'valid' && (isDisposable || isRole || isAcceptAll || !isSafe)) {
      status = 'risky';
    }

    return { status, detail: JSON.stringify(json).substring(0, 150) };
  }

  throw new Error(`Unknown provider: ${provider}`);
}


// ─────────────────────────────────────────────
//  BULK VERIFY VIA MENU
//
//  Flow:
//    1. Check credits for every token (both providers).
//    2. Show credit summary + YES/NO prompt — abort if user says NO.
//    3. Run verification row by row (API-only, no regex fallback).
//       • Each email tries all usable tokens across both providers.
//       • Zero-credit tokens are permanently skipped.
//       • Rate-exhausted tokens rotate within/across providers.
//    4. Show final result summary including per-token call usage.
// ─────────────────────────────────────────────
function verifyEmailsViaApi() {
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) { SpreadsheetApp.getUi().alert('No data!'); return; }

  const ui     = SpreadsheetApp.getUi();
  const layout = getLayout(values[0]);

  // ── Step 1: Credit check ──
  const { summary: creditSummary, hasUsable } = checkAllCreditsBeforeRun_();

  if (!hasUsable) {
    ui.alert(
      '❌ No usable tokens found!\n\n' +
      creditSummary + '\n\n' +
      'Please add tokens with remaining credits to EMAIL_VERIFY_CONFIG and try again.'
    );
    return;
  }

  // ── Step 2: Show credits and ask to proceed ──
  const proceed = ui.alert(
    '💳 Pre-run Credit Check',
    creditSummary +
    '\n\n──────────────────────────────\n' +
    `Rows to verify: ${values.length - 1}\n\n` +
    'Proceed with verification?',
    ui.ButtonSet.YES_NO
  );
  if (proceed !== ui.Button.YES) {
    ui.alert('Verification cancelled.');
    return;
  }

  // ── Step 3: Verify rows ──
  const emailCol = layout.id === 'B' ? COLS_B.email : COLS_A.email;
  const header   = values[0];

  let statusIdx = header.indexOf('VerifyStatus');
  let detailIdx = header.indexOf('VerifyDetail');
  if (statusIdx === -1) { statusIdx = header.length;    sheet.getRange(1, statusIdx + 1).setValue('VerifyStatus'); }
  if (detailIdx === -1) { detailIdx = statusIdx + 1;    sheet.getRange(1, detailIdx + 1).setValue('VerifyDetail'); }

  const counts = { valid: 0, risky: 0, invalid: 0, unknown: 0, skipped: 0 };

  for (let i = 1; i < values.length; i++) {
    const email = (values[i][emailCol] || '').toString().trim().toLowerCase();

    // No email or fails basic regex shape → skip (no API call wasted)
    if (!email || !isValidEmail(email)) {
      sheet.getRange(i + 1, statusIdx + 1).setValue('skipped');
      sheet.getRange(i + 1, detailIdx + 1).setValue('no-valid-email');
      counts.skipped++;
      continue;
    }

    // skipRegexFallback = true → API-only; 'unknown' if all exhausted
    const result = verifyEmailWithRotation(email, true);
    sheet.getRange(i + 1, statusIdx + 1).setValue(result.status);
    sheet.getRange(i + 1, detailIdx + 1).setValue(result.detail);
    counts[result.status] = (counts[result.status] || 0) + 1;

    Utilities.sleep(2000);
  }

  savePersistentCache();

  // ── Step 4: Result summary ──
  const tokenUsage = ['myemailverifier', 'emailverifyio'].map(p => {
    const keys    = (EMAIL_VERIFY_CONFIG[p].keys || []).filter(k => k && k.length > 4);
    const perToken = (verifyState.counters[p] || [])
      .map((calls, idx) => {
        const zero = verifyState.zeroCredits[p] && verifyState.zeroCredits[p][idx] ? ' [zero-credit, skipped]' : '';
        return `    Token [${idx}]: ${calls} calls${zero}`;
      }).join('\n');
    const total = (verifyState.counters[p] || []).reduce((a, b) => a + b, 0);
    return `  ${p} (${keys.length} token${keys.length !== 1 ? 's' : ''}, ${total} total calls):\n${perToken || '    none'}`;
  }).join('\n');

  ui.alert(
    `✅ Verification Complete!  (${layout.name})\n\n` +
    `Valid:   ${counts.valid}\n` +
    `Risky:   ${counts.risky}\n` +
    `Invalid: ${counts.invalid}\n` +
    `Unknown: ${counts.unknown}\n` +
    `Skipped: ${counts.skipped}\n\n` +
    `Token usage this run:\n${tokenUsage}`
  );
}


// ─────────────────────────────────────────────
//  TEST SINGLE EMAIL
// ─────────────────────────────────────────────
function testVerifyOneEmail() {
  const email  = 'allison@luxe-hunter.com';
  const result = verifyEmailWithRotation(email, false);
  SpreadsheetApp.getUi().alert(
    `Test: ${email}\n\nStatus: ${result.status}\nValid: ${result.valid}\nSource: ${result.source}\nDetail: ${result.detail}`
  );
}


// ─────────────────────────────────────────────
//  PERSISTENT CACHE
// ─────────────────────────────────────────────
function loadPersistentCache() {
  const raw = PropertiesService.getUserProperties().getProperty('email_cache_unified_v1');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const now = Date.now(), ttl = EMAIL_VERIFY_CONFIG.cacheTtlHours * 3600000;
    for (const [email, data] of Object.entries(parsed)) {
      if (now - data.timestamp < ttl) verifyState.cache.set(email, data);
    }
    Logger.log(`♻️ Loaded ${verifyState.cache.size} cached verifications`);
  } catch (e) { Logger.log(`⚠️ Cache load error: ${e.message}`); }
}

function savePersistentCache() {
  const obj = {};
  for (const [email, data] of verifyState.cache) obj[email] = data;
  try {
    PropertiesService.getUserProperties().setProperty('email_cache_unified_v1', JSON.stringify(obj));
    Logger.log(`💾 Saved ${verifyState.cache.size} verifications`);
  } catch (e) { Logger.log(`⚠️ Cache save error: ${e.message}`); }
}


// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function parseReviewCount(val) {
  if (!val && val !== 0) return 0;
  const str = val.toString().trim().replace(/\b\d+\.\d+\b/g, '').trim();
  const m = str.match(/(\d+)/); return m ? parseInt(m[1], 10) : 0;
}

function parseActiveListings(val) {
  if (!val && val !== 0) return 0;
  const str = val.toString().trim();
  const p = str.match(/\((\d+)\)/); if (p) return parseInt(p[1], 10);
  const m = str.match(/(\d+)/); return m ? parseInt(m[1], 10) : 0;
}

function parseTeamMembers(val) {
  if (!val && val !== 0) return 0;
  const m = val.toString().trim().match(/(\d+)/); return m ? parseInt(m[1], 10) : 0;
}

function parseLeadingNumber(val) {
  if (val == null || val === '') return 0;
  const m = val.toString().trim().match(/^(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0;
}

function extractEmail(val) {
  if (!val) return '';
  const str = val.toString().trim().toLowerCase();
  if (isValidEmail(str)) return str;
  const m = str.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return (m && isValidEmail(m[0])) ? m[0] : '';
}

function isValidEmail(email) {
  const r = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!r.test(email) || email.includes('..') || email.includes('@.') ||
      email.includes('.@') || email.split('@').length !== 2) return false;
  const [u, d] = email.split('@');
  if (u.length < 1 || u.startsWith('.') || u.endsWith('.') ||
      d.length < 3 || !d.includes('.') || d.startsWith('.') || d.endsWith('.')) return false;
  const bad = ['test.com','example.com','sample.com','demo.com',
               'mail.com','email.com','noemail.com','none.com','followupboss.me'];
  return !bad.includes(d.toLowerCase());
}

function parseFlexibleDate(s) {
  if (!s) return null;
  let d = new Date(s); if (!isNaN(d)) return d;
  const p = s.split('/');
  if (p.length === 3) {
    const mo = parseInt(p[0]) - 1, day = parseInt(p[1]), yr = parseInt(p[2]);
    if (!isNaN(mo) && !isNaN(day) && !isNaN(yr)) { d = new Date(yr, mo, day); if (!isNaN(d)) return d; }
  }
  return null;
}