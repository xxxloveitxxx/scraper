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
function isBlockPage() {
  const body = document.body?.innerText?.toLowerCase() || "";
  const title = document.title?.toLowerCase() || "";
  return (
    body.includes("access denied") ||
    body.includes("unusual traffic") ||
    body.includes("captcha") ||
    body.includes("robot") ||
    body.includes("blocked") ||
    body.includes("verify you are human") ||
    body.includes("press and hold") ||
    body.includes("press & hold") ||
    title.includes("access denied") ||
    title.includes("attention required")
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
      // Clean up URL
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
  const md = document.body?.innerText || "";
  const html = document.documentElement?.innerHTML || "";

  const forSaleAddr = extractForSaleAddress();
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
    about:               extractAbout(md),
    for_sale_count:      extractForSaleCount(md),
    for_sale_address:    forSaleAddr,
    recent_sale_address: recentSaleAddr,
    profile_url:         window.location.href.replace(/[)/]+$/, "").replace(/\/+$/, "") + "/",
    scraped_at:          new Date().toISOString(),
  };
}

function extractName(md) {
  // H1 tag is most reliable in the actual DOM
  const h1 = document.querySelector("h1");
  if (h1) {
    const name = h1.innerText.trim();
    if (name.length > 1 && name.length < 80 && name.split(" ").length <= 7) {
      return name;
    }
  }
  // Fallback: page title before " - "
  const title = document.title;
  const titleMatch = title.match(/^([^|–\-]+?)(?:\s*[-–|])/);
  if (titleMatch) return titleMatch[1].trim();
  return null;
}

function extractLocation(md) {
  // Breadcrumb contains city link
  const breadcrumbs = document.querySelectorAll("nav a, ol a, [class*='breadcrumb'] a");
  for (const a of breadcrumbs) {
    const href = a.href || "";
    const m = href.match(/real-estate-agent-reviews\/([a-z-]+)-([a-z]{2})\//);
    if (m) {
      const city = a.innerText.trim();
      const state = m[2].toUpperCase();
      return `${city}, ${state}`;
    }
  }
  // Fallback regex
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

  // Look for Specialties section in DOM
  const bodyText = document.body?.innerText || "";
  const specMatch = bodyText.match(/Specialties\s*\n([^\n]+)/);
  if (specMatch) {
    const raw = specMatch[1];
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
  // Try DOM first — look for tel: links
  const telLink = document.querySelector("a[href^='tel:']");
  if (telLink) {
    return telLink.href.replace("tel:", "").trim();
  }
  const m = md.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  return m ? m[1].trim() : null;
}

function extractEmail(md, html) {
  // Try DOM first — mailto links
  const mailLink = document.querySelector("a[href^='mailto:']");
  if (mailLink) {
    return mailLink.href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
  }
  const m = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractAbout(md) {
  const m = md.match(/(?:Get to know|About)[^\n]*\n[-=]+\n\n([\s\S]+?)(?:\n\nSpecialties|\n\n[A-Z][^\n]{0,40}\n[-=]|$)/);
  if (m) return m[1].replace(/\n+/g, " ").trim().slice(0, 500);
  return null;
}

function extractForSaleCount(md) {
  const m = md.match(/For Sale\s*\(([\d,]+)\)/);
  return m ? parseInt(m[1].replace(/,/g, "")) : null;
}

// ── Shared address helper ─────────────────────────────────────────────────

// Broader regex to catch more street types and formats
const ADDRESS_PATTERN = /\b\d+\s+[A-Za-z0-9\s.,-]+(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Trail|Trl|Way|Pl|Place|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Square|Sq)\b/i;

function _cleanAddress(str) {
  if (!str) return null;
  return str.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractForSaleAddress() {
  // Strategy 1: Look for Zillow property links directly
  const links = Array.from(document.querySelectorAll('a[href*="/homedetails/"]'));
  for (const link of links) {
    const text = _cleanAddress(link.innerText);
    if (text && ADDRESS_PATTERN.test(text)) return text;
  }

  // Strategy 2: Deep text search using regex across standard heading/address tags
  const allTextElements = document.querySelectorAll("h3, h4, address, span, p");
  for (const el of allTextElements) {
    const text = el.innerText || "";
    const m = text.match(ADDRESS_PATTERN);
    if (m) return _cleanAddress(m[0]);
  }
  
  return null;
}

function extractRecentSaleAddress(forSaleAddr) {
  const forSaleClean = (forSaleAddr || "").toLowerCase();

  // Strategy 1: Look for "Sold" badges and grab the nearest property link
  const cards = document.querySelectorAll("article, [class*='property-card'], [class*='listing'], li");
  for (const card of cards) {
    const cardText = (card.innerText || "").toLowerCase();
    
    if (cardText.includes("sold") || cardText.includes("past sale") || cardText.includes("recently sold")) {
      const links = card.querySelectorAll('a[href*="/homedetails/"]');
      for (const link of links) {
         const addr = _cleanAddress(link.innerText);
         if (addr && ADDRESS_PATTERN.test(addr) && addr.toLowerCase() !== forSaleClean) {
           return addr;
         }
      }
      
      // Fallback: search the raw text of the "Sold" card
      const m = cardText.match(ADDRESS_PATTERN);
      if (m) {
         const addr = _cleanAddress(m[0]);
         if (addr.toLowerCase() !== forSaleClean) return addr;
      }
    }
  }

  // Strategy 2: Iterate through homedetails links in reverse (Sold properties are usually lower on the page)
  const links = Array.from(document.querySelectorAll('a[href*="/homedetails/"]')).reverse();
  for (const link of links) {
    const text = _cleanAddress(link.innerText);
    if (text && ADDRESS_PATTERN.test(text) && text.toLowerCase() !== forSaleClean) {
      return text;
    }
  }

  return null;
}