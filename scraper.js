/**
 * HDFilmCehennemi Stremio Addon
 * 
 * Video ve altyazı çekici
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.hdfilmcehennemi.ws';
const EMBED_BASE = 'https://hdfilmcehennemi.mobi';

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

/**
 * HTTP GET request
 */
async function httpGet(url, referer = null) {
    const headers = { ...defaultHeaders };
    if (referer) headers['Referer'] = referer;

    const response = await fetch(url, { headers });
    return response.text();
}

/**
 * JavaScript packer unpacker
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
 * Şifreli video URL'sini decode et
 */
function decodeVideoUrl(parts) {
    let value = parts.join('');
    value = value.split('').reverse().join('');
    value = Buffer.from(value, 'base64').toString('utf8');
    value = Buffer.from(value, 'base64').toString('latin1');

    let unmix = '';
    for (let i = 0; i < value.length; i++) {
        let charCode = value.charCodeAt(i);
        charCode = (charCode - (399756995 % (i + 5)) + 256) % 256;
        unmix += String.fromCharCode(charCode);
    }
    return unmix;
}

/**
 * iframe URL'sinden video ve altyazı bilgilerini çek
 */
async function scrapeIframe(iframeSrc) {
    try {
        const html = await httpGet(iframeSrc, BASE_URL);
        const $ = cheerio.load(html);

        const result = {
            videoUrl: null,
            subtitles: [],
            audioTracks: []
        };

        // <track> elementlerinden altyazıları çek
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

        // Packed JS'i decode et
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+)',(\d+),(\d+),'([^']+)'/s);

        if (packedMatch) {
            const decoded = unpackJS(
                packedMatch[1],
                parseInt(packedMatch[2]),
                parseInt(packedMatch[3]),
                packedMatch[4]
            );

            // Video URL'sini decode et
            const partsMatch = decoded.match(/dc_\w+\(\[([^\]]+)\]\)/);
            if (partsMatch) {
                const parts = partsMatch[1].match(/"([^"]+)"/g).map(s => s.replace(/"/g, ''));
                result.videoUrl = decodeVideoUrl(parts);
            }

            // m3u8'den ses track'lerini çek
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
                } catch (e) {
                    console.log('m3u8 çekilemedi:', e.message);
                }
            }
        }

        return result;

    } catch (error) {
        console.error('iframe scrape hatası:', error.message);
        return null;
    }
}

/**
 * Sayfa URL'sinden video ve altyazı bilgilerini çek
 * Fallback: Eğer ilk kaynak başarısız olursa alternatif kaynakları dener
 */
async function getVideoAndSubtitles(pageUrl) {
    try {
        const html = await httpGet(pageUrl);
        const $ = cheerio.load(html);

        // iframe'i bul
        const iframe = $('iframe');
        const iframeSrc = iframe.attr('src') || iframe.attr('data-src');

        if (!iframeSrc) {
            console.log('iframe bulunamadı!');
            return null;
        }

        // Alternatif kaynakları bul
        const altSources = [];
        $('.alternative-link').each((i, el) => {
            altSources.push({
                name: $(el).text().trim(),
                videoId: $(el).attr('data-video'),
                active: $(el).attr('data-active') === '1'
            });
        });

        // Aktif kaynağı dene
        let result = await scrapeIframe(iframeSrc);

        // Fallback: Eğer video URL alınamadıysa alternatif kaynakları dene
        if (!result || !result.videoUrl) {
            console.log('İlk kaynak başarısız, alternatifler deneniyor...');

            const videoIdMatch = iframeSrc.match(/embed\/([^\/\?]+)/);
            if (videoIdMatch) {
                const videoId = videoIdMatch[1];

                for (const alt of altSources) {
                    if (alt.active) continue;

                    console.log(`Deneniyor: ${alt.name}`);

                    let altIframeSrc = iframeSrc;
                    if (alt.name.toLowerCase() === 'rapidrame') {
                        altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/?rapidrame_id=${alt.videoId}`;
                    } else {
                        altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/`;
                    }

                    const altResult = await scrapeIframe(altIframeSrc);
                    if (altResult && altResult.videoUrl) {
                        result = altResult;
                        result.source = alt.name;
                        break;
                    }
                }
            }
        } else {
            const activeSource = altSources.find(s => s.active);
            if (activeSource) {
                result.source = activeSource.name;
            }
        }

        if (result) {
            result.alternativeSources = altSources;
        }

        return result;

    } catch (error) {
        console.error('Hata:', error.message);
        return null;
    }
}

/**
 * Dizi bölümlerini listele
 */
async function getSeriesEpisodes(seriesUrl) {
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

        return episodes;
    } catch (error) {
        console.error('Bölüm listesi hatası:', error.message);
        return [];
    }
}

/**
 * Stremio stream formatına çevir
 */
function toStremioStreams(result, title = 'HDFilmCehennemi') {
    if (!result || !result.videoUrl) return { streams: [] };

    const streams = [];

    // Video sunucusu Referer header'ı istiyor - yoksa 404 döner
    const behaviorHints = {
        notWebReady: true,
        proxyHeaders: {
            request: {
                'Referer': EMBED_BASE + '/',
                'Origin': EMBED_BASE
            }
        }
    };

    // Her ses track'i için ayrı stream oluştur
    if (result.audioTracks.length > 0) {
        for (const audio of result.audioTracks) {
            streams.push({
                url: result.videoUrl,
                title: audio.name,
                name: 'HDFilmCehennemi',
                behaviorHints: behaviorHints,
                subtitles: result.subtitles.map(s => ({
                    id: s.id,
                    url: s.url,
                    lang: s.lang,
                    label: s.label
                }))
            });
        }
    } else {
        // Ses track'i yoksa tek stream
        streams.push({
            url: result.videoUrl,
            title: 'Original audio',
            name: 'HDFilmCehennemi',
            behaviorHints: behaviorHints,
            subtitles: result.subtitles.map(s => ({
                id: s.id,
                url: s.url,
                lang: s.lang,
                label: s.label
            }))
        });
    }

    return { streams };
}

module.exports = {
    getVideoAndSubtitles,
    getSeriesEpisodes,
    toStremioStreams,
    BASE_URL,
    EMBED_BASE
};
