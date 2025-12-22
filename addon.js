/**
 * HDFilmCehennemi Stremio Addon Server
 * 
 * Main entry point for the Stremio addon.
 * Includes m3u8 proxy endpoint for TV compatibility.
 * 
 * @module addon
 */

// Load environment variables from .env file
require('dotenv').config();

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { fetch } = require('undici');
const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');
const { findContent, isValidImdbId } = require('./search');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ScrapingError, ValidationError, NetworkError, TimeoutError } = require('./errors');

const log = createLogger('Addon');

// Server configuration
const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const manifest = {
    id: 'community.hdfilmcehennemi',
    version: '1.2.0',
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

        // Convert to Stremio format with proxy URL for TV compatibility
        const streams = toStremioStreams(result, content.title, BASE_URL);

        const elapsed = Date.now() - startTime;
        log.info(`Returning ${streams.streams.length} stream(s) for ${imdbId} (${elapsed}ms)`);

        return streams;

    } catch (error) {
        const elapsed = Date.now() - startTime;

        // Helper to create user-friendly error message stream
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

// Create Express app with Stremio addon router
const app = express();

// Add CORS headers for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

/**
 * M3U8 Proxy Endpoint - Fetches m3u8 with proper Referer header
 * This enables TV/Android playback where proxyHeaders don't work
 * 
 * Query params:
 * - url: Base64-encoded m3u8 URL
 * - ref: Base64-encoded Referer URL
 */
app.get('/proxy/m3u8', async (req, res) => {
    try {
        const { url, ref } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters
        const videoUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        log.debug(`Proxy m3u8: ${videoUrl.substring(0, 80)}...`);
        log.debug(`Referer: ${referer}`);

        // Get base URL for rewriting relative paths
        const urlObj = new URL(videoUrl);
        const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf('/') + 1);

        // Fetch m3u8 with Referer header
        const response = await fetch(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': referer,
                'Origin': referer ? new URL(referer).origin : ''
            }
        });

        if (!response.ok) {
            log.error(`Proxy fetch failed: ${response.status}`);
            return res.status(response.status).send('Failed to fetch m3u8');
        }

        let content = await response.text();

        // Rewrite relative URLs to absolute URLs
        // Match lines that don't start with # and aren't absolute URLs
        content = content.split('\n').map(line => {
            const trimmed = line.trim();
            // Skip comments and empty lines
            if (trimmed.startsWith('#') || trimmed === '') {
                // But check for URI= in comments (like audio tracks)
                if (trimmed.includes('URI="') && !trimmed.includes('URI="http')) {
                    return trimmed.replace(/URI="([^"]+)"/g, `URI="${baseUrl}$1"`);
                }
                return line;
            }
            // If it's a relative URL, make it absolute
            if (!trimmed.startsWith('http')) {
                return baseUrl + trimmed;
            }
            return line;
        }).join('\n');

        // Return m3u8 content with proper headers
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        res.send(content);

        log.info(`Proxied m3u8: ${content.length} bytes`);

    } catch (error) {
        log.error(`Proxy error: ${error.message}`);
        res.status(500).send('Proxy error');
    }
});

// Mount Stremio addon router
app.use(getRouter(builder.getInterface()));

// Start server
app.listen(PORT, () => {
    log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
    log.info(`M3U8 Proxy endpoint: ${BASE_URL}/proxy/m3u8`);
    log.info(`Set BASE_URL env var for production (current: ${BASE_URL})`);
});
