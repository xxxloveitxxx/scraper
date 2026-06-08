// background.js - Fixed to use existing Clutch tab or create one if needed

let currentTabId = null;
let isPaused = false;
let leads = [];
let currentIndex = 0;

// Find existing Clutch tab or create new one
async function getOrCreateClutchTab() {
    const existingTabs = await chrome.tabs.query({ url: "*://*.clutch.co/*" });
    
    if (existingTabs && existingTabs.length > 0) {
        return existingTabs[0];
    }
    
    const newTab = await chrome.tabs.create({ 
        url: "https://clutch.co/agencies/digital-marketing", 
        active: false 
    });
    return newTab;
}

// Check for bot detection on a page
async function checkForBotDetection(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                const botMarkers = [
                    "cloudflare", "captcha", "verify you are human",
                    "g-recaptcha", "ddos-guard", "access denied", "403 forbidden"
                ];
                const pageText = document.body ? document.body.innerText.toLowerCase() : "";
                return botMarkers.some(marker => pageText.includes(marker));
            }
        });
        return results[0].result;
    } catch {
        return false;
    }
}

// Scrape a single company profile
async function scrapeCompany(tabId, companyUrl) {
    await chrome.tabs.update(tabId, { url: companyUrl });
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error("Timeout waiting for page load"));
        }, 30000);

        const listener = async (updatedTabId, info) => {
            if (updatedTabId === tabId && info.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                
                const isBot = await checkForBotDetection(tabId);
                if (isBot) {
                    isPaused = true;
                    chrome.runtime.sendMessage({ 
                        action: "UPDATE_STATUS", 
                        status: "PAUSED_BOT_DETECTION",
                        message: "Bot detection triggered! Click Resume to continue."
                    });
                    reject(new Error("Bot detection"));
                    return;
                }

                await new Promise(r => setTimeout(r, 2000));

                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        func: () => {
                            // Check if page loaded properly (not an error/blocked page)
                            const isErrorPage = document.title.includes('Error') || 
                                                document.body.innerText.includes('404') ||
                                                document.body.innerText.includes('Page Not Found') ||
                                                document.body.innerText.includes('access denied');
                            
                            const hasContent = document.querySelector('h1') !== null || 
                                              document.querySelector('[class*="profile"]') !== null;
                            
                            if (isErrorPage && !hasContent) {
                                return { error: true, name: "BLOCKED_PAGE" };
                            }
                            
                            // Extract company website URL
                            const extractWebsite = () => {
                                const links = Array.from(document.querySelectorAll('a'));
                                const trackingLink = links.find(l => l.href && l.href.includes('/visit-website'));
                                if (trackingLink) {
                                    const params = new URLSearchParams(new URL(trackingLink.href).search);
                                    return params.get('url') || "";
                                }
                                const outbound = links.find(l => 
                                    l.href && !l.href.includes('clutch.co') && 
                                    !l.href.includes('linkedin.com') && !l.href.includes('facebook.com') &&
                                    !l.href.includes('twitter.com') && !l.href.includes('instagram.com')
                                );
                                return outbound ? outbound.href : "";
                            };

                            // Extract email from contact section
                            const extractEmail = () => {
                                const mailto = document.querySelector('[href^="mailto:"]');
                                if (mailto) return mailto.href.replace('mailto:', '');
                                
                                const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                                const text = document.body.innerText;
                                const matches = text.match(emailPattern);
                                if (matches) {
                                    const validEmails = matches.filter(e => 
                                        !e.includes('noreply') && !e.includes('example') && !e.includes('test')
                                    );
                                    return validEmails[0] || matches[0];
                                }
                                return "";
                            };

                            // Extract phone - FIXED: properly decode and clean
                            const extractPhone = () => {
                                const phoneEl = document.querySelector('[href^="tel:"]');
                                if (phoneEl) {
                                    let phone = phoneEl.href.replace('tel:', '').replace(/%20/g, ' ').trim();
                                    try { phone = decodeURIComponent(phone); } catch(e) {}
                                    return phone;
                                }
                                const phoneMatch = document.body.innerText.match(/(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/);
                                return phoneMatch ? phoneMatch[0] : "";
                            };

                            // Extract social links
                            const extractSocial = () => {
                                const links = Array.from(document.querySelectorAll('a[href]'));
                                const social = {};
                                const socialMap = {
                                    linkedin: 'linkedin.com',
                                    twitter: 'twitter.com',
                                    facebook: 'facebook.com',
                                    instagram: 'instagram.com',
                                    youtube: 'youtube.com'
                                };
                                for (const [name, domain] of Object.entries(socialMap)) {
                                    const link = links.find(l => l.href.includes(domain));
                                    if (link) social[name] = link.href;
                                }
                                return social;
                            };

                            // Extract services/specializations - FIXED: filter noise
                            const extractServices = () => {
                                const services = [];
                                const noisePatterns = ['Select a service', 'pricing information', 'see more', 'learn more', 'contact us', 'get started'];
                                
                                document.querySelectorAll('[class*="tag"], [class*="service"], [class*="skill"], [class*="category"]').forEach(el => {
                                    const text = el.innerText.trim();
                                    if (text && text.length < 50 && text.length > 2) {
                                        const isNoise = noisePatterns.some(n => text.toLowerCase().includes(n.toLowerCase()));
                                        if (!isNoise) services.push(text);
                                    }
                                });
                                
                                const unique = [...new Set(services)];
                                return unique.slice(0, 12).join(', ');
                            };

                            // Extract description
                            const extractDescription = () => {
                                const descSelectors = [
                                    '[data-cy="company-description"]',
                                    '.company-description',
                                    '[class*="description"]',
                                    '[class*="about"]',
                                    'section p'
                                ];
                                for (const sel of descSelectors) {
                                    const el = document.querySelector(sel);
                                    if (el && el.innerText.trim().length > 50) {
                                        return el.innerText.trim().substring(0, 500);
                                    }
                                }
                                return "";
                            };

                            // Extract location - FIXED: better pattern matching
                            const extractLocation = () => {
                                const locationSelectors = [
                                    '[class*="address-info"]',
                                    '[class*="address-text"]',
                                    '[data-cy="address"]',
                                    '[class*="location-text"]',
                                    '[class*="city-state"]'
                                ];
                                
                                for (const sel of locationSelectors) {
                                    const el = document.querySelector(sel);
                                    if (el && el.innerText.trim()) {
                                        return el.innerText.trim().split('\n')[0].trim();
                                    }
                                }
                                
                                const locationMatch = document.body.innerText.match(/([A-Za-z\s]+,\s*[A-Z]{2}|[A-Za-z\s]+,\s*[A-Za-z\s]+)$/m);
                                if (locationMatch) return locationMatch[0].trim();
                                
                                const cityStateMatch = document.body.innerText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*,\s*(?:[A-Z]{2}|[A-Za-z\s]+))/g);
                                if (cityStateMatch && cityStateMatch.length > 0) {
                                    return cityStateMatch[0].trim();
                                }
                                
                                return "";
                            };

                            // Extract team size
                            const extractTeamSize = () => {
                                const sizeEl = document.querySelector('[class*="size"], [class*="employee"], [class*="team"]');
                                if (sizeEl) return sizeEl.innerText.trim();
                                const sizeMatch = document.body.innerText.match(/(\d+[\-\s]?\d*)\s*(employees?|people|staff)/i);
                                return sizeMatch ? sizeMatch[0] : "";
                            };

                            const website = extractWebsite();
                            const social = extractSocial();
                            
                            return {
                                name: document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : document.title.replace(' | Clutch', ''),
                                website: website,
                                phone: extractPhone(),
                                email: extractEmail(),
                                address: extractLocation(),
                                description: extractDescription(),
                                services: extractServices(),
                                team_size: extractTeamSize(),
                                linkedin: social.linkedin || "",
                                facebook: social.facebook || "",
                                twitter: social.twitter || "",
                                clutch_url: window.location.href
                            };
                        }
                    });
                    resolve(results[0].result);
                } catch (err) {
                    reject(err);
                }
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

