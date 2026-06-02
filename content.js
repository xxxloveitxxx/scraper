// content.js - Google Maps + Website Scraper

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extractLinks') {
    sendResponse({ links: extractBusinessLinks(), blocked: isBlockPage() });
  }
  if (msg.action === 'extractProfile') {
    sendResponse({ data: extractBusinessData(), blocked: isBlockPage() });
  }
  if (msg.action === 'extractWebsiteData') {
    sendResponse({ data: extractWebsiteData(), blocked: isBlockPage() });
  }
  return true;
});

function isBlockPage() {
  return (document.body?.innerText?.toLowerCase() || '').includes('access denied');
}

function isGoogleDomain(url) {
  if (!url) return true;
  const domains = ['google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com', 'doubleclick.net', 'google-analytics.com'];
  return domains.some(d => (url || '').toLowerCase().includes(d));
}

function cleanUrl(url) {
  if (!url) return null;
  try {
    let clean = url.replace(/^https:\/\/www\.google\.com\/url\?q=/, '');
    clean = clean.split('&')[0];
    clean = decodeURIComponent(clean);
    return clean;
  } catch { return url; }
}

// PHASE 1: Extract business links
function extractBusinessLinks() {
  const links = new Set();
  document.querySelectorAll('[data-cid], .Nv2PK').forEach(card => {
    const a = card.querySelector('a[href*="/maps/place/"]');
    if (a) links.add(a.href.split('?')[0]);
  });
  document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
    links.add(a.href.split('?')[0]);
  });
  return Array.from(links);
}

// PHASE 1: Extract business data
function extractBusinessData() {
  const html = document.documentElement?.innerHTML || '';
  const text = document.body?.innerText || '';
  
  return {
    name: extractName(),
    category: extractCategory(),
    rating: extractRating(),
    review_count: extractReviewCount(),
    address: extractAddress(),
    phone: extractPhone(),
    website: extractWebsite(html, text),
    profile_url: window.location.href.split('?')[0],
    scraped_at: new Date().toISOString(),
  };
}

function extractName() {
  const h1 = document.querySelector('h1');
  if (h1) {
    const name = h1.innerText.trim().split('\n')[0];
    if (name && name.length < 100) return name;
  }
  const og = document.querySelector('meta[property="og:title"]');
  if (og?.content) return og.content.split(' - ')[0].split('|')[0].trim();
  return null;
}

function extractCategory() {
  const crumb = document.querySelector('.bwoYtf');
  if (crumb) return crumb.innerText.trim();
  return null;
}

function extractRating() {
  const html = document.documentElement?.innerHTML || '';
  const m = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)/);
  if (m) return parseFloat(m[1]);
  const meta = document.querySelector('meta[itemprop="ratingValue"]');
  if (meta?.content) return parseFloat(meta.content);
  return null;
}

function extractReviewCount() {
  const html = document.documentElement?.innerHTML || '';
  const m = html.match(/"reviewCount"\s*:\s*"?(\d+)/);
  if (m) return parseInt(m[1]);
  const meta = document.querySelector('meta[itemprop="reviewCount"]');
  if (meta?.content) return parseInt(meta.content);
  return null;
}

function extractAddress() {
  const addr = document.querySelector('[data-item-type="address"]');
  if (addr) return addr.innerText.trim();
  const btns = document.querySelectorAll('button');
  for (const b of btns) {
    const t = b.innerText?.trim() || '';
    if (t.includes(',') && t.length > 5 && /\d/.test(t) && !t.includes('°')) return t;
  }
  return null;
}

function extractPhone() {
  const phone = document.querySelector('[data-item-type="phone"]');
  if (phone) return phone.innerText?.trim();
  const tel = document.querySelector('a[href^="tel:"]');
  if (tel) return tel.href.replace('tel:', '').trim();
  return null;
}

function extractWebsite(html, text) {
  // Try website button
  const webA = document.querySelector('[data-item-type="website"] a');
  if (webA?.href) {
    const url = cleanUrl(webA.href);
    if (url && !isGoogleDomain(url) && url.includes('.')) return url;
  }
  
  // Try button with onclick
  const webBtn = document.querySelector('button[data-value="website"]');
  if (webBtn) {
    const onclick = webBtn.getAttribute('onclick') || '';
    const m = onclick.match(/url=([^&"]+)/);
    if (m) {
      const url = cleanUrl(m[1]);
      if (url && !isGoogleDomain(url)) return url;
    }
  }
  
  // Try any external links
  const links = document.querySelectorAll('a[target="_blank"]');
  for (const link of links) {
    const href = cleanUrl(link.href);
    if (href && !isGoogleDomain(href) && href.includes('.')) return href;
  }
  
  return null;
}

// PHASE 2: Extract emails and social links from websites
function extractWebsiteData() {
  const html = document.documentElement?.innerHTML || '';
  const text = document.body?.innerText || '';
  
  // Primary email from mailto
  let primaryEmail = null;
  document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
    const email = link.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (email.includes('@') && email.length > 5 && !primaryEmail) primaryEmail = email;
  });
  
  // All emails
  const emails = [];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi;
  (html.match(emailRegex) || []).forEach(email => {
    const clean = email.toLowerCase();
    if (clean.includes('@') && !emails.includes(clean) && 
        !clean.includes('example') && !clean.includes('test') && 
        !clean.includes('domain') && !clean.includes('noreply') &&
        emails.length < 30) {
      emails.push(clean);
    }
  });
  
  // Social links (including X/Twitter)
  const socialLinks = [];
  const socialDomains = [
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com',  // X/Twitter
    'linkedin.com', 'yelp.com', 'houzz.com', 'youtube.com', 
    'tiktok.com', 'pinterest.com'
  ];
  
  document.querySelectorAll('a[href]').forEach(a => {
    const href = (a.href || '').toLowerCase();
    for (const domain of socialDomains) {
      if (href.includes(domain) && !socialLinks.includes(href)) {
        socialLinks.push(href);
      }
    }
  });
  
  // Extract X/Twitter handle specifically
  let twitterHandle = null;
  const twitterPatterns = [
    /twitter\.com\/([a-zA-Z0-9_]+)/i,
    /x\.com\/([a-zA-Z0-9_]+)/i,
    /tweet\/([a-zA-Z0-9_]+)/i,
  ];
  
  for (const pattern of twitterPatterns) {
    const matches = html.match(pattern);
    if (matches) {
      const handle = matches[1];
      if (handle && handle !== 'share' && handle !== 'intent' && handle !== 'home') {
        twitterHandle = '@' + handle;
        break;
      }
    }
  }
  
  // Also check text for Twitter handles
  if (!twitterHandle) {
    const handleMatch = text.match(/@[a-zA-Z0-9_]{3,15}/g);
    if (handleMatch) {
      for (const h of handleMatch) {
        if (!h.includes('example') && !h.includes('test')) {
          twitterHandle = h;
          break;
        }
      }
    }
  }
  
  return {
    email: primaryEmail,
    emails: emails,
    social_links: socialLinks,
    twitter_handle: twitterHandle,
  };
}