/**
 * HDFilmCehennemi Stremio Addon - Scraper Module
 * 
 * Handles video and subtitle extraction from HDFilmCehennemi.
 * 
 * @module scraper
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { ScrapingError, NetworkError, TimeoutError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');

const log = createLogger('Scraper');

const BASE_URL = 'https://www.hdfilmcehennemi.ws';
const EMBED_BASE = 'https://hdfilmcehennemi.mobi';

// Configuration
const CONFIG = {
    timeout: 15000,        // 15 seconds
    maxRetries: 3,         // Number of retry attempts per proxy
    maxConcurrent: 5,      // Max concurrent requests
    retryDelay: 1000,      // Base delay for exponential backoff (ms)
    maxProxyAttempts: 5    // Max number of different proxies to try
};

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

// Simple semaphore for rate limiting
let activeRequests = 0;
const requestQueue = [];

/**
 * Acquire a slot for making a request (rate limiting)
 * @returns {Promise<void>}
 */
function acquireSlot() {
    return new Promise((resolve) => {
        if (activeRequests < CONFIG.maxConcurrent) {
            activeRequests++;
            resolve();
        } else {
            requestQueue.push(resolve);
        }
    });
}

/**
 * Release a request slot
 */
function releaseSlot() {
    activeRequests--;
    if (requestQueue.length > 0) {
        activeRequests++;
        const next = requestQueue.shift();
        next();
    }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if URL is an HDFilmCehennemi domain (needs proxy)
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isHdfilmcehennemiUrl(url) {
    return url.includes('hdfilmcehennemi.ws') || url.includes('hdfilmcehennemi.mobi');
}

/**
 * Try to fetch URL using a specific proxy with retries
 * Returns response text on success, null on failure
 * @param {string} url - URL to fetch
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @param {Object} headers - Request headers
 * @returns {Promise<string|null>} Response text or null if all retries failed
 */
async function tryFetchWithProxy(url, proxy, headers) {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            await acquireSlot();
            log.debug(`Fetch via proxy ${proxy.type}://${proxy.address} attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
            const dispatcher = createProxyAgent(proxy);

            try {
                const response = await fetch(url, {
                    headers,
                    signal: controller.signal,
                    dispatcher
                });
                clearTimeout(timeoutId);

                if (response.status === 403) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} blocked by Cloudflare (403)`);
                    return null; // Proxy is blocked, don't retry
                }

                if (!response.ok) {
                    throw new NetworkError(
                        `HTTP ${response.status}: ${response.statusText}`,
                        url,
                        response.status
                    );
                }

                const text = await response.text();

                // Verify not a Cloudflare challenge
                if (text.includes('cf-browser-verification') ||
                    text.includes('Just a moment')) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} got Cloudflare challenge`);
                    return null; // Proxy got blocked
                }

                log.info(`✅ Fetch via proxy success: ${url} (${text.length} bytes)`);
                return text;
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                log.warn(`Proxy ${proxy.type}://${proxy.address} timeout on attempt ${attempt}`);
            } else {
                log.warn(`Proxy ${proxy.type}://${proxy.address} failed on attempt ${attempt}: ${error.message}`);
            }

            if (attempt < CONFIG.maxRetries) {
                const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                log.warn(`Proxy request failed, retrying in ${delay}ms...`);
                await sleep(delay);
            }

        } finally {
            releaseSlot();
        }
    }

    return null; // All retries failed
}

/**
 * HTTP GET request with timeout, retry, and smart proxy fallback
 * @param {string} url - URL to fetch
 * @param {string} [referer] - Optional referer header
 * @returns {Promise<string>} Response body as text
 * @throws {NetworkError|TimeoutError}
 */