// Additional function to scrape email from company website
async function scrapeCompanyWebsite(tabId, websiteUrl) {
    if (!websiteUrl || websiteUrl === "" || websiteUrl.includes('tel:') || websiteUrl.includes('twitter.com')) {
        return { email: "", contact_page: "" };
    }

    try {
        await chrome.tabs.update(tabId, { url: websiteUrl });
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve({ email: "", contact_page: "" });
            }, 15000);

            const listener = async (updatedTabId, info) => {
                if (updatedTabId === tabId && info.status === 'complete') {
                    clearTimeout(timeout);
                    chrome.tabs.onUpdated.removeListener(listener);
                    
                    await new Promise(r => setTimeout(r, 2000));

                    try {
                        const results = await chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: () => {
                                const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                                const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/get-in-touch'];
                                const currentPath = window.location.pathname;
                                
                                let email = "";
                                let isContactPage = contactPaths.some(p => currentPath.includes(p));
                                
                                if (isContactPage || document.body.innerText.toLowerCase().includes('contact')) {
                                    const matches = document.body.innerText.match(emailPattern);
                                    if (matches) {
                                        const validEmails = matches.filter(e => 
                                            !e.includes('noreply') && !e.includes('example') && 
                                            !e.includes('test') && !e.includes('domain')
                                        );
                                        email = validEmails[0] || matches[0];
                                    }
                                }
                                
                                const mailto = document.querySelector('[href^="mailto:"]');
                                if (!email && mailto) {
                                    email = mailto.href.replace('mailto:', '');
                                }
                                
                                return { email: email, contact_page: window.location.href };
                            }
                        });
                        resolve(results[0].result);
                    } catch (err) {
                        resolve({ email: "", contact_page: "" });
                    }
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
    } catch (err) {
        return { email: "", contact_page: "" };
    }
}

