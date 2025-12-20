/**
 * HDFilmCehennemi Stremio Addon Server
 */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getVideoAndSubtitles, toStremioStreams } = require('./index');
const { findContent } = require('./search');

const manifest = {
    id: 'community.hdfilmcehennemi',
    version: '1.0.0',
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
 * Stream handler - IMDb ID ile içerik ara ve stream döndür
 */
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`Stream request: ${type} - ${id}`);
    
    try {
        // IMDb ID'yi parse et
        const [imdbId, season, episode] = id.split(':');
        
        if (!imdbId || !imdbId.startsWith('tt')) {
            console.log('Geçersiz IMDb ID');
            return { streams: [] };
        }
        
        // HDFilmCehennemi'de içerik ara
        const content = await findContent(type, imdbId, season, episode);
        
        if (!content) {
            console.log('İçerik bulunamadı');
            return { streams: [] };
        }
        
        console.log(`İçerik bulundu: ${content.url}`);
        
        // Video ve altyazı bilgilerini çek
        const result = await getVideoAndSubtitles(content.url);
        
        if (!result || !result.videoUrl) {
            console.log('Video URL alınamadı');
            return { streams: [] };
        }
        
        // Stremio formatına çevir
        const streams = toStremioStreams(result, content.title);
        console.log(`${streams.streams.length} stream döndürülüyor`);
        
        return streams;
        
    } catch (error) {
        console.error('Stream handler error:', error.message);
        return { streams: [] };
    }
});

// Server'ı başlat
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`HDFilmCehennemi Addon running at http://localhost:${PORT}/manifest.json`);
