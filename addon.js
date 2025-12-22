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
 * Rewrites all URLs to go through our proxy for full TV compatibility
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

        // Get base URL for resolving relative paths
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

        // Helper to create proxied URL
        const proxyUrl = (originalUrl) => {
            const fullUrl = originalUrl.startsWith('http') ? originalUrl : baseUrl + originalUrl;
            const encodedUrl = Buffer.from(fullUrl).toString('base64');
            return `${BASE_URL}/proxy/stream?url=${encodedUrl}&ref=${ref}`;
        };

        // Rewrite ALL URLs to go through our proxy
        content = content.split('\n').map(line => {
            const trimmed = line.trim();

            // Handle URI= in comments (audio/subtitle tracks)
            if (trimmed.includes('URI="')) {
                return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                    return `URI="${proxyUrl(uri)}"`;
                });
            }

            // Skip other comments and empty lines
            if (trimmed.startsWith('#') || trimmed === '') {
                return line;
            }

            // Rewrite segment/playlist URLs
            return proxyUrl(trimmed);
        }).join('\n');

        // Return m3u8 content with proper headers
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        res.send(content);

        log.info(`Proxied m3u8: ${content.length} bytes`);

    } catch (error) {
        log.error(`Proxy m3u8 error: ${error.message}`);
        res.status(500).send('Proxy error');
    }
});

/**
 * Stream Proxy Endpoint - Proxies video segments with Referer header
 * Handles both m3u8 sub-playlists and .ts/.m4s segments
 */
app.get('/proxy/stream', async (req, res) => {
    try {
        const { url, ref } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters
        const streamUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        // Get base URL for this stream (for nested m3u8 files)
        const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

        // Fetch stream with Referer header
        const response = await fetch(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': referer,
                'Origin': referer ? new URL(referer).origin : ''
            }
        });

        if (!response.ok) {
            log.error(`Proxy stream failed: ${response.status} for ${streamUrl.substring(0, 60)}...`);
            return res.status(response.status).send('Failed to fetch stream');
        }

        // Check if this is an m3u8 playlist (needs URL rewriting)
        const contentType = response.headers.get('content-type') || '';
        const isM3u8 = streamUrl.endsWith('.m3u8') || streamUrl.endsWith('.txt') ||
            contentType.includes('mpegurl') || contentType.includes('m3u8');

        if (isM3u8) {
            let content = await response.text();

            // Helper to create proxied URL
            const proxyUrl = (originalUrl) => {
                const fullUrl = originalUrl.startsWith('http') ? originalUrl : baseUrl + originalUrl;
                const encodedUrl = Buffer.from(fullUrl).toString('base64');
                return `${BASE_URL}/proxy/stream?url=${encodedUrl}&ref=${ref}`;
            };

            // Rewrite URLs in the playlist
            content = content.split('\n').map(line => {
                const trimmed = line.trim();

                // Handle URI= in comments
                if (trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                        return `URI="${proxyUrl(uri)}"`;
                    });
                }

                // Skip other comments and empty lines
                if (trimmed.startsWith('#') || trimmed === '') {
                    return line;
                }

                // Rewrite segment URLs
                return proxyUrl(trimmed);
            }).join('\n');

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-cache');
            res.send(content);
        } else {
            // Binary content (video/audio segments) - pipe directly
            res.set('Content-Type', contentType || 'video/mp2t');
            res.set('Cache-Control', 'max-age=3600');

            // Pipe the response body
            const reader = response.body.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
            };
            await pump();
        }

    } catch (error) {
        log.error(`Proxy stream error: ${error.message}`);
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
