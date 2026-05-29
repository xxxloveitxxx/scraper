// content.js — injected into every zillow.com page

// ── Listen for messages from background ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractLinks") {
    sendResponse({ links: extractProfileLinks(), blocked: isBlockPage() });
  }
  if (msg.action === "extractProfile") {
    sendResponse({ data: extractProfileData(), blocked: isBlockPage() });
  }
  if (msg.action === "ping") {
    sendResponse({ ok: true, blocked: isBlockPage() });
  }
  return true;
});

// ── Block / CAPTCHA detection ─────────────────────────────────────────────
// Only full phrases that appear exclusively on real block/CAPTCHA pages.
// Single words like "blocked", "robot", "captcha" are NOT used because they
// appear in normal Zillow page text (street blocks, footer links, etc.).
function isBlockPage() {
  const body  = document.body?.innerText?.toLowerCase() || "";
  const title = document.title?.toLowerCase() || "";
  return (
    body.includes("you have been blocked") ||
    body.includes("access denied") ||
    body.includes("unusual traffic from your") ||
    body.includes("verify you are human") ||
    body.includes("verify that you are human") ||
    body.includes("press and hold") ||
    body.includes("press & hold") ||
    body.includes("complete the security check") ||
    body.includes("human verification") ||
    title.includes("access denied") ||
    title.includes("attention required") ||
    title.includes("just a moment") ||
    title.includes("security check")
  );
}

// ── Extract profile links from search/list page ───────────────────────────
function extractProfileLinks() {
  const links = new Set();
  const anchors = document.querySelectorAll("a[href]");

  anchors.forEach(a => {
    const href = a.href || "";
    if (
      href.includes("zillow.com/profile/") ||
      (href.includes("zillow.com/professionals/") && href.includes("-agent/"))
    ) {
      let clean = href.split("?")[0].split("#")[0];
      clean = clean.replace(/[)/]+$/, "").replace(/\/+$/, "") + "/";
      if (clean.includes("zillow.com/")) {
        links.add(clean);
      }
    }
  });

  // Also parse raw HTML text for links that might be in JS data
  const html = document.documentElement.innerHTML;
  const profileMatches = html.matchAll(/["'](\/profile\/[^"'>\s)]+)/g);
  for (const m of profileMatches) {
    const clean = "https://www.zillow.com" + m[1].replace(/[)/]+$/, "").replace(/\/+$/, "") + "/";
    links.add(clean);
  }

  return Array.from(links);
}

// ── Extract profile data from an agent profile page ───────────────────────
function extractProfileData() {
  const md   = document.body?.innerText || "";
  const html = document.documentElement?.innerHTML || "";

  const forSaleAddr    = extractForSaleAddress();
  const recentSaleAddr = extractRecentSaleAddress(forSaleAddr);

  return {
    name:                extractName(md),
    location:            extractLocation(md),
    brokerage:           extractBrokerage(md),
    rating:              extractRating(md),
    review_count:        extractReviews(md),
    years_experience:    extractYearsExperience(md),
    recent_sales:        extractRecentSales(md),
    specialties:         extractSpecialties(md),
    languages:           extractLanguages(md),
    phone:               extractPhone(md, html),
    email:               extractEmail(md, html),
    for_sale_count:      extractForSaleCount(md),
    for_sale_address:    forSaleAddr,
    recent_sale_address: recentSaleAddr,
    profile_url:         window.location.href.replace(/[)/]+$/, "").replace(/\/+$/, "") + "/",
    scraped_at:          new Date().toISOString(),
  };
}

function extractName(md) {
  const h1 = document.querySelector("h1");
  if (h1) {
    const name = h1.innerText.trim();
    if (name.length > 1 && name.length < 80 && name.split(" ").length <= 7) {
      return name;
    }
  }
  const title = document.title;
  const titleMatch = title.match(/^([^|–\-]+?)(?:\s*[-–|])/);
  if (titleMatch) return titleMatch[1].trim();
  return null;
}

function extractLocation(md) {
  const breadcrumbs = document.querySelectorAll("nav a, ol a, [class*='breadcrumb'] a");
  for (const a of breadcrumbs) {
    const href = a.href || "";
    const m = href.match(/real-estate-agent-reviews\/([a-z-]+)-([a-z]{2})\//);
    if (m) {
      const city  = a.innerText.trim();
      const state = m[2].toUpperCase();
      return `${city}, ${state}`;
    }
  }
  const m = md.match(/([A-Z][a-z]{2,},\s*[A-Z]{2})(?:\s|$)/);
  return m ? m[1].trim() : null;
}

function extractBrokerage(md) {
  const brokerageKeywords = /Realty|Realtors?|Real Estate|Properties|Group|LLC|Inc\.?|Team|Homes|KW|RE\/MAX|Compass|eXp|Coldwell|Century|Berkshire|Sotheby|Keller Williams|LPT|Agile/i;
  const lines = md.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 3 && t.length < 65 && brokerageKeywords.test(t)) {
      return t;
    }
  }
  return null;
}

