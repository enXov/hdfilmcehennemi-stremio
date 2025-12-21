/**
 * HDFilmCehennemi Stremio Addon - Proxy Module
 * 
 * Handles proxy list fetching, caching, and rotation for bypassing Cloudflare blocks.
 * Uses multiple proxy sources merged together for reliability.
 * 
 * @module proxy
 */

const { fetch, ProxyAgent } = require('undici');
const { createLogger } = require('./logger');

const log = createLogger('Proxy');

// Multiple proxy sources for reliability - all filtered for Turkey
const PROXY_SOURCES = [
    // ProxyScrape - Turkey only
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=TR&ssl=all&anonymity=all',
    // Proxy-List.download - Turkey only
    'https://www.proxy-list.download/api/v1/get?type=http&country=TR',
    // Free Proxy List (geonode) - Turkey
    'https://proxylist.geonode.com/api/proxy-list?country=TR&protocols=http&limit=50&page=1&sort_by=lastChecked&sort_type=desc',
];

// Configuration
const CONFIG = {
    proxyEnabled: process.env.PROXY_ENABLED || 'auto', // 'auto' | 'always' | 'never'
    cacheTTL: 10 * 60 * 1000, // 10 minutes
    testTimeout: 8000, // 8 seconds for proxy test
    maxProxiesToTest: 15, // Test more since we have more sources
    testUrl: 'https://www.hdfilmcehennemi.ws/' // URL to test proxies against
};

// Proxy list cache
let proxyListCache = {
    proxies: [],
    timestamp: 0,
    workingProxies: []
};

/**
 * Fetch proxies from a single source
 * @param {string} url - Proxy source URL
 * @returns {Promise<string[]>} Array of proxy strings
 */
async function fetchFromSource(url) {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) return [];

        const text = await response.text();

        // Handle JSON response (geonode format)
        if (url.includes('geonode')) {
            try {
                const json = JSON.parse(text);
                if (json.data && Array.isArray(json.data)) {
                    return json.data.map(p => `${p.ip}:${p.port}`);
                }
            } catch { return []; }
        }

        // Handle plain text response
        return text
            .split(/[\n\r]+/)
            .map(line => line.trim())
            .filter(line => line && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line));
    } catch (error) {
        log.debug(`Failed to fetch from ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Fetch and merge proxy lists from all sources
 * @returns {Promise<string[]>} Array of unique proxy strings (ip:port)
 */
async function fetchProxyList() {
    // Check cache
    if (proxyListCache.proxies.length > 0 &&
        Date.now() - proxyListCache.timestamp < CONFIG.cacheTTL) {
        log.debug(`Using cached proxy list (${proxyListCache.proxies.length} proxies)`);
        return proxyListCache.proxies;
    }

    log.info(`Fetching proxies from ${PROXY_SOURCES.length} sources...`);

    // Fetch from all sources in parallel
    const results = await Promise.all(
        PROXY_SOURCES.map(url => fetchFromSource(url))
    );

    // Merge and deduplicate
    const allProxies = [...new Set(results.flat())];

    log.info(`Fetched ${allProxies.length} unique proxies from all sources`);

    if (allProxies.length > 0) {
        // Update cache - PRESERVE working proxies!
        proxyListCache.proxies = allProxies;
        proxyListCache.timestamp = Date.now();
    }

    return allProxies.length > 0 ? allProxies : proxyListCache.proxies;
}

/**
 * Test if a proxy works for HDFilmCehennemi
 * @param {string} proxy - Proxy string (ip:port)
 * @returns {Promise<boolean>} True if proxy works
 */
async function testProxy(proxy) {
    try {
        const proxyUrl = `http://${proxy}`;
        const dispatcher = new ProxyAgent(proxyUrl);

        const response = await fetch(CONFIG.testUrl, {
            dispatcher,
            signal: AbortSignal.timeout(CONFIG.testTimeout),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Check if we got past Cloudflare (not 403)
        if (response.status === 200) {
            const text = await response.text();
            // Make sure it's not a Cloudflare challenge page
            if (!text.includes('cf-browser-verification') &&
                !text.includes('Just a moment') &&
                text.length > 1000) {
                log.debug(`✅ Proxy works: ${proxy}`);
                return true;
            }
        }

        log.debug(`❌ Proxy blocked: ${proxy} (status: ${response.status})`);
        return false;
    } catch (error) {
        log.debug(`❌ Proxy failed: ${proxy} (${error.message})`);
        return false;
    }
}

/**
 * Get a working proxy for HDFilmCehennemi
 * Reuses cached working proxy if available, only tests new ones if needed
 * Tests proxies in PARALLEL for speed
 * @returns {Promise<string|null>} Working proxy (ip:port) or null
 */
async function getWorkingProxy() {
    if (CONFIG.proxyEnabled === 'never') {
        log.debug('Proxy disabled by configuration');
        return null;
    }

    // Return cached working proxy if available - no re-testing needed!
    if (proxyListCache.workingProxies.length > 0) {
        const proxy = proxyListCache.workingProxies[0];
        log.info(`♻️ Reusing cached working proxy: ${proxy}`);
        return proxy;
    }

    // Fetch fresh proxy list (won't clear working proxies)
    const proxies = await fetchProxyList();
    if (proxies.length === 0) {
        log.warn('No proxies available');
        return null;
    }

    // Shuffle and select proxies to test
    const shuffled = [...proxies].sort(() => Math.random() - 0.5);
    const toTest = shuffled.slice(0, CONFIG.maxProxiesToTest);

    log.info(`Testing ${toTest.length} proxies in parallel...`);

    // Test ALL proxies in parallel - much faster!
    const results = await Promise.all(
        toTest.map(async (proxy) => {
            const works = await testProxy(proxy);
            return { proxy, works };
        })
    );

    // Find first working proxy
    const working = results.find(r => r.works);
    if (working) {
        proxyListCache.workingProxies.push(working.proxy);
        log.info(`Found working proxy: ${working.proxy}`);
        return working.proxy;
    }

    log.warn('No working proxy found');
    return null;
}

/**
 * Mark a proxy as bad (failed during use)
 * @param {string} proxy - Proxy to remove
 */
function markProxyBad(proxy) {
    proxyListCache.workingProxies = proxyListCache.workingProxies.filter(p => p !== proxy);
    log.debug(`Marked proxy as bad: ${proxy}`);
}

/**
 * Create a ProxyAgent for the given proxy
 * @param {string} proxy - Proxy string (ip:port)
 * @returns {ProxyAgent}
 */
function createProxyAgent(proxy) {
    return new ProxyAgent(`http://${proxy}`);
}

/**
 * Check if proxy usage is enabled
 * @returns {boolean}
 */
function isProxyEnabled() {
    return CONFIG.proxyEnabled !== 'never';
}

/**
 * Check if proxy should always be used
 * @returns {boolean}
 */
function isProxyAlways() {
    return CONFIG.proxyEnabled === 'always';
}

/**
 * Clear proxy cache (for testing)
 */
function clearProxyCache() {
    proxyListCache = {
        proxies: [],
        timestamp: 0,
        workingProxies: []
    };
    log.info('Proxy cache cleared');
}

module.exports = {
    getWorkingProxy,
    markProxyBad,
    createProxyAgent,
    isProxyEnabled,
    isProxyAlways,
    clearProxyCache,
    fetchProxyList,
    testProxy
};
