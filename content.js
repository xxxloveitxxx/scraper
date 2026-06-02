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

// Block booking platforms that don't have useful contact info
const bookingDomains = [
  'servicetitan.com', 'booksy.com', 'schedulicity.com', 'square.site',
  'bookwhen.com', 'takeshape.io', 'acuityscheduling.com', 'calendly.com',
  'homeadvisor.com', 'angieslist.com', 'thumbtack.com', 'porch.com',
  'handyman.com', 'taskrabbit.com', 'houzz.com/pro',
  'getjobber.com', 'jobber.com', 'book.johnson.com', 'book.service.com',
  'clienthub.getjobber.com', 'app.getjobber.com', 'bookings.booking.com',
  'housecallpro.com', 'book.housecallpro.com'
];

function isBookingPlatform(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return bookingDomains.some(d => lower.includes(d));
}

// Check if URL looks like a booking page
function isLikelyBookingPage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  const bookingPaths = ['/book', '/book-online', '/schedule', '/appointments', '/reserve', '/booking', '/request'];
  return bookingPaths.some(p => lower.includes(p));
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
  
  const websiteResult = extractWebsite(html, text);
  
  return {
    name: extractName(),
    category: extractCategory(),
    rating: extractRating(),
    review_count: extractReviewCount(),
    address: extractAddress(),
    phone: extractPhone(),
    website: websiteResult?.primaryUrl || null,
    website_urls: websiteResult?.allUrls || [],
    services: extractServices(),
    about: extractAbout(),
    hours: extractBusinessHours(),
    service_area: extractServiceArea(),
    owner: extractOwner(),
    years_in_business: extractYearsInBusiness(),
    profile_url: window.location.href.split('?')[0],
    scraped_at: new Date().toISOString(),
  };
}

function extractServiceArea() {
  const text = document.body?.innerText || '';
  
  // Try to find service area section with exact attribute
  const sections = document.querySelectorAll('[data-section-details]');
  for (const section of sections) {
    const sectionType = section.getAttribute('data-section-details') || '';
    if (sectionType.toLowerCase().includes('service area') || sectionType.includes('SERVICE_AREA')) {
      const sectionText = section.innerText;
      if (sectionText && !sectionText.includes('Street View') && sectionText.length > 10) {
        return sectionText.replace(/\s+/g, ' ').trim().substring(0, 500);
      }
    }
  }
  
  // Try looking for service area patterns in text - but exclude Street View
  const patterns = [
    /service area[s]?[:\s]+([^.!\n]{20,300})/i,
    /areas? served[:\s]+([^.!\n]{20,300})/i,
    /serving[:\s]+([^.!\n]{20,300})/i,
    /coverage[:\s]+([^.!\n]{20,300})/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && !match[1].includes('Street View')) {
      return match[1].trim().substring(0, 300);
    }
  }
  
  return null;
}