function extractRating(md) {
  const m = md.match(/(\d\.\d)\s*\[[\d,]+\s+(?:team\s+)?reviews/);
  if (m) return parseFloat(m[1]);
  const m2 = md.match(/^(\d\.\d)\s*$/m);
  if (m2) return parseFloat(m2[1]);
  return null;
}

function extractReviews(md) {
  const m = md.match(/\[([\d,]+)\s+(?:team\s+)?reviews?\]/);
  if (m) return parseInt(m[1].replace(/,/g, ""));
  const m2 = md.match(/([\d,]+)\s+reviews?/i);
  if (m2) return parseInt(m2[1].replace(/,/g, ""));
  return null;
}

function extractYearsExperience(md) {
  const m = md.match(/(\d{1,2})\s+[Yy]ears?\s+of\s+experience/);
  return m ? parseInt(m[1]) : null;
}

function extractRecentSales(md) {
  const m = md.match(/([\d,]+)\s*\n\s*Sales last 12 months/);
  if (m) return parseInt(m[1].replace(/,/g, ""));
  return null;
}

function extractSpecialties(md) {
  const known = [
    "Buyer's Agent", "Listing Agent", "Relocation",
    "First Time Homebuyers", "Investment Properties",
    "Luxury Homes", "New Construction", "Lot/Land",
    "Foreclosures", "Short Sales", "Commercial",
    "Property Management", "Vacation/Resort Properties",
    "Farm and Ranch", "Staging", "Title",
  ];
  const bodyText = document.body?.innerText || "";
  const specMatch = bodyText.match(/Specialties\s*\n([^\n]+)/);
  if (specMatch) {
    const raw   = specMatch[1];
    const found = known.filter(s => raw.includes(s));
    return found.length ? found : [raw.trim()];
  }
  return [];
}

function extractLanguages(md) {
  const m = md.match(/Speaks([A-Z][^\n]+)/);
  if (m) {
    return m[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);
  }
  const m2 = md.match(/Languages?[:\s]+([^\n]+)/i);
  if (m2) {
    return m2[1].split(/[,|]/).map(s => s.trim()).filter(s => s.length > 2).slice(0, 5);
  }
  return [];
}

function extractPhone(md, html) {
  const telLink = document.querySelector("a[href^='tel:']");
  if (telLink) return telLink.href.replace("tel:", "").trim();
  const m = md.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  return m ? m[1].trim() : null;
}

function extractEmail(md, html) {
  const mailLink = document.querySelector("a[href^='mailto:']");
  if (mailLink) {
    return mailLink.href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
  }
  const m = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractForSaleCount(md) {
  const m = md.match(/For Sale\s*\(([\d,]+)\)/);
  return m ? parseInt(m[1].replace(/,/g, "")) : null;
}

// ── Shared address helpers ────────────────────────────────────────────────

// Street address regex — digits then 1-3 words then a recognised street type.
const ADDRESS_PATTERN = /\b\d{1,5}\s+(?:[A-Za-z0-9'][A-Za-z0-9'\s]{0,40}?)(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Trail|Trl|Way|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Square|Sq)\b/i;

// Noise tokens that can appear before the real house number
// e.g. "3 bds 2 ba 1,200 sqft 1010 S Ocean Blvd"
const NOISE_PREFIX = /^(?:[\d,]+\s+(?:sqft|sq\.?\s*ft\.?|beds?|bds?|baths?|bas?|acres?|units?|stories|story|floors?|garage|car|spaces?)[,\s]+)+/i;

// Zillow corporate addresses — always wrong when extracted as an agent listing
const BLOCKED_ADDRESSES = [
  "2600 michelson drive",
  "1301 second avenue",
  "333 108th avenue",
];

function _cleanAddress(str) {
  if (!str) return null;
  return str.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

// Strip noise prefix then validate; return null if blocklisted or empty.
function _sanitize(str) {
  if (!str) return null;
  const stripped = str.replace(NOISE_PREFIX, "").trim();
  const clean    = _cleanAddress(stripped);
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (BLOCKED_ADDRESSES.some(b => lower.startsWith(b) || lower.includes(b))) return null;
  return clean;
}

// Return the best (longest, clean) address match from a text string.
function _bestMatch(text) {
  if (!text) return null;
  const re  = new RegExp(ADDRESS_PATTERN.source, "gi");
  let best  = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clean = _sanitize(m[0]);
    if (clean && (!best || clean.length > best.length)) best = clean;
  }
  return best;
}

// PRIMARY: parse the address directly out of a Zillow homedetails URL slug.
// Zillow URLs look like: /homedetails/1010-S-Ocean-Blvd-Pompano-Beach-FL-33062/zpid/
// The slug always has the address before the city/state/zip — and it's clean.
function _addressFromUrl(href) {
  if (!href) return null;
  const m = href.match(/\/homedetails\/([^/?#]+)/);
  if (!m) return null;
  // Decode percent-encoding, replace hyphens with spaces
  const slug = decodeURIComponent(m[1]).replace(/-/g, " ");
  return _bestMatch(slug) || null;
}

// Collect all homedetails links from a container, deduped by href.
function _homedetailsLinks(container) {
  return Array.from(container.querySelectorAll('a[href*="/homedetails/"]'));
}

// ── For-Sale address extraction ───────────────────────────────────────────
function extractForSaleAddress() {
  // Try to narrow to the For Sale / Active Listings section
  let searchArea = document.body;
  for (const s of document.querySelectorAll("section, [class*='section'], [data-testid]")) {
    const txt = (s.innerText || "").toLowerCase();
    if (txt.includes("active listings") || txt.includes("for sale")) {
      searchArea = s;
      break;
    }
  }

  // Strategy 1: Parse address from homedetails URL slug (most reliable)
  for (const link of _homedetailsLinks(searchArea)) {
    const addr = _addressFromUrl(link.href);
    if (addr) return addr;
  }

  // Strategy 2: Try link innerText (card text contains address among other info)
  for (const link of _homedetailsLinks(searchArea)) {
    const addr = _bestMatch(link.innerText || "");
    if (addr) return addr;
  }

  // Strategy 3: Text elements in the section (h3, h4, span, p, address)
  for (const el of searchArea.querySelectorAll("h3, h4, address, span, p")) {
    if (el.closest('[id*="about"], [class*="about"], [class*="bio"]')) continue;
    const addr = _bestMatch(el.innerText || "");
    if (addr) return addr;
  }

  return null;
}

// ── Recent-sale address extraction ────────────────────────────────────────
function extractRecentSaleAddress(forSaleAddr) {
  const forSaleClean = (forSaleAddr || "").toLowerCase();

  // Try to narrow to the Past Sales / Sold section
  let searchArea = document.body;
  for (const s of document.querySelectorAll("section, [class*='section'], [data-testid]")) {
    const txt = (s.innerText || "").toLowerCase();
    if (txt.includes("past sales") || txt.includes("sold")) {
      searchArea = s;
      break;
    }
  }

  // Strategy 1: Cards explicitly labelled "Sold" / "Past Sale"
  for (const card of searchArea.querySelectorAll("article, [class*='property-card'], [class*='listing'], li")) {
    const cardText = (card.innerText || "").toLowerCase();
    if (!cardText.includes("sold") && !cardText.includes("past sale") && !cardText.includes("recently sold")) continue;
    if (card.closest('[id*="about"], [class*="about"], [class*="bio"]')) continue;

    for (const link of card.querySelectorAll('a[href*="/homedetails/"]')) {
      const addr = _addressFromUrl(link.href);
      if (addr && addr.toLowerCase() !== forSaleClean) return addr;
    }
    for (const link of card.querySelectorAll('a[href*="/homedetails/"]')) {
      const addr = _bestMatch(link.innerText || "");
      if (addr && addr.toLowerCase() !== forSaleClean) return addr;
    }
  }

  // Strategy 2: All homedetails links in reverse (sold listings appear lower)
  const links = _homedetailsLinks(searchArea).reverse();
  for (const link of links) {
    if (link.closest('[id*="about"], [class*="about"], [class*="bio"]')) continue;
    // URL slug first
    const addrUrl = _addressFromUrl(link.href);
    if (addrUrl && addrUrl.toLowerCase() !== forSaleClean) return addrUrl;
    // Then card text
    const addrText = _bestMatch(link.innerText || "");
    if (addrText && addrText.toLowerCase() !== forSaleClean) return addrText;
  }

  return null;
}
