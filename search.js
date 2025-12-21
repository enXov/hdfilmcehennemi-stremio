/**
 * HDFilmCehennemi Search & Matching Module
 * 
 * Handles content discovery: IMDb ID → HDFilmCehennemi URL mapping
 * 
 * @module search
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { ContentNotFoundError, NetworkError, ValidationError, TimeoutError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');

const log = createLogger('Search');

const BASE_URL = 'https://www.hdfilmcehennemi.ws';
const CINEMETA_URL = 'https://cinemeta-live.strem.io/meta';

// Configuration
const CONFIG = {
    timeout: 15000,        // 15 seconds
    maxRetries: 3,         // Number of retry attempts
    retryDelay: 1000       // Base delay for exponential backoff (ms)
};

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

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
 * Validate IMDb ID format
 * @param {string} imdbId - IMDb ID to validate
 * @returns {boolean} True if valid
 */
function isValidImdbId(imdbId) {
    return /^tt\d{7,8}$/.test(imdbId);
}

/**
 * Validate season/episode numbers
 * @param {*} value - Value to validate
 * @returns {boolean} True if valid positive integer
 */
function isValidEpisodeNumber(value) {
    const num = parseInt(value);
    return !isNaN(num) && num > 0 && num < 1000;
}

/**
 * Get cached data or null if expired
 * @param {string} key - Cache key
 * @returns {*} Cached data or null
 */
function getCached(key) {
    const item = cache.get(key);
    if (item && Date.now() - item.timestamp < CACHE_TTL) {
        log.debug(`Cache hit: ${key}`);
        return item.data;
    }
    cache.delete(key);
    return null;
}

/**
 * Store data in cache
 * @param {string} key - Cache key
 * @param {*} data - Data to cache
 */
function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
    log.debug(`Cache set: ${key}`);
}

/**
 * HTTP GET with timeout, retry, and smart proxy fallback
 * @param {string} url - URL to fetch
 * @param {Object} [options] - Fetch options
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
    let lastError = null;
    let useProxy = isProxyAlways() && isHdfilmcehennemiUrl(url);

    // Phase 1: Try direct connection (unless proxy is 'always')
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                log.debug(`Fetch direct attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

                try {
                    const response = await fetch(url, {
                        ...options,
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

                    return response;
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
                    log.warn(`Request failed, retrying in ${delay}ms...`);
                    await sleep(delay);
                }
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
                log.debug(`Fetch via proxy ${proxy} attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
                const dispatcher = createProxyAgent(proxy);

                try {
                    const response = await fetch(url, {
                        ...options,
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

                    log.info(`✅ Fetch via proxy success: ${url}`);
                    return response;
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
                    log.warn(`Proxy request failed, retrying in ${delay}ms...`);
                    await sleep(delay);
                }
            }
        }
    }

    throw lastError || new NetworkError('All attempts failed', url);
}

/**
 * Get content metadata from Cinemeta API
 * @param {'movie'|'series'} type - Content type
 * @param {string} imdbId - IMDb ID
 * @returns {Promise<Object|null>} Content metadata or null
 */
