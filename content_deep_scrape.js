// Content script for deep scraping individual company pages

const botMarkers = [
    "cloudflare", 
    "captcha", 
    "verify you are human", 
    "g-recaptcha", 
    "ddos-guard", 
    "access denied", 
    "403 forbidden"
];

// Check for bot detection markers
function checkBotDetection() {
    const pageText = document.body ? document.body.innerText.toLowerCase() : "";
    return botMarkers.some(marker => pageText.includes(marker));
}

// Extract company data from profile page
function extractCompanyData() {
    const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
    };

    // Extract website from tracking link
    const extractWebsite = () => {
        const links = Array.from(document.querySelectorAll('a'));
        const trackingLink = links.find(l => l.href && l.href.includes('/visit-website'));
        if (trackingLink) {
            const params = new URLSearchParams(new URL(trackingLink.href).search);
            return params.get('url') || "";
        }
        const outbound = links.find(l => 
            l.href && 
            !l.href.includes('clutch.co') && 
            !l.href.includes('linkedin.com') && 
            !l.href.includes('facebook.com') &&
            !l.href.includes('twitter.com') &&
            !l.href.includes('instagram.com')
        );
        return outbound ? outbound.href : "";
    };

    // Extract phone
    const extractPhone = () => {
        const phoneEl = document.querySelector('[href^="tel:"]');
        if (phoneEl) return phoneEl.href.replace('tel:', '');
        const phoneText = document.body.innerText.match(/(\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/);
        return phoneText ? phoneText[0] : "";
    };

    // Extract email
    const extractEmail = () => {
        const emailEl = document.querySelector('[href^="mailto:"]');
        if (emailEl) return emailEl.href.replace('mailto:', '');
        const emailMatch = document.body.innerText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return emailMatch ? emailMatch[0] : "";
    };

    // Extract address
    const extractAddress = () => {
        const addrPatterns = [
            /\d+\s+[\w\s]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane)\b/gi,
            /[\w\s]+,\s*[A-Z]{2}\s*\d{5}/gi
        ];
        for (const pattern of addrPatterns) {
            const match = document.body.innerText.match(pattern);
            if (match) return match[0].trim();
        }
        return "";
    };

    // Extract social links
    const extractSocial = () => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const social = {};
        const socialDomains = {
            linkedin: 'linkedin.com',
            twitter: 'twitter.com',
            facebook: 'facebook.com',
            instagram: 'instagram.com'
        };
        for (const [name, domain] of Object.entries(socialDomains)) {
            const link = links.find(l => l.href.includes(domain));
            if (link) social[name] = link.href;
        }
        return social;
    };

    return {
        name: getText('h1') || document.title.replace(' | Clutch', ''),
        website: extractWebsite(),
        phone: extractPhone(),
        email: extractEmail(),
        address: extractAddress(),
        social: extractSocial(),
        description: getText('[data-cy="company-description"]') || getText('.company-description') || "",
        services: Array.from(document.querySelectorAll('.services-list span, .tag')).map(el => el.textContent.trim()).filter(Boolean),
        rating: getText('[data-cy="rating"]') || "",
        reviews: getText('.review-count') || "",
        url: window.location.href,
        scrapedAt: new Date().toISOString()
    };
}

// Check and report bot detection
function reportBotStatus() {
    const isBot = checkBotDetection();
    return { isBot, url: window.location.href };
}

// Run extraction and send to background
const data = extractCompanyData();
const botStatus = reportBotStatus();

chrome.runtime.sendMessage({
    action: "SCRAPE_RESULT",
    data: data,
    isBot: botStatus.isBot,
    url: botStatus.url
});