/**
 * HDFilmCehennemi Stremio Addon - Proxy Module
 * 
 * Handles proxy list fetching, caching, and rotation for bypassing Cloudflare blocks.
 * Uses TheSpeedX proxy list by default.
 * 
 * @module proxy
 */

const { fetch, ProxyAgent } = require('undici');
const { createLogger } = require('./logger');

const log = createLogger('Proxy');

// Configuration
const CONFIG = {
    proxyListUrl: process.env.PROXY_LIST_URL || 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
    proxyEnabled: process.env.PROXY_ENABLED || 'auto', // 'auto' | 'always' | 'never'
    cacheTTL: 30 * 60 * 1000, // 30 minutes
    testTimeout: 5000, // 5 seconds for proxy test
    maxProxiesToTest: 20, // Test at most this many proxies
    testUrl: 'https://www.hdfilmcehennemi.ws/' // URL to test proxies against
};

// Proxy list cache
let proxyListCache = {
    proxies: [],
    timestamp: 0,
    workingProxies: []
};

/**
 * Fetch proxy list from TheSpeedX or custom URL
 * @returns {Promise<string[]>} Array of proxy strings (ip:port)
 */
async function fetchProxyList() {
    // Check cache
    if (proxyListCache.proxies.length > 0 &&
        Date.now() - proxyListCache.timestamp < CONFIG.cacheTTL) {
        log.debug(`Using cached proxy list (${proxyListCache.proxies.length} proxies)`);
        return proxyListCache.proxies;
    }

    try {
        log.info(`Fetching proxy list from: ${CONFIG.proxyListUrl}`);

        const response = await fetch(CONFIG.proxyListUrl, {
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();
        const proxies = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line));

        log.info(`Fetched ${proxies.length} proxies`);

        // Update cache
        proxyListCache = {
            proxies: proxies,
            timestamp: Date.now(),
            workingProxies: [] // Reset working proxies on refresh
        };

        return proxies;
    } catch (error) {
        log.error(`Failed to fetch proxy list: ${error.message}`);
        return proxyListCache.proxies; // Return stale cache if available
    }
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
 * Tests proxies from the list until one works
 * @returns {Promise<string|null>} Working proxy (ip:port) or null
 */
async function getWorkingProxy() {
    if (CONFIG.proxyEnabled === 'never') {
        log.debug('Proxy disabled by configuration');
        return null;
    }

    // Return cached working proxy if available
    if (proxyListCache.workingProxies.length > 0) {
        const proxy = proxyListCache.workingProxies[0];
        log.debug(`Using cached working proxy: ${proxy}`);
        return proxy;
    }

    // Fetch fresh proxy list
    const proxies = await fetchProxyList();
    if (proxies.length === 0) {
        log.warn('No proxies available');
        return null;
    }

    // Shuffle and test proxies
    const shuffled = [...proxies].sort(() => Math.random() - 0.5);
    const toTest = shuffled.slice(0, CONFIG.maxProxiesToTest);

    log.info(`Testing ${toTest.length} proxies...`);

    for (const proxy of toTest) {
        if (await testProxy(proxy)) {
            proxyListCache.workingProxies.push(proxy);
            log.info(`Found working proxy: ${proxy}`);
            return proxy;
        }
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