async function getMetaFromCinemeta(type, imdbId) {
    const cacheKey = `meta:${type}:${imdbId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const url = `${CINEMETA_URL}/${type}/${imdbId}.json`;
        log.debug(`Fetching metadata from Cinemeta: ${imdbId}`);

        const response = await fetchWithRetry(url, { headers: defaultHeaders });
        const data = await response.json();

        if (data?.meta) {
            setCache(cacheKey, data.meta);
            log.debug(`Cinemeta returned: ${data.meta.name} (${data.meta.year || 'unknown year'})`);
            return data.meta;
        }

        return null;
    } catch (error) {
        log.warn(`Cinemeta fetch failed: ${error.message}`);
        return null;
    }
}

/**
 * Normalize title for comparison
 * @param {string} title - Title to normalize
 * @returns {string} Normalized title
 */
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[''`]/g, "'")
        .replace(/[""]/g, '"')
        .replace(/[:\-–—]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Convert Turkish characters to ASCII (for URL slug matching)
 * @param {string} str - String to convert
 * @returns {string} ASCII string
 */
function turkishToAscii(str) {
    const map = {
        'ç': 'c', 'Ç': 'C',
        'ğ': 'g', 'Ğ': 'G',
        'ı': 'i', 'İ': 'I',
        'ö': 'o', 'Ö': 'O',
        'ş': 's', 'Ş': 'S',
        'ü': 'u', 'Ü': 'U'
    };
    return str.replace(/[çÇğĞıİöÖşŞüÜ]/g, char => map[char] || char);
}


/**
 * Search for content on HDFilmCehennemi
 * @param {string} query - Search query (IMDb ID or title)
 * @returns {Promise<Array<{url: string, title: string, year: number|null, type: string, slug: string}>>}
 */
async function searchOnSite(query) {
    const cacheKey = `search:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        // AJAX search endpoint - uses ?q= parameter
        const searchUrl = `${BASE_URL}/search/?q=${encodeURIComponent(query)}`;
        log.info(`Searching: "${query}"`);

        const response = await fetchWithRetry(searchUrl, {
            headers: {
                ...defaultHeaders,
                'X-Requested-With': 'fetch',
                'Accept': 'application/json'
            }
        });

        const data = await response.json();
        const results = [];

        // Parse HTML snippets from JSON response
        if (data.results && Array.isArray(data.results)) {
            for (const htmlStr of data.results) {
                const $ = cheerio.load(htmlStr);
                const link = $('a').attr('href');
                const title = $('h4.title').text().trim() || $('img').attr('alt') || '';
                const yearText = $('.year').text().trim();
                const year = yearText ? parseInt(yearText) : null;
                const type = $('.type').text().trim().toLowerCase();

                if (link && link.includes('hdfilmcehennemi')) {
                    results.push({
                        url: link,
                        title: title,
                        year: year,
                        type: type === 'dizi' ? 'series' : 'movie',
                        slug: link.replace(BASE_URL, '').replace(/\//g, '')
                    });
                }
            }
        }

        log.info(`Search "${query}": ${results.length} results`);
        setCache(cacheKey, results);
        return results;
    } catch (error) {
        log.error(`Search failed: ${error.message}`);
        return [];
    }
}

/**
 * Calculate title similarity score (0-1)
 * @param {string} str1 - First title
 * @param {string} str2 - Second title
 * @returns {number} Similarity score
 */
function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);

    if (s1 === s2) return 1;

    // Word-based comparison
    const words1 = s1.split(' ').filter(w => w.length > 1);
    const words2 = s2.split(' ').filter(w => w.length > 1);

    let matches = 0;
    for (const w1 of words1) {
        if (words2.some(w2 => w2.includes(w1) || w1.includes(w2))) {
            matches++;
        }
    }

    const maxLen = Math.max(words1.length, words2.length);
    return maxLen > 0 ? matches / maxLen : 0;
}

/**
 * Find best matching result from search results
 * @param {Array} results - Search results
 * @param {string} targetTitle - Target title
 * @param {number|null} [targetYear] - Target year
 * @returns {Object|null} Best match or null
 */
function findBestMatch(results, targetTitle, targetYear = null) {
    if (results.length === 0) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const result of results) {
        let score = calculateSimilarity(result.title, targetTitle);

        // Year match bonus
        if (targetYear && result.year) {
            if (result.year === targetYear) {
                score += 0.3;
            } else if (Math.abs(result.year - targetYear) <= 1) {
                score += 0.1;
            }
        }

        // Slug contains title bonus
        const slugNorm = normalizeTitle(turkishToAscii(result.slug));
        const titleNorm = normalizeTitle(turkishToAscii(targetTitle));
        if (slugNorm.includes(titleNorm.split(' ')[0])) {
            score += 0.2;
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
        }
    }

    // Minimum threshold: 40% similarity
    if (bestScore >= 0.4) {
        log.debug(`Best match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
        return bestMatch;
    }

    log.debug(`No match above threshold (best score: ${bestScore.toFixed(2)})`);
    return null;
}


/**
 * Find episode URL from series page
 * @param {string} seriesUrl - Series page URL
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {Promise<string|null>} Episode URL or null
 */
async function findEpisodeUrl(seriesUrl, season, episode) {
    const cacheKey = `episodes:${seriesUrl}`;
    let episodes = getCached(cacheKey);

    if (!episodes) {
        try {
            log.debug(`Fetching episodes from: ${seriesUrl}`);
            const response = await fetchWithRetry(seriesUrl, { headers: defaultHeaders });
            const html = await response.text();
            const $ = cheerio.load(html);

            episodes = [];

            // Find episode links
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('-sezon-') && href.includes('-bolum')) {
                    // Extract season and episode from URL
                    const match = href.match(/(\d+)-sezon-(\d+)-bolum/);
                    if (match) {
                        episodes.push({
                            url: href,
                            season: parseInt(match[1]),
                            episode: parseInt(match[2])
                        });
                    }
                }
            });

            // Alternative format: sezon-X/bolum-Y
            if (episodes.length === 0) {
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && (href.includes('sezon') || href.includes('bolum'))) {
                        const seasonMatch = href.match(/sezon[/-]?(\d+)/i);
                        const episodeMatch = href.match(/bolum[/-]?(\d+)/i);
                        if (seasonMatch && episodeMatch) {
                            episodes.push({
                                url: href,
                                season: parseInt(seasonMatch[1]),
                                episode: parseInt(episodeMatch[1])
                            });
                        }
                    }
                });
            }

            log.debug(`Found ${episodes.length} episodes`);
            setCache(cacheKey, episodes);
        } catch (error) {
            log.error(`Failed to get episodes: ${error.message}`);
            return null;
        }
    }

    // Find requested episode
    const targetEpisode = episodes.find(ep =>
        ep.season === parseInt(season) && ep.episode === parseInt(episode)
    );

    if (targetEpisode) {
        log.debug(`Found episode: S${season}E${episode} -> ${targetEpisode.url}`);
    } else {
        log.warn(`Episode not found: S${season}E${episode}`);
    }

    return targetEpisode?.url || null;
}

