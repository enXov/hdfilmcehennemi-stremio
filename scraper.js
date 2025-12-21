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
const { ScrapingError, NetworkError, TimeoutError, RateLimitError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');

const log = createLogger('Scraper');

const BASE_URL = 'https://www.hdfilmcehennemi.ws';
const EMBED_BASE = 'https://hdfilmcehennemi.mobi';

// Configuration
const CONFIG = {
    timeout: 15000,        // 15 seconds
    maxRetries: 3,         // Number of retry attempts
    maxConcurrent: 5,      // Max concurrent requests
    retryDelay: 1000       // Base delay for exponential backoff (ms)
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
 * HTTP GET request with timeout, retry, and smart proxy fallback
 * @param {string} url - URL to fetch
 * @param {string} [referer] - Optional referer header
 * @returns {Promise<string>} Response body as text
 * @throws {NetworkError|TimeoutError|RateLimitError}
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

    // Phase 2: Try with proxy (only for hdfilmcehennemi URLs)
    if (useProxy && isProxyEnabled() && isHdfilmcehennemiUrl(url)) {
        log.info(`🔄 Proxy fallback activated for: ${url}`);

        const proxy = await getWorkingProxy();
        if (!proxy) {
            log.error('No working proxy available');
            throw lastError || new NetworkError('No working proxy available', url);
        }

        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                await acquireSlot();
                log.debug(`HTTP GET via proxy ${proxy} (attempt ${attempt}/${CONFIG.maxRetries}): ${url}`);

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
                        log.warn(`Proxy ${proxy} also blocked, marking as bad...`);
                        markProxyBad(proxy);
                        throw new NetworkError('Proxy blocked by Cloudflare', url, 403);
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
                        log.warn(`Proxy ${proxy} got Cloudflare challenge, marking as bad...`);
                        markProxyBad(proxy);
                        throw new NetworkError('Proxy got Cloudflare challenge', url);
                    }

                    log.info(`✅ HTTP GET via proxy success: ${url} (${text.length} bytes)`);
                    return text;

                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }

            } catch (error) {
                lastError = error;

                if (error.name === 'AbortError') {
                    lastError = new TimeoutError(url, CONFIG.timeout);
                }

                if (attempt < CONFIG.maxRetries) {
                    const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                    log.warn(`Proxy request failed, retrying in ${delay}ms... (${error.message})`);
                    await sleep(delay);
                }

            } finally {
                releaseSlot();
            }
        }

        // All retries failed - mark this proxy as bad and try to get a new one
        log.warn(`Proxy ${proxy} failed after ${CONFIG.maxRetries} attempts, marking as bad...`);
        markProxyBad(proxy);

        // Try to get a new proxy
        const newProxy = await getWorkingProxy();
        if (newProxy && newProxy !== proxy) {
            log.info(`🔄 Trying with new proxy: ${newProxy}`);
            try {
                await acquireSlot();
                const dispatcher = createProxyAgent(newProxy);
                const response = await fetch(url, {
                    headers,
                    signal: AbortSignal.timeout(CONFIG.timeout),
                    dispatcher
                });
                releaseSlot();

                if (response.ok) {
                    const text = await response.text();
                    if (!text.includes('cf-browser-verification') && !text.includes('Just a moment')) {
                        log.info(`✅ HTTP GET via new proxy success: ${url} (${text.length} bytes)`);
                        return text;
                    }
                }
                markProxyBad(newProxy);
            } catch (e) {
                releaseSlot();
                log.warn(`New proxy also failed: ${e.message}`);
                markProxyBad(newProxy);
            }
        }
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
 * Algorithm: join → ROT13 → base64 → reverse → character unmix
 * @param {string[]} parts - Array of encoded parts
 * @returns {string} Decoded video URL
 */
function decodeVideoUrl(parts) {
    let value = parts.join('');

    // Step 1: ROT13 decode
    value = rot13(value);

    // Step 2: Base64 decode
    value = Buffer.from(value, 'base64').toString('latin1');

    // Step 3: Reverse
    value = value.split('').reverse().join('');

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
    log.info(`Video extraction successful (source: ${result.source || 'default'})`);

    return result;
}

/**
 * Get list of episodes for a TV series
 * @param {string} seriesUrl - Series page URL
 * @returns {Promise<Array<{url: string, name: string}>>} List of episodes
 */
async function getSeriesEpisodes(seriesUrl) {
    log.debug(`Fetching episodes from: ${seriesUrl}`);

    try {
        const html = await httpGet(seriesUrl);
        const $ = cheerio.load(html);

        const episodes = [];
        const seen = new Set();

        $('a[href*="sezon"][href*="bolum"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !seen.has(href)) {
                episodes.push({
                    url: href,
                    name: $(el).text().trim() || href.split('/').slice(-2, -1)[0]
                });
                seen.add(href);
            }
        });

        log.debug(`Found ${episodes.length} episodes`);
        return episodes;
    } catch (error) {
        log.error(`Failed to get episodes: ${error.message}`);
        return [];
    }
}

/**
 * Convert scraping result to Stremio stream format
 * Audio track selection is handled by Stremio player via m3u8
 * 
 * @param {Object} result - Scraping result from getVideoAndSubtitles
 * @param {string} [title='HDFilmCehennemi'] - Stream title
 * @returns {{streams: Array}} Stremio-compatible stream response
 */
function toStremioStreams(result, title = 'HDFilmCehennemi') {
    if (!result || !result.videoUrl) return { streams: [] };

    // Video server requires Referer header - returns 404 without it
    const behaviorHints = {
        notWebReady: true,
        proxyHeaders: {
            request: {
                'Referer': EMBED_BASE + '/',
                'Origin': EMBED_BASE
            }
        }
    };

    // Return single stream - audio tracks selectable via player from m3u8
    return {
        streams: [{
            url: result.videoUrl,
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
    getSeriesEpisodes,
    toStremioStreams,
    BASE_URL,
    EMBED_BASE
};
