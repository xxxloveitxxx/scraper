// Content script for Clutch.co directory pages

// Extract website from company card
function extractWebsite(container) {
    const links = Array.from(container.querySelectorAll('a'));
    
    // 1. Look for the "Visit Website" link
    const trackingLink = links.find(l => l.href && l.href.includes('/visit-website'));
    
    if (trackingLink) {
        const urlParams = new URLSearchParams(new URL(trackingLink.href).search);
        const actualUrl = urlParams.get('url');
        if (actualUrl) return actualUrl;
    }

    // 2. Fallback to any outbound link
    const outboundLink = links.find(l => 
        l.href && 
        !l.href.includes('clutch.co') && 
        !l.href.includes('linkedin.com') && 
        !l.href.includes('facebook.com') && 
        !l.href.includes('twitter.com') && 
        !l.href.includes('instagram.com')
    );
    
    return outboundLink ? outboundLink.href : "Not Found";
}

// Extract company info from directory listing
function extractCompanyCard(card) {
    const nameEl = card.querySelector('h3 a, .company-name a, [data-cy="company-name"]');
    const name = nameEl ? nameEl.innerText.trim() : "";
    const profileUrl = nameEl ? nameEl.href : "";
    
    const website = extractWebsite(card);
    const ratingEl = card.querySelector('[data-cy="rating"], .rating');
    const rating = ratingEl ? ratingEl.innerText.trim() : "";
    
    const locationEl = card.querySelector('.location, [data-cy="location"]');
    const location = locationEl ? locationEl.innerText.trim() : "";
    
    return { name, profileUrl, website, rating, location };
}

// Get all company cards on current page
function getAllCompanyCards() {
    const cards = document.querySelectorAll('.directory-list .company-card, .provider-row, [data-cy="company-card"]');
    return Array.from(cards).map(extractCompanyCard);
}

// Send data to background
function reportDirectoryData() {
    const companies = getAllCompanyCards();
    chrome.runtime.sendMessage({
        action: "DIRECTORY_DATA",
        companies: companies,
        pageUrl: window.location.href,
        pageTitle: document.title
    });
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_COMPANIES") {
        const companies = getAllCompanyCards();
        sendResponse({ companies });
    }
    if (request.action === "SCRAPE_PAGE") {
        reportDirectoryData();
        sendResponse({ status: "reported" });
    }
});

// Auto-detect when directory loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(reportDirectoryData, 2000);
    });
} else {
    setTimeout(reportDirectoryData, 2000);
}

// Mutation observer for SPA navigation
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.addedNodes.length > 0) {
            const newCards = Array.from(mutation.addedNodes)
                .find(node => node.classList && (
                    node.classList.contains('directory-list') ||
                    node.classList.contains('company-card') ||
                    node.getAttribute('data-cy') === 'company-card'
                ));
            if (newCards) {
                setTimeout(reportDirectoryData, 1000);
            }
        }
    });
});

observer.observe(document.body, { childList: true, subtree: true });