/**
 * Find HDFilmCehennemi URL for content by IMDb ID
 * 
 * @param {'movie'|'series'} type - Content type
 * @param {string} imdbId - IMDb ID (e.g., tt0499549)
 * @param {number} [season] - Season number (series only)
 * @param {number} [episode] - Episode number (series only)
 * @returns {Promise<{url: string, title: string, seriesTitle?: string}|null>}
 * @throws {ValidationError|ContentNotFoundError}
 */
async function findContent(type, imdbId, season = null, episode = null) {
    // Input validation
    if (!imdbId || typeof imdbId !== 'string') {
        throw new ValidationError('IMDb ID gerekli', 'imdbId', imdbId);
    }

    if (!isValidImdbId(imdbId)) {
        throw new ValidationError('Geçersiz IMDb ID formatı (örnek: tt1234567)', 'imdbId', imdbId);
    }

    if (type !== 'movie' && type !== 'series') {
        throw new ValidationError('Tür movie veya series olmalı', 'type', type);
    }

    if (type === 'series') {
        if (season && !isValidEpisodeNumber(season)) {
            throw new ValidationError('Geçersiz sezon numarası', 'season', season);
        }
        if (episode && !isValidEpisodeNumber(episode)) {
            throw new ValidationError('Geçersiz bölüm numarası', 'episode', episode);
        }
    }

    log.info(`Finding content: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);

    let match = null;

    // 1. Search by IMDb ID first (most reliable)
    log.debug(`Searching by IMDb ID: ${imdbId}`);
    const imdbResults = await searchOnSite(imdbId);

    if (imdbResults.length > 0) {
        // IMDb search usually returns single exact match
        match = imdbResults[0];
        log.info(`Found via IMDb ID: ${match.title} -> ${match.url}`);
    }

    // 2. Fallback: Get title from Cinemeta and search by title
    if (!match) {
        log.info('IMDb ID search failed, trying title search...');

        const meta = await getMetaFromCinemeta(type, imdbId);
        if (!meta || !meta.name) {
            log.warn('Could not get metadata from Cinemeta');
            throw new ContentNotFoundError(imdbId, { type, reason: 'metadata_not_found' });
        }

        const title = meta.name;
        const year = meta.year ? parseInt(meta.year) : null;
        log.debug(`Title: ${title} (${year || 'unknown year'})`);

        // Title search strategies
        const searchQueries = [title];

        if (meta.originalTitle && meta.originalTitle !== title) {
            searchQueries.push(meta.originalTitle);
        }

        // First word fallback
        const firstWord = title.split(/[\s:\-–—]+/)[0];
        if (firstWord && firstWord.length >= 4) {
            searchQueries.push(firstWord);
        }

        for (const query of searchQueries) {
            if (match) break;

            log.debug(`Searching: "${query}"`);
            const searchResults = await searchOnSite(query);

            if (searchResults.length > 0) {
                match = findBestMatch(searchResults, title, year);

                if (!match && meta.originalTitle) {
                    match = findBestMatch(searchResults, meta.originalTitle, year);
                }
            }
        }
    }

    if (!match) {
        log.warn(`No match found for: ${imdbId}`);
        throw new ContentNotFoundError(imdbId, { type });
    }

    log.info(`Match found: ${match.title} -> ${match.url}`);

    // 3. For series, find episode URL
    if (type === 'series' && season && episode) {
        const episodeUrl = await findEpisodeUrl(match.url, season, episode);
        if (!episodeUrl) {
            throw new ContentNotFoundError(`${match.title} S${season}E${episode}`, {
                type: 'episode',
                season,
                episode
            });
        }
        return {
            url: episodeUrl,
            title: `${match.title} S${season}E${episode}`,
            seriesTitle: match.title
        };
    }

    return {
        url: match.url,
        title: match.title
    };
}

/**
 * Clear all cached data
 */
function clearCache() {
    const size = cache.size;
    cache.clear();
    log.info(`Cache cleared (${size} entries)`);
}

/**
 * Get cache statistics
 * @returns {{size: number, keys: string[]}}
 */
function getCacheStats() {
    return {
        size: cache.size,
        keys: Array.from(cache.keys())
    };
}

module.exports = {
    findContent,
    searchOnSite,
    getMetaFromCinemeta,
    clearCache,
    getCacheStats,
    isValidImdbId
};
