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
  // Try multiple patterns to find "For sale (24)" style count
  const patterns = [
    /For\s*Sale\s*\(?([\d,]+)\)?/i,
    /For\s*sale\s*\(?([\d,]+)\)?/i,
    /Active\s*Listings?\s*\(?([\d,]+)\)?/i,
    /Listings?\s*\(?([\d,]+)\)?/i,
    /(\d+)\s+Active/i,
    /(\d+)\s+For\s*Sale/i,
  ];
  
  for (const pattern of patterns) {
    const m = md.match(pattern);
    if (m) {
      const count = parseInt(m[1].replace(/,/g, ""));
      if (count > 0 && count < 10000) return count;
    }
  }
  
  // Also search in specific DOM elements that Zillow uses
  const tabElements = document.querySelectorAll('[class*="tab"], [class*="menu"], [class*="nav"], [role="tab"], button');
  for (const el of tabElements) {
    const text = el.innerText || "";
    const m = text.match(/For\s*Sale\s*\(?([\d,]+)\)?/i);
    if (m) {
      const count = parseInt(m[1].replace(/,/g, ""));
      if (count > 0 && count < 10000) return count;
    }
  }
  
  // Also search in data attributes
  const dataElements = document.querySelectorAll('[data-count], [data-tab], [data-active]');
  for (const el of dataElements) {
    const text = el.innerText || "";
    const m = text.match(/For\s*Sale\s*\(?([\d,]+)\)?/i);
    if (m) {
      const count = parseInt(m[1].replace(/,/g, ""));
      if (count > 0 && count < 10000) return count;
    }
    // Also check data attributes
    for (const attr of el.attributes) {
      if (attr.name.includes('count') || attr.name.includes('tab')) {
        const m2 = attr.value.match(/(\d+)/);
        if (m2) {
          const count = parseInt(m2[1]);
          if (count > 0 && count < 10000) return count;
        }
      }
    }
  }
  
  // Also search in the page source for JSON data
  const html = document.documentElement?.innerHTML || "";
  const jsonMatch = html.match(/["']?for\s*sale["']?\s*[:\s]*\(?\s*(\d+)/i);
  if (jsonMatch) {
    const count = parseInt(jsonMatch[1]);
    if (count > 0 && count < 10000) return count;
  }
  
  // Also look for it in the page title or meta
  const title = document.title || "";
  const mTitle = title.match(/For\s*Sale\s*\(?([\d,]+)\)?/i);
  if (mTitle) {
    const count = parseInt(mTitle[1].replace(/,/g, ""));
    if (count > 0 && count < 10000) return count;
  }
  
  return null;
}

// ── Shared address helpers ────────────────────────────────────────────────

// Street address regex — digits then 1-3 words then a recognised street type.
const ADDRESS_PATTERN = /\b\d{1,5}\s+(?:[A-Za-z0-9'][A-Za-z0-9'\s]{0,40}?)(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Trail|Trl|Way|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Square|Sq)\b/i;

// Noise tokens that can appear before the real house number
// e.g. "3 bds 2 ba 1,200 sqft 1010 S Ocean Blvd"
const NOISE_PREFIX = /^(?:[\d,]+\s+(?:bd|bedroom|bds?|ba|bath|baths?|sqft|sq\.?\s*ft\.?|acres?|ac|units?|stories|story|floors?|garage|car|spaces?)[,\s]+)+/i;

// More aggressive cleanup for property card text
// Matches: "500 2 bd1 ba700 sqft 2000 NE 51st" or "000 1 bd1 ba818 sqft 6853 NW 26th Ct"
const PROPERTY_CARD_CLEANUP = /^(?:000\s*)?(?:\d+\s+(?:bd|bedroom|bds?|ba|bath|baths?|sqft|sq\.?\s*ft\.?)[,\s]*)+/gi;

// Additional pattern to strip property details from the front
// Matches standalone property stats: "500 2 bd" or "1 bd1 ba450 sqft" at start
const PROPERTY_STATS_PREFIX = /^(?:\d+\s*(?:bd|bedroom|bds?|ba|bath|baths?)\s*(?:\d+\s*(?:sqft|sq\.?\s*ft\.?))?\s*)+/gi;

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
  let stripped = str;
  // Clean property card text patterns like "000 1 bd1 ba818 sqft 6853 NW 26th Ct"
  stripped = stripped.replace(PROPERTY_CARD_CLEANUP, "").trim();
  // Also handle patterns like "500 2 bd1 ba700 sqft 2000 NE 51st"
  stripped = stripped.replace(PROPERTY_STATS_PREFIX, "").trim();
  // Also handle the case where it's like "1 bd1 ba450 sqft 1200 W Las Olas Blvd"
  stripped = stripped.replace(NOISE_PREFIX, "").trim();
  const clean = _cleanAddress(stripped);
  if (!clean) return null;
  const lower = clean.toLowerCase();
  // Reject non-address garbage
  if (lower.includes("billion") || lower.includes("million") || 
      lower.includes("in the past") || lower.includes("in middle") ||
      lower.includes("at middle") || lower === "000" || /^\d+$/.test(clean)) return null;
  // Must start with a digit (house number)
  if (!/^\d/.test(clean)) return null;
  // Reject if too short (not a valid address)
  if (clean.length < 10) return null;
  // Reject if doesn't look like a real street address (no street type)
  if (!/\b(?:avenue|ave|street|st|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|circle|cir|trail|trl|way|place|pl|terrace|ter|highway|hwy|parkway|pkwy|square|sq)\b/i.test(clean)) return null;
  // Reject if address-like but contains common non-address phrases
  const badPhrases = ["past", "last year", "sold in", "sold on", "in the past", 
                      "middle river", "middle creek", "middle branch", "team reviews",
                      "sales last", "reviews", "332 team", "0 332", "bd1 ba",
                      "ba700", "bd2", "bd1", "sqft"];
  for (const phrase of badPhrases) {
    if (lower.includes(phrase)) return null;
  }
  // Reject single standalone numbers at start (like "0")
  if (/^(?:0|00|000)\s/.test(clean)) return null;
  // Reject if has too many leading numbers (property stats not cleaned)
  if (/^\d{3,}\s+\d+\s/.test(clean)) return null;
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

// Check if a property card is for sale (not sold)
function _isForSaleCard(card) {
  const text = (card.innerText || "").toLowerCase();
  // Look for "for sale" badges/labels but NOT "sold"
  if (text.includes("sold") || text.includes("pending") || text.includes("under contract")) return false;
  // Positive indicators
  return text.includes("for sale") || text.includes("active") || 
         card.querySelector('[class*="for-sale"], [class*="active"], [class*="status-forsale"]');
}

// Check if a property card is sold
function _isSoldCard(card) {
  const text = (card.innerText || "").toLowerCase();
  return text.includes("sold") || text.includes("past sale") || text.includes("recently sold");
}

// Collect all homedetails links from a container, deduped by href.
function _homedetailsLinks(container) {
  return Array.from(container.querySelectorAll('a[href*="/homedetails/"]'));
}

// Collect homedetails links that are NOT in a "sold" section
function _forSaleLinks(container) {
  const links = [];
  const soldKeywords = ['sold', 'past sale', 'recently sold'];
  
  for (const link of _homedetailsLinks(container)) {
    // Check if this link is inside a sold element
    let inSoldSection = false;
    let parent = link.closest('section, div, li, article');
    while (parent && parent !== container) {
      const text = (parent.innerText || "").toLowerCase();
      if (soldKeywords.some(k => text.includes(k))) {
        inSoldSection = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!inSoldSection) links.push(link);
  }
  return links;
}

// Collect links from "sold" labeled sections only
function _soldLinks(container) {
  const links = [];
  const soldKeywords = ['sold', 'past sale', 'recently sold'];
  
  for (const link of _homedetailsLinks(container)) {
    let inSoldSection = false;
    let parent = link.closest('section, div, li, article');
    while (parent && parent !== container) {
      const text = (parent.innerText || "").toLowerCase();
      if (soldKeywords.some(k => text.includes(k))) {
        inSoldSection = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (inSoldSection) links.push(link);
  }
  return links;
}

// Get all property cards and their status
function _getPropertyCards(container) {
  const cards = container.querySelectorAll("article, [class*='property-card'], [class*='listing-card'], [class*='listing'], li");
  const result = [];
  for (const card of cards) {
    const text = (card.innerText || "").toLowerCase();
    const hrefs = Array.from(card.querySelectorAll('a[href*="/homedetails/"]')).map(a => a.href);
    if (hrefs.length > 0 || text.length > 50) {
      result.push({ card, text, hrefs });
    }
  }
  return result;
}

// Extract address from a single property card based on its status
function _addressFromCard(card) {
  const text = card.innerText || "";
  const hrefs = card.querySelectorAll('a[href*="/homedetails/"]');
  
  // First try URL slug
  for (const link of hrefs) {
    const addr = _addressFromUrl(link.href);
    if (addr) return addr;
  }
  
  // Then try card text
  return _bestMatch(text);
}

// Collect all listing links (various Zillow URL patterns)
function _listingLinks(container) {
  const patterns = [
    '/homedetails/',
    '/b/',
    '/mlsid/',
    '/listing/',
  ];
  return Array.from(container.querySelectorAll('a[href]')).filter(a => 
    patterns.some(p => a.href.includes(p))
  );
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

  // Strategy 0: Card-based extraction - find cards explicitly marked "For Sale"
  const cards = searchArea.querySelectorAll("article, [class*='property-card'], [class*='listing-card'], [class*='listing'], li");
  for (const card of cards) {
    const text = (card.innerText || "").toLowerCase();
    // Skip sold cards
    if (text.includes("sold") || text.includes("past sale") || text.includes("pending")) continue;
    // Only use cards with "for sale" indicator
    if (text.includes("for sale") || text.includes("active")) {
      const addr = _addressFromCard(card);
      if (addr) return addr;
    }
  }

  // Strategy 1: Parse address from homedetails URL slug (most reliable)
  // Only use links NOT in a "sold" section
  for (const link of _forSaleLinks(searchArea)) {
    const addr = _addressFromUrl(link.href);
    if (addr) return addr;
  }

  // Strategy 2: Try link innerText (card text contains address among other info)
  for (const link of _forSaleLinks(searchArea)) {
    const addr = _bestMatch(link.innerText || "");
    if (addr) return addr;
  }

  // Strategy 3: Try other listing URLs (b/, mlsid/, etc.)
  for (const link of _listingLinks(searchArea)) {
    const href = link.href || "";
    const addr = _addressFromUrl(href);
    if (addr) return addr;
    
    const addrText = _bestMatch(link.innerText || "");
    if (addrText) return addrText;
  }

  // Strategy 4: Look for address in JSON data embedded in the page
  const jsonAddr = extractAddressFromJson(document.body);
  if (jsonAddr) return jsonAddr;

  // Strategy 5: Look for address in data attributes
  const dataAddr = extractAddressFromDataAttrs(searchArea);
  if (dataAddr) return dataAddr;

  // Strategy 6: Text elements in the section (h3, h4, span, p, address)
  for (const el of searchArea.querySelectorAll("h3, h4, address, span, p")) {
    if (el.closest('[id*="about"], [class*="about"], [class*="bio"]')) continue;
    // Skip if in a sold section
    if (el.closest('[class*="sold"], [class*="past"], [id*="sold"]')) continue;
    const addr = _bestMatch(el.innerText || "");
    if (addr) return addr;
  }

  // Strategy 7: Any link with address-like text in the for-sale section
  for (const link of searchArea.querySelectorAll('a[href]')) {
    // Skip sold section links
    let inSold = false;
    let parent = link.closest('section, div, li, article');
    while (parent && parent !== searchArea) {
      const text = (parent.innerText || "").toLowerCase();
      if (text.includes("sold") || text.includes("past sale")) {
        inSold = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (inSold) continue;
    
    const txt = link.innerText || "";
    const addr = _bestMatch(txt);
    if (addr) return addr;
  }

  // Strategy 8: Search for addresses in script tags containing listing data
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || "";
    const addr = _bestMatch(text);
    if (addr && addr.length > 5) return addr;
  }

  // Strategy 9: Look for address pills/chips in the listing cards
  const chips = searchArea.querySelectorAll('[class*="address"], [class*="street"], [class*="label"], .chip, .pill');
  for (const chip of chips) {
    const txt = chip.innerText || "";
    const addr = _bestMatch(txt);
    if (addr && addr.length > 8) return addr;
  }

  // Strategy 10: Look in the full search area if nothing found yet
  const allAddr = _bestMatch(document.body.innerText);
  if (allAddr && allAddr.length > 10) return allAddr;

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

  // Strategy 0: Card-based extraction - find cards explicitly marked "Sold"
  const cards = searchArea.querySelectorAll("article, [class*='property-card'], [class*='listing-card'], [class*='listing'], li");
  for (const card of cards) {
    const text = (card.innerText || "").toLowerCase();
    // Only use cards with "sold" indicator
    if (text.includes("sold") || text.includes("past sale") || text.includes("recently sold")) {
      const addr = _addressFromCard(card);
      if (addr && addr.toLowerCase() !== forSaleClean) return addr;
    }
  }

  // Strategy 1: Use only links from "sold" labeled sections
  const soldLinks = _soldLinks(searchArea);
  
  for (const link of soldLinks) {
    const addr = _addressFromUrl(link.href);
    if (addr && addr.toLowerCase() !== forSaleClean) return addr;
  }
  
  for (const link of soldLinks) {
    const addr = _bestMatch(link.innerText || "");
    if (addr && addr.toLowerCase() !== forSaleClean) return addr;
  }

  // Strategy 2: Cards explicitly labelled "Sold" / "Past Sale"
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

  // Strategy 3: All homedetails links in reverse (sold listings appear lower)
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

  // Strategy 4: Try other listing URLs (b/, mlsid/, etc.) in sold section
  for (const link of _listingLinks(searchArea)) {
    // Only use if in sold section
    let inSold = false;
    let parent = link.closest('section, div, li, article');
    while (parent && parent !== searchArea) {
      const text = (parent.innerText || "").toLowerCase();
      if (text.includes("sold") || text.includes("past sale")) {
        inSold = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!inSold) continue;
    
    const href = link.href || "";
    const addr = _addressFromUrl(href);
    if (addr && addr.toLowerCase() !== forSaleClean) return addr;
    
    const addrText = _bestMatch(link.innerText || "");
    if (addrText && addrText.toLowerCase() !== forSaleClean) return addrText;
  }

  // Strategy 5: Look for address in JSON data
  const jsonAddr = extractAddressFromJson(searchArea);
  if (jsonAddr && jsonAddr.toLowerCase() !== forSaleClean) return jsonAddr;

  // Strategy 6: Look for address in data attributes
  const dataAddr = extractAddressFromDataAttrs(searchArea);
  if (dataAddr && dataAddr.toLowerCase() !== forSaleClean) return dataAddr;

  // Strategy 7: Search for "Sold" or address patterns in text
  const text = searchArea.innerText || "";
  const addr = _bestMatch(text);
  if (addr && addr.toLowerCase() !== forSaleClean) return addr;

  // Strategy 8: Any address link in the sold section
  for (const link of searchArea.querySelectorAll('a[href]')) {
    let inSold = false;
    let parent = link.closest('section, div, li, article');
    while (parent && parent !== searchArea) {
      const text = (parent.innerText || "").toLowerCase();
      if (text.includes("sold") || text.includes("past sale")) {
        inSold = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!inSold) continue;
    
    const txt = link.innerText || "";
    const addr2 = _bestMatch(txt);
    if (addr2 && addr2.toLowerCase() !== forSaleClean) return addr2;
  }

  // Strategy 9: Look for address pills/chips in sold listing cards
  const chips = searchArea.querySelectorAll('[class*="address"], [class*="street"], [class*="label"], .chip, .pill');
  for (const chip of chips) {
    const txt = chip.innerText || "";
    const addr = _bestMatch(txt);
    if (addr && addr.length > 8 && addr.toLowerCase() !== forSaleClean) return addr;
  }

  // Strategy 10: Look in the full search area if nothing found yet
  const allAddr = _bestMatch(document.body.innerText);
  if (allAddr && allAddr.length > 10 && allAddr.toLowerCase() !== forSaleClean) return allAddr;

  return null;
}

// ── JSON address extraction ───────────────────────────────────────────────
function extractAddressFromJson(container) {
  // Look for JSON-LD structured data
  const scripts = container.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const addr = findAddressInJson(data);
      if (addr) return addr;
    } catch (_) {}
  }

  // Look for window.__NEXT_DATA__ or similar
  const nextData = document.querySelector('script[id*="__NEXT_DATA__"]');
  if (nextData) {
    try {
      const data = JSON.parse(nextData.textContent);
      const addr = findAddressInJson(data);
      if (addr) return addr;
    } catch (_) {}
  }

  // Look for address in data-* attributes on elements
  const elements = container.querySelectorAll('[data-address], [data-street], [data-hdp-url]');
  for (const el of elements) {
    const addr = el.getAttribute('data-address') || el.getAttribute('data-street') || "";
    if (addr) {
      const cleaned = _bestMatch(addr);
      if (cleaned) return cleaned;
    }
    
    // Check data-hdp-url for homedetails URL
    const hdpUrl = el.getAttribute('data-hdp-url') || el.getAttribute('data-url') || "";
    if (hdpUrl.includes('/homedetails/')) {
      const addrFromUrl = _addressFromUrl(hdpUrl);
      if (addrFromUrl) return addrFromUrl;
    }
  }

  return null;
}

function findAddressInJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  
  // Check common address fields
  const fields = ['streetAddress', 'address', 'addressLocality', 'addressRegion'];
  for (const field of fields) {
    if (obj[field]) {
      const val = String(obj[field]).trim();
      const addr = _bestMatch(val);
      if (addr) return addr;
    }
  }

  // Recurse into nested objects
  for (const key of Object.keys(obj)) {
    if (key === 'address' && typeof obj[key] === 'object') {
      const addr = findAddressInJson(obj[key]);
      if (addr) return addr;
    }
    if (Array.isArray(obj[key])) {
      for (const item of obj[key]) {
        const addr = findAddressInJson(item);
        if (addr) return addr;
      }
    }
  }

  return null;
}

function extractAddressFromDataAttrs(container) {
  // Search for various data attributes that might contain addresses
  const selectors = [
    '[data-address]',
    '[data-street-address]',
    '[data-street]',
    '[data-hdp-url]',
    '[data-url]',
    '[data-lat]',
    '[data-lng]',
  ];

  for (const sel of selectors) {
    const el = container.querySelector(sel);
    if (!el) continue;

    // Check direct attributes
    for (const attr of el.attributes) {
      const val = attr.value || "";
      if (val.includes('/homedetails/')) {
        const addr = _addressFromUrl(val);
        if (addr) return addr;
      }
      const addr = _bestMatch(val);
      if (addr && addr.length > 8) return addr;
    }

    // Check innerText
    const txt = el.innerText || "";
    const addr = _bestMatch(txt);
    if (addr && addr.length > 8) return addr;
  }

  return null;
}