async function httpGet(url, referer = null) {
    const headers = { ...defaultHeaders };
    if (referer) headers['Referer'] = referer;

    let lastError = null;
    let useProxy = isProxyAlways() && isHdfilmcehennemiUrl(url);

    // Phase 1: Try direct connection (unless proxy is 'always')
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                await acquireSlot();
                log.debug(`HTTP GET direct (attempt ${attempt}/${CONFIG.maxRetries}): ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

                try {
                    const response = await fetch(url, {
                        headers,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    // Check for Cloudflare block (403)
                    if (response.status === 403 && isHdfilmcehennemiUrl(url)) {
                        log.warn(`Cloudflare block detected (403), will try proxy...`);
                        useProxy = true;
                        break;
                    }

                    if (!response.ok) {
                        throw new NetworkError(
                            `HTTP ${response.status}: ${response.statusText}`,
                            url,
                            response.status
                        );
                    }

                    const text = await response.text();

                    // Check for Cloudflare challenge page
                    if (isHdfilmcehennemiUrl(url) &&
                        (text.includes('cf-browser-verification') ||
                            text.includes('Just a moment') ||
                            text.includes('challenge-platform'))) {
                        log.warn(`Cloudflare challenge detected, will try proxy...`);
                        useProxy = true;
                        break;
                    }

                    log.debug(`HTTP GET success: ${url} (${text.length} bytes)`);
                    return text;

                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }

            } catch (error) {
                lastError = error;

                if (error.name === 'AbortError') {
                    lastError = new TimeoutError(url, CONFIG.timeout);
                } else if (!(error instanceof NetworkError)) {
                    lastError = new NetworkError(error.message, url);
                }

                if (attempt < CONFIG.maxRetries) {
                    const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                    log.warn(`Request failed, retrying in ${delay}ms... (${error.message})`);
                    await sleep(delay);
                }

            } finally {
                releaseSlot();
            }
        }
    }

    // Phase 2: Try with proxies (only for hdfilmcehennemi URLs)
    // Keep trying new proxies until success or max attempts reached
    if (useProxy && isProxyEnabled() && isHdfilmcehennemiUrl(url)) {
        log.info(`🔄 Proxy fallback activated for: ${url}`);

        const triedProxies = new Set();

        for (let proxyAttempt = 1; proxyAttempt <= CONFIG.maxProxyAttempts; proxyAttempt++) {
            const proxy = await getWorkingProxy();

            if (!proxy) {
                log.warn(`No working proxy available (attempt ${proxyAttempt}/${CONFIG.maxProxyAttempts})`);
                // Wait a bit before trying again to allow proxy refresh
                if (proxyAttempt < CONFIG.maxProxyAttempts) {
                    await sleep(2000);
                }
                continue;
            }

            // Skip if we already tried this proxy (compare by address)
            if (triedProxies.has(proxy.address)) {
                log.debug(`Skipping already-tried proxy: ${proxy.type}://${proxy.address}`);
                markProxyBad(proxy); // Force getting a different one next time
                continue;
            }

            triedProxies.add(proxy.address);
            log.info(`📡 Trying proxy ${proxyAttempt}/${CONFIG.maxProxyAttempts}: ${proxy.type}://${proxy.address}`);

            // Try this proxy with retries
            const result = await tryFetchWithProxy(url, proxy, headers);
            if (result) {
                return result;
            }

            // Proxy failed, mark as bad and try next
            log.warn(`Proxy ${proxy.type}://${proxy.address} failed after ${CONFIG.maxRetries} attempts, trying next proxy...`);
            markProxyBad(proxy);
        }

        lastError = new NetworkError(
            `All ${CONFIG.maxProxyAttempts} proxy attempts failed`,
            url
        );
    }

    log.error(`All attempts failed for: ${url}`);
    throw lastError || new NetworkError('All attempts failed', url);
}

/**
 * JavaScript packer unpacker
 * @param {string} p - Packed code
 * @param {number} a - Base for encoding
 * @param {number} c - Count of words
 * @param {string} k - Pipe-separated keywords
 * @returns {string} Unpacked JavaScript
 */
function unpackJS(p, a, c, k) {
    k = k.split('|');

    function decode(word) {
        let n = 0;
        for (const char of word) {
            if (/\d/.test(char)) {
                n = n * a + parseInt(char);
            } else if (/[a-z]/.test(char)) {
                n = n * a + char.charCodeAt(0) - 'a'.charCodeAt(0) + 10;
            } else if (/[A-Z]/.test(char)) {
                n = n * a + char.charCodeAt(0) - 'A'.charCodeAt(0) + 36;
            }
        }
        return n < k.length && k[n] ? k[n] : word;
    }

    return p.replace(/\b\w+\b/g, decode);
}

/**
 * ROT13 cipher - shifts letters by 13 positions
 * @param {string} str - String to decode
 * @returns {string} ROT13 decoded string
 */
function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode(
            (c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26
        );
    });
}

/**
 * Decode obfuscated video URL
 * Algorithm: join → reverse → base64 → ROT13 → character unmix
 * (Updated Dec 2025 - site changed algorithm order)
 * @param {string[]} parts - Array of encoded parts
 * @returns {string} Decoded video URL
 */
function decodeVideoUrl(parts) {
    let value = parts.join('');

    // Step 1: Reverse the string
    value = value.split('').reverse().join('');

    // Step 2: Base64 decode
    value = Buffer.from(value, 'base64').toString('latin1');

    // Step 3: ROT13 decode
    value = rot13(value);

    // Step 4: Character unmix with magic number
    let unmix = '';
    for (let i = 0; i < value.length; i++) {
        let charCode = value.charCodeAt(i);
        charCode = (charCode - (399756995 % (i + 5)) + 256) % 256;
        unmix += String.fromCharCode(charCode);
    }
    return unmix;
}