function extractOwner() {
  const text = document.body?.innerText || '';
  
  // Try to find owner section
  const sections = document.querySelectorAll('[data-section-details]');
  for (const section of sections) {
    const sectionType = section.getAttribute('data-section-details') || '';
    if (sectionType.toLowerCase().includes('owner')) {
      const sectionText = section.innerText;
      if (sectionText && sectionText.length > 2) {
        return sectionText.replace(/^owner\s*/i, '').trim().substring(0, 200);
      }
    }
  }
  
  // Try text patterns
  const patterns = [
    /owner[:\s]+([^.!\n]{5,100})/i,
    /managed by[:\s]+([^.!\n]{5,100})/i,
    /founded by[:\s]+([^.!\n]{5,100})/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return null;
}

function extractYearsInBusiness() {
  const text = document.body?.innerText || '';
  
  // Try to find years in business
  const patterns = [
    /(\d+)\+?\s*years?\s*(?:in\s*business|of\s*experience|of\s*service)/i,
    /established[:\s]+(?:in\s+)?(\d{4})/i,
    /since\s+(\d{4})/i,
    /(\d+)\+?\s*yrs?\s*(?:in\s*business|of\s*experience)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

function extractServices() {
  const html = document.documentElement?.innerHTML || '';
  
  // Try to find services section from data attributes
  const servicesSection = document.querySelector('[data-section-details="SERVICES"]');
  if (servicesSection) {
    const serviceItems = servicesSection.querySelectorAll('li, span');
    if (serviceItems.length > 0) {
      const services = serviceItems.map(item => item.innerText?.trim()).filter(Boolean);
      if (services.length > 0) {
        return services.join(' | ').substring(0, 1000);
      }
    }
    // If no items found, get the text but exclude review text
    const sectionText = servicesSection.innerText;
    if (sectionText && !sectionText.includes('called them up') && !sectionText.includes('review')) {
      return sectionText.replace(/\s+/g, ' ').trim().substring(0, 1000);
    }
  }
  
  // Try to find from specific section containers
  const sectionHeaders = document.querySelectorAll('div[aria-label*="Services"]');
  for (const section of sectionHeaders) {
    const items = section.querySelectorAll('li, button, span');
    if (items.length > 0) {
      const services = [];
      items.forEach(item => {
        const text = item.innerText?.trim();
        if (text && text.length < 100 && !text.includes('called') && !text.includes('review')) {
          services.push(text);
        }
      });
      if (services.length > 0) {
        return services.join(' | ').substring(0, 1000);
      }
    }
  }
  
  return null;
}

function extractAbout() {
  const html = document.documentElement?.innerHTML || '';
  
  // Try to find about/overview section
  const aboutSection = document.querySelector('[data-section-details="OVERVIEW"]');
  if (aboutSection) {
    const aboutText = aboutSection.innerText;
    if (aboutText && aboutText.length > 10 && !aboutText.includes('called them') && !aboutText.includes('review')) {
      return aboutText.replace(/^overview\s*/i, '').trim().substring(0, 1500);
    }
  }
  
  // Try to find description paragraphs - exclude review content
  const paragraphs = document.querySelectorAll('div[aria-label*="About"], div[class*="description"], div[class*="about"]');
  for (const p of paragraphs) {
    const text = p.innerText?.trim();
    if (text && text.length > 20 && text.length < 1500 && !text.includes('called') && !text.includes('review')) {
      return text;
    }
  }
  
  // Try extracting from JSON-LD structured data
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      if (data.description && !data.description.includes('called')) {
        return data.description.substring(0, 1500);
      }
    } catch (e) {}
  }
  
  return null;
}

function extractBusinessHours() {
  // Look for hours section
  const hoursSection = document.querySelector('[data-section-details="HOURS"]');
  if (hoursSection) {
    const hoursText = hoursSection.innerText;
    if (hoursText && hoursText.length > 10) {
      return hoursText.replace(/\s+/g, ' ').trim().substring(0, 500);
    }
  }
  
  // Try table format
  const tableRows = document.querySelectorAll('table tr, tr.table-row');
  if (tableRows.length > 0) {
    const hours = [];
    tableRows.forEach(row => {
      const cells = row.querySelectorAll('td, span');
      if (cells.length >= 2) {
        const day = cells[0]?.innerText?.trim();
        const time = cells[1]?.innerText?.trim();
        if (day && time && !day.includes('Hours')) {
          hours.push(`${day}: ${time}`);
        }
      }
    });
    if (hours.length > 0) {
      return hours.join(' | ').substring(0, 500);
    }
  }
  
  // Try extracting from JSON data in HTML
  const html = document.documentElement?.innerHTML || '';
  const hoursMatch = html.match(/"openingHours"\s*:\s*\[([^\]]+)\]/);
  if (hoursMatch) {
    return hoursMatch[1].replace(/"/g, '').trim();
  }
  
  return null;
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
  // Try breadcrumb
  const crumb = document.querySelector('.bwoYtf');
  if (crumb) return crumb.innerText.trim();
  
  // Try header span
  const headerSpan = document.querySelector('span[class*="category"]');
  if (headerSpan) return headerSpan.innerText.trim();
  
  // Try secondary text in the listing
  const html = document.documentElement?.innerHTML || '';
  const categoryMatch = html.match(/"category"\s*:\s*"([^"]+)"/i);
  if (categoryMatch) return categoryMatch[1].trim();
  
  return null;
}

