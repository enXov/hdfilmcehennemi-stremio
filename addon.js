/**
 * HDFilmCehennemi Stremio Addon Server
 * 
 * Main entry point for the Stremio addon.
 * 
 * @module addon
 */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');
const { findContent, isValidImdbId } = require('./search');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ScrapingError, ValidationError, NetworkError, TimeoutError } = require('./errors');

const log = createLogger('Addon');

const manifest = {
    id: 'community.hdfilmcehennemi',
    version: '1.1.0',
    name: 'HDFilmCehennemi',
    description: 'HDFilmCehennemi üzerinden film ve dizi izleyin. Türkçe dublaj ve altyazı desteği.',
    logo: 'https://www.hdfilmcehennemi.ws/favicon.ico',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

// Success-only cache - only caches fully successful results (video found & extracted)
const streamCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Stream handler - Find content on HDFilmCehennemi and return streams
 */
builder.defineStreamHandler(async ({ type, id }) => {
    const startTime = Date.now();
    log.info(`Stream request: ${type} - ${id}`);

    try {
        // Parse IMDb ID
        const [imdbId, season, episode] = id.split(':');

        // Validate input
        if (!imdbId) {
            log.warn('Missing IMDb ID');
            return { streams: [] };
        }

        if (!isValidImdbId(imdbId)) {
            log.warn(`Invalid IMDb ID format: ${imdbId}`);
            return { streams: [] };
        }

        // Check cache first - only contains successful results
        const cacheKey = id;
        const cached = streamCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            const elapsed = Date.now() - startTime;
            log.info(`Cache hit for ${id} (${elapsed}ms)`);
            return cached.data;
        }

        // Find content on HDFilmCehennemi
        const content = await findContent(type, imdbId, season, episode);

        log.info(`Content found: ${content.url}`);

        // Extract video and subtitle data
        const result = await getVideoAndSubtitles(content.url);

        // Convert to Stremio format
        const streams = toStremioStreams(result, content.title);

        const elapsed = Date.now() - startTime;
        log.info(`Returning ${streams.streams.length} stream(s) for ${imdbId} (${elapsed}ms)`);

        // Cache ONLY on full success (we got here without errors)
        streamCache.set(cacheKey, { data: streams, timestamp: Date.now() });
        log.debug(`Cached successful result for: ${id}`);

        return streams;

    } catch (error) {
        const elapsed = Date.now() - startTime;

        // Helper to create an error stream that shows message to user
        const errorStream = (title, description) => ({
            streams: [{
                name: 'HDFilmCehennemi',
                title: `⚠️ ${title}`,
                description: description,
                externalUrl: 'https://www.hdfilmcehennemi.ws'
            }]
        });

        // Handle specific error types with user-visible messages
        if (error instanceof ValidationError) {
            log.warn(`Validation error: ${error.message} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof ContentNotFoundError) {
            log.info(`Content not found: ${error.query} (${elapsed}ms)`);
            return errorStream(
                'İçerik Bulunamadı',
                'Bu içerik HDFilmCehennemi\'de mevcut değil.'
            );
        }

        if (error instanceof ScrapingError) {
            log.warn(`Scraping error: ${error.message} (${elapsed}ms)`);
            return errorStream(
                'İçerik Kaldırılmış',
                'Bu içerik DMCA veya telif hakkı nedeniyle kaldırılmış olabilir.'
            );
        }

        if (error instanceof TimeoutError) {
            log.error(`Timeout: ${error.url} (${elapsed}ms)`);
            return errorStream(
                'Bağlantı Zaman Aşımı',
                'Sunucu yanıt vermedi. Lütfen tekrar deneyin.'
            );
        }

        if (error instanceof NetworkError) {
            log.error(`Network error: ${error.message} [${error.statusCode}] (${elapsed}ms)`);
            return errorStream(
                'Bağlantı Hatası',
                'HDFilmCehennemi\'ye bağlanılamadı.'
            );
        }

        // Unknown error
        log.error(`Unexpected error: ${error.message} (${elapsed}ms)`, error);
        return errorStream(
            'Bilinmeyen Hata',
            'Bir hata oluştu. Lütfen daha sonra tekrar deneyin.'
        );
    }
});

// Start server
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT });
log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