// Main scraping loop
async function startScraping() {
    try {
        const tab = await getOrCreateClutchTab();
        currentTabId = tab.id;
        currentIndex = 0;
        leads = [];
        
        chrome.runtime.sendMessage({ 
            action: "UPDATE_STATUS", 
            status: "SCRAPING",
            message: "Using Clutch tab... Waiting for page to load..."
        });

        await new Promise(r => setTimeout(r, 3000));

        const companyLinks = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const selectors = [
                    'a[href*="/profile/"]',
                    'a[href*="/firm/"]',
                    '.provider-info a[href]',
                    '.agency-card a[href*="clutch.co"]',
                    'a[href*="/agencies/"]'
                ];
                let links = [];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(a => {
                        if (a.href && a.href.includes('clutch.co') && a.href.includes('/profile/')) {
                            try {
                                const url = new URL(a.href);
                                const cleanUrl = url.origin + url.pathname;
                                links.push(cleanUrl);
                            } catch (e) {
                                links.push(a.href);
                            }
                        }
                    });
                });
                return [...new Set(links)];
            }
        });

        const urls = companyLinks[0].result || [];
        
        if (urls.length === 0) {
            chrome.runtime.sendMessage({ 
                action: "UPDATE_STATUS", 
                status: "IDLE",
                message: "No company links found. Make sure you're on a Clutch directory page."
            });
            return;
        }
        
        chrome.runtime.sendMessage({ 
            action: "UPDATE_STATUS", 
            status: "SCRAPING",
            message: `Found ${urls.length} companies. Starting scrape...`
        });

        for (let i = 0; i < urls.length; i++) {
            if (isPaused) {
                await new Promise(r => setTimeout(r, 1000));
                i--;
                continue;
            }

            currentIndex = i;
            await chrome.storage.local.set({ currentIndex });

            chrome.runtime.sendMessage({ 
                action: "UPDATE_STATUS", 
                status: "SCRAPING",
                message: `Scraping ${i + 1}/${urls.length}: ${urls[i].substring(0, 60)}...`
            });

            try {
                const data = await scrapeCompany(tab.id, urls[i]);
                
                // Skip blocked/error pages
                if (data && data.error && data.name === "BLOCKED_PAGE") {
                    chrome.runtime.sendMessage({ 
                        action: "UPDATE_STATUS", 
                        status: "SCRAPING",
                        message: `Skipped (blocked): ${urls[i].split('/').pop()}`
                    });
                    continue;
                }
                
                if (data && data.name) {
                    // Try to get email from company website
                    if (data.website && data.website !== "" && !data.website.includes('tel:')) {
                        try {
                            const websiteData = await scrapeCompanyWebsite(tab.id, data.website);
                            if (websiteData.email) {
                                data.email = websiteData.email;
                                data.email_source = "website";
                            }
                        } catch (e) {
                            console.log("Could not scrape website:", e.message);
                        }
                    }
                    
                    leads.push(data);
                    await chrome.storage.local.set({ leads });
                    chrome.runtime.sendMessage({ 
                        action: "UPDATE_STATUS", 
                        status: "SCRAPING",
                        message: `Collected: ${data.name}${data.email ? ' (' + data.email + ')' : ''}`
                    });
                }
            } catch (err) {
                console.error("Error scraping:", urls[i], err.message);
            }
        }

        chrome.runtime.sendMessage({ 
            action: "UPDATE_STATUS", 
            status: "COMPLETE",
            message: `Done! Scraped ${leads.length} leads.`
        });
    } catch (err) {
        chrome.runtime.sendMessage({ 
            action: "UPDATE_STATUS", 
            status: "ERROR",
            message: `Error: ${err.message}`
        });
        throw err;
    }
}

// Resume paused scraping
async function resumeScraping() {
    isPaused = false;
    chrome.runtime.sendMessage({ 
        action: "UPDATE_STATUS", 
        status: "RESUMING",
        message: "Resuming scrape..."
    });
}

// Listen for messages from the dashboard/popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_PHASE_1") {
        startScraping()
            .then(() => sendResponse({ status: "started" }))
            .catch(err => {
                console.error("Scraping error:", err);
                sendResponse({ status: "error", message: err.message });
            });
        return true;
    }
    if (request.action === "RESUME") {
        resumeScraping();
        sendResponse({ status: "resumed" });
        return true;
    }
    if (request.action === "START_DEEP_SCRAPE") {
        scrapeCompany(currentTabId, request.url)
            .then(data => sendResponse({ status: "ok", data }))
            .catch(err => sendResponse({ status: "error", message: err.message }));
        return true;
    }
    if (request.action === "CHECK_TAB") {
        chrome.tabs.query({ url: "*://*.clutch.co/*" }, (tabs) => {
            if (tabs && tabs.length > 0) {
                sendResponse({ hasTab: true, url: tabs[0].url });
            } else {
                sendResponse({ hasTab: false });
            }
        });
        return true;
    }
});