/**
 * Scrape video and subtitle data from iframe URL
 * @param {string} iframeSrc - Iframe source URL
 * @returns {Promise<{videoUrl: string|null, subtitles: Array, audioTracks: Array}>}
 * @throws {ScrapingError|NetworkError}
 */
async function scrapeIframe(iframeSrc) {
    log.debug(`Scraping iframe: ${iframeSrc}`);

    const html = await httpGet(iframeSrc, BASE_URL);
    const $ = cheerio.load(html);

    const result = {
        videoUrl: null,
        subtitles: [],
        audioTracks: []
    };

    // Extract subtitles from <track> elements
    $('video track').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
            const fullUrl = src.startsWith('http') ? src : EMBED_BASE + src;
            result.subtitles.push({
                id: `hdfc-${$(el).attr('srclang') || i}`,
                lang: $(el).attr('srclang') || 'unknown',
                label: $(el).attr('label') || '',
                url: fullUrl,
                default: $(el).attr('default') !== undefined
            });
        }
    });

    log.debug(`Found ${result.subtitles.length} subtitles`);

    // Method 1: Try packed JavaScript decoder (primary method)
    const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+)',(\d+),(\d+),'([^']+)'/s);

    if (packedMatch) {
        const decoded = unpackJS(
            packedMatch[1],
            parseInt(packedMatch[2]),
            parseInt(packedMatch[3]),
            packedMatch[4]
        );

        // Decode video URL from parts array
        const partsMatch = decoded.match(/dc_\w+\(\[([^\]]+)\]\)/);
        if (partsMatch) {
            const parts = partsMatch[1].match(/"([^"]+)"/g).map(s => s.replace(/"/g, ''));
            result.videoUrl = decodeVideoUrl(parts);
            log.debug(`Video URL extracted from packed JS: ${result.videoUrl.substring(0, 80)}...`);
        }
    } else {
        log.debug('No packed JavaScript found in iframe');
    }

    // Method 2: Fallback to JSON-LD schema (if packed JS failed)
    if (!result.videoUrl) {
        const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (jsonLdMatch) {
            try {
                const jsonLd = JSON.parse(jsonLdMatch[1]);
                if (jsonLd.contentUrl) {
                    result.videoUrl = jsonLd.contentUrl;
                    log.debug(`Video URL extracted from JSON-LD: ${result.videoUrl.substring(0, 80)}...`);
                }
            } catch (e) {
                log.debug(`Failed to parse JSON-LD: ${e.message}`);
            }
        }
    }

    // Extract audio tracks from m3u8
    if (result.videoUrl) {
        try {
            const m3u8Content = await httpGet(result.videoUrl, iframeSrc);
            const baseM3u8 = result.videoUrl.substring(0, result.videoUrl.lastIndexOf('/'));
            const audioRegex = /#EXT-X-MEDIA:TYPE=AUDIO.*?NAME="([^"]+)".*?URI="([^"]+)"/g;
            let match;

            while ((match = audioRegex.exec(m3u8Content)) !== null) {
                result.audioTracks.push({
                    name: match[1],
                    url: `${baseM3u8}/${match[2]}`
                });
            }

            log.debug(`Found ${result.audioTracks.length} audio tracks`);
        } catch (error) {
            log.warn(`Failed to fetch m3u8: ${error.message}`);
        }
    }

    if (!result.videoUrl) {
        log.warn('No video URL found in iframe');
    }

    return result;
}

/**
 * Get video and subtitle data from a page URL
 * Implements fallback logic for alternative sources
 * 
 * @param {string} pageUrl - HDFilmCehennemi page URL
 * @returns {Promise<{videoUrl: string, subtitles: Array, audioTracks: Array, source?: string, alternativeSources: Array}|null>}
 * @throws {ScrapingError|NetworkError}
 */