function extractRating() {
  const html = document.documentElement?.innerHTML || '';
  
  // Try JSON data in the page
  const ratingMatch = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)/);
  if (ratingMatch) return parseFloat(ratingMatch[1]);
  
  // Try meta tag
  const meta = document.querySelector('meta[itemprop="ratingValue"]');
  if (meta?.content) return parseFloat(meta.content);
  
  // Try visible rating display
  const ratingEl = document.querySelector('[aria-label*="stars"], [class*="rating"], .fontBodyMedium span[aria-hidden]');
  if (ratingEl) {
    const text = ratingEl.getAttribute('aria-label') || ratingEl.innerText;
    const match = text.match(/(\d+\.?\d*)/);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

function extractReviewCount() {
  const html = document.documentElement?.innerHTML || '';
  
  // Try JSON data
  const match = html.match(/"reviewCount"\s*:\s*"?(\d+)/);
  if (match) return parseInt(match[1]);
  
  // Try meta tag
  const meta = document.querySelector('meta[itemprop="reviewCount"]');
  if (meta?.content) return parseInt(meta.content);
  
  // Try visible text
  const reviewEl = document.querySelector('[aria-label*="review"]');
  if (reviewEl) {
    const text = reviewEl.getAttribute('aria-label') || reviewEl.innerText;
    const numMatch = text.match(/(\d+)/);
    if (numMatch) return parseInt(numMatch[1]);
  }
  
  return null;
}

function extractAddress() {
  // Try data attribute first
  const addr = document.querySelector('[data-item-type="address"]');
  if (addr) return addr.innerText.trim();
  
  // Try button/link with address-like content
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.innerText?.trim() || '';
    // Valid addresses have numbers, street names, and city/state/zip
    if (text.includes(',') && /\d/.test(text) && 
        (text.includes('United States') || text.includes('USA') || 
         /\b[A-Z]{2}\b/.test(text)) && // State abbreviation
        text.length > 10 && text.length < 200) {
      return text.replace(/\s+/g, ' ');
    }
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
  // Collect all potential website URLs first
  const candidates = [];
  const seenUrls = new Set();
  
  // 1. Try [data-item-type="website"] a
  const webA = document.querySelector('[data-item-type="website"] a');
  if (webA?.href) {
    const url = cleanUrl(webA.href);
    if (url && !isGoogleDomain(url) && url.includes('.') && !seenUrls.has(url)) {
      seenUrls.add(url);
      candidates.push({ url, priority: isBookingPlatform(url) ? 0 : 10, isBooking: isBookingPlatform(url) });
    }
  }
  
  // 2. Try buttons with "website" in data-value or aria-label
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const dataValue = btn.getAttribute('data-value') || '';
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const btnText = btn.innerText || '';
    if (dataValue.toLowerCase().includes('website') || 
        ariaLabel.toLowerCase().includes('website') ||
        btnText.toLowerCase().includes('visit website')) {
      const a = btn.querySelector('a');
      if (a?.href) {
        const url = cleanUrl(a.href);
        if (url && !isGoogleDomain(url) && url.includes('.') && !seenUrls.has(url)) {
          seenUrls.add(url);
          candidates.push({ url, priority: isBookingPlatform(url) ? 0 : 10, isBooking: isBookingPlatform(url) });
        }
      }
      const onclick = btn.getAttribute('onclick') || '';
      const m = onclick.match(/url=([^&"]+)/);
      if (m) {
        const url = cleanUrl(m[1]);
        if (url && !isGoogleDomain(url) && !seenUrls.has(url)) {
          seenUrls.add(url);
          candidates.push({ url, priority: isBookingPlatform(url) ? 0 : 10, isBooking: isBookingPlatform(url) });
        }
      }
    }
  }
  
  // 3. Search in innerHTML for website URLs
  const htmlMatch = html.match(/"websiteUrl"\s*:\s*"([^"]+)"/);
  if (htmlMatch) {
    const url = cleanUrl(htmlMatch[1]);
    if (url && !isGoogleDomain(url) && !isBookingPlatform(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      candidates.push({ url, priority: 10, isBooking: false });
    }
  }
  
  // 4. Look for URLs in the page data
  const dataUrlMatch = html.match(/https?:\/\/[a-zA-Z0-9][a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s"'<>]+/g);
  if (dataUrlMatch) {
    for (const url of dataUrlMatch) {
      const clean = cleanUrl(url);
      if (clean && !isGoogleDomain(clean) && !isBookingPlatform(clean) && 
          !clean.includes('google.com') && !clean.includes('g.co') &&
          (clean.includes('.com') || clean.includes('.org') || clean.includes('.net') || clean.includes('.io')) &&
          !seenUrls.has(clean)) {
        if (!clean.includes('maps.google') && !clean.includes('support.google') && !clean.includes('accounts.google')) {
          seenUrls.add(clean);
          const baseUrl = clean.split('?')[0];
          candidates.push({ url: baseUrl, priority: isLikelyBookingPage(baseUrl) ? 3 : 7, isBooking: false });
        }
      }
    }
  }
  
  // 5. Try links with "Website" text nearby
  const websiteLinks = document.querySelectorAll('a[href*="http"]');
  for (const link of websiteLinks) {
    const href = cleanUrl(link.href);
    if (href && !isGoogleDomain(href) && href.includes('.') && !isBookingPlatform(href) && !seenUrls.has(href)) {
      const linkText = link.innerText?.toLowerCase() || '';
      const parentText = link.closest('div')?.innerText?.toLowerCase() || '';
      if (linkText.includes('website') || linkText.includes('visit') || 
          parentText.includes('website') || linkText.match(/\.(com|org|net|io|us)/)) {
        seenUrls.add(href);
        const priority = isLikelyBookingPage(href) ? 2 : 5;
        candidates.push({ url: href, priority, isBooking: false });
      }
    }
  }
  
  // 6. Try any external link with target="_blank"
  const links = document.querySelectorAll('a[target="_blank"]');
  for (const link of links) {
    const href = cleanUrl(link.href);
    if (href && !isGoogleDomain(href) && href.includes('.') && !isBookingPlatform(href) && !seenUrls.has(href)) {
      seenUrls.add(href);
      const priority = isLikelyBookingPage(href) ? 1 : 4;
      candidates.push({ url: href, priority, isBooking: false });
    }
  }
  
  // 7. Last resort - look for any non-Google domain link
  const allLinks = document.querySelectorAll('a[href]');
  for (const link of allLinks) {
    const href = cleanUrl(link.href);
    if (href && !isGoogleDomain(href) && !isBookingPlatform(href) && 
        (href.includes('.com/') || href.includes('.org/') || href.includes('.net/')) && !seenUrls.has(href)) {
      seenUrls.add(href);
      candidates.push({ url: href.split('?')[0], priority: isLikelyBookingPage(href) ? 0 : 3, isBooking: false });
    }
  }
  
  // Sort by priority (highest first), prefer root URLs over booking pages
  candidates.sort((a, b) => b.priority - a.priority);
  
  // Build list of unique base domains + paths to scrape
  const allUrls = [];
  const seenBaseDomains = new Set();
  
  for (const candidate of candidates) {
    if (candidate.priority > 0 && !candidate.isBooking) {
      // Extract base URL (domain + root path)
      const url = candidate.url;
      try {
        const parsed = new URL(url);
        const baseDomain = parsed.origin;
        
        if (!seenBaseDomains.has(baseDomain)) {
          seenBaseDomains.add(baseDomain);
          // Add base domain
          allUrls.push(baseDomain);
          // Also add booking pages if they exist
          if (isLikelyBookingPage(url) && url !== baseDomain) {
            allUrls.push(url.split('?')[0]);
          }
        }
      } catch (e) {}
    }
  }
  
  // Get primary URL (highest priority non-booking)
  let primaryUrl = null;
  for (const candidate of candidates) {
    if (candidate.priority > 0 && !candidate.isBooking) {
      primaryUrl = candidate.url;
      break;
    }
  }
  
  return { primaryUrl, allUrls };
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
  
  // All emails - with better validation
  const emails = [];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi;
  (html.match(emailRegex) || []).forEach(email => {
    const clean = email.toLowerCase();
    // Skip if it looks like an image filename (quick_facts@2x.webp)
    if (clean.includes('@2x') || clean.includes('@') && (clean.includes('.webp') || clean.includes('.jpg') || clean.includes('.png') || clean.includes('.gif') || clean.includes('.svg'))) return;
    // Skip placeholder emails
    if (clean.includes('example') || clean.includes('test') || clean.includes('domain') || clean.includes('noreply') || clean.includes('placeholder')) return;
    // Make sure it looks like a real email
    if (!emails.includes(clean) && emails.length < 30 && clean.match(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/)) {
      emails.push(clean);
    }
  });
  
  // Social links (including X/Twitter)
  const socialLinks = [];
  const socialDomains = [
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'linkedin.com', 'yelp.com', 'houzz.com', 'youtube.com', 
    'tiktok.com', 'pinterest.com'
  ];
  
  document.querySelectorAll('a[href]').forEach(a => {
    const href = (a.getAttribute('href') || '').toLowerCase();
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