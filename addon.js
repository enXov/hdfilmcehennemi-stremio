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

        // Find content on HDFilmCehennemi
        const content = await findContent(type, imdbId, season, episode);

        log.info(`Content found: ${content.url}`);

        // Extract video and subtitle data
        const result = await getVideoAndSubtitles(content.url);

        // Convert to Stremio format
        const streams = toStremioStreams(result, content.title);

        const elapsed = Date.now() - startTime;
        log.info(`Returning ${streams.streams.length} stream(s) for ${imdbId} (${elapsed}ms)`);

        return streams;

    } catch (error) {
        const elapsed = Date.now() - startTime;

        // Handle specific error types
        if (error instanceof ValidationError) {
            log.warn(`Validation error: ${error.message} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof ContentNotFoundError) {
            log.info(`Content not found: ${error.query} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof ScrapingError) {
            log.warn(`Scraping error: ${error.message} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof TimeoutError) {
            log.error(`Timeout: ${error.url} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof NetworkError) {
            log.error(`Network error: ${error.message} [${error.statusCode}] (${elapsed}ms)`);
            return { streams: [] };
        }

        // Unknown error
        log.error(`Unexpected error: ${error.message} (${elapsed}ms)`, error);
        return { streams: [] };
    }
});

// Start server
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT });
log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