async function getVideoAndSubtitles(pageUrl) {
    log.info(`Fetching video from: ${pageUrl}`);

    const html = await httpGet(pageUrl);
    const $ = cheerio.load(html);

    // Find iframe
    const iframe = $('iframe');
    const iframeSrc = iframe.attr('src') || iframe.attr('data-src');

    if (!iframeSrc) {
        log.warn('No iframe found on page');
        throw new ScrapingError('Sayfa üzerinde video oynatıcı bulunamadı', pageUrl);
    }

    log.debug(`Found iframe: ${iframeSrc}`);

    // Collect alternative sources
    const altSources = [];
    $('.alternative-link').each((i, el) => {
        altSources.push({
            name: $(el).text().trim(),
            videoId: $(el).attr('data-video'),
            active: $(el).attr('data-active') === '1'
        });
    });

    log.debug(`Found ${altSources.length} alternative sources`);

    // Extract embed origin from iframe URL for Referer header
    const getEmbedOrigin = (url) => {
        try {
            const parsed = new URL(url);
            return parsed.origin;
        } catch {
            return BASE_URL; // Fallback to main site
        }
    };

    // Track which iframe source was actually used
    let usedIframeSrc = iframeSrc;

    // Try active source
    let result = null;
    try {
        result = await scrapeIframe(iframeSrc);
    } catch (error) {
        log.warn(`Primary source failed: ${error.message}`);
    }

    // Fallback to alternative sources if video URL not found
    if (!result || !result.videoUrl) {
        log.info('Primary source failed, trying alternatives...');

        const videoIdMatch = iframeSrc.match(/embed\/([^\/\?]+)/);
        if (videoIdMatch) {
            const videoId = videoIdMatch[1];

            for (const alt of altSources) {
                if (alt.active) continue;

                log.debug(`Trying alternative: ${alt.name}`);

                let altIframeSrc = iframeSrc;
                if (alt.name.toLowerCase() === 'rapidrame') {
                    altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/?rapidrame_id=${alt.videoId}`;
                } else {
                    altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/`;
                }

                try {
                    const altResult = await scrapeIframe(altIframeSrc);
                    if (altResult && altResult.videoUrl) {
                        result = altResult;
                        result.source = alt.name;
                        usedIframeSrc = altIframeSrc; // Track which iframe worked
                        log.info(`Alternative source succeeded: ${alt.name}`);
                        break;
                    }
                } catch (error) {
                    log.debug(`Alternative ${alt.name} failed: ${error.message}`);
                }
            }
        }
    } else {
        const activeSource = altSources.find(s => s.active);
        if (activeSource) {
            result.source = activeSource.name;
        }
    }

    if (!result || !result.videoUrl) {
        throw new ScrapingError('Video URL çıkarılamadı', pageUrl);
    }

    result.alternativeSources = altSources;
    // Store the embed origin for Referer header - critical for Rapidrame playback
    result.embedOrigin = getEmbedOrigin(usedIframeSrc);
    log.info(`Video extraction successful (source: ${result.source || 'default'}, embedOrigin: ${result.embedOrigin})`);

    return result;
}


/**
 * Convert scraping result to Stremio stream format
 * Audio track selection is handled by Stremio player via m3u8
 * 
 * @param {Object} result - Scraping result from getVideoAndSubtitles
 * @param {string} [title='HDFilmCehennemi'] - Stream title
 * @param {string} [baseUrl] - Base URL for m3u8 proxy (e.g., https://your-server.com)
 * @returns {{streams: Array}} Stremio-compatible stream response
 */
function toStremioStreams(result, title = 'HDFilmCehennemi', baseUrl = null) {
    if (!result || !result.videoUrl) return { streams: [] };

    // Use the embed origin from scraping result, fallback to EMBED_BASE
    // Critical: Rapidrame videos need hdfilmcehennemi.ws as Referer
    //           Close videos need hdfilmcehennemi.mobi as Referer
    const embedOrigin = result.embedOrigin || EMBED_BASE;
    const referer = embedOrigin + '/';

    // Generate proxied URL for TV compatibility (libVLC doesn't support proxyHeaders)
    // PC clients can still use behaviorHints.proxyHeaders
    let streamUrl = result.videoUrl;
    if (baseUrl) {
        const encodedUrl = Buffer.from(result.videoUrl).toString('base64');
        const encodedRef = Buffer.from(referer).toString('base64');
        streamUrl = `${baseUrl}/proxy/m3u8?url=${encodedUrl}&ref=${encodedRef}`;
    }

    // Video server requires Referer header - returns 404 without it
    // This is for PC clients that support proxyHeaders
    const behaviorHints = {
        notWebReady: true,
        proxyHeaders: {
            request: {
                'Referer': referer,
                'Origin': embedOrigin
            }
        }
    };

    // Return single stream - audio tracks selectable via player from m3u8
    return {
        streams: [{
            url: streamUrl,
            title: title,
            name: 'HDFilmCehennemi',
            behaviorHints: behaviorHints,
            subtitles: result.subtitles.map(s => ({
                id: s.id,
                url: s.url,
                lang: s.lang,
                label: s.label
            }))
        }]
    };
}

module.exports = {
    getVideoAndSubtitles,
    toStremioStreams
};
