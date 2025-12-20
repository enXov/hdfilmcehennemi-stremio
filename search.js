/**
 * HDFilmCehennemi Search & Matching Module
 * 
 * IMDb ID -> HDFilmCehennemi URL eşleştirmesi
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.hdfilmcehennemi.ws';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

// Basit in-memory cache
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 dakika

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

/**
 * Cache'den veri al veya yeni veri çek
 */
function getCached(key) {
    const item = cache.get(key);
    if (item && Date.now() - item.timestamp < CACHE_TTL) {
        return item.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Cinemeta'dan IMDb ID ile içerik bilgisi al
 */
async function getMetaFromCinemeta(type, imdbId) {
    const cacheKey = `meta:${type}:${imdbId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const url = `${CINEMETA_URL}/${type}/${imdbId}.json`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.log(`Cinemeta yanıt vermedi: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        if (data?.meta) {
            setCache(cacheKey, data.meta);
            return data.meta;
        }
        return null;
    } catch (error) {
        console.error('Cinemeta hatası:', error.message);
        return null;
    }
}

/**
 * Başlığı arama için normalize et
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
 * Türkçe karakterleri ASCII'ye çevir (URL slug için)
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
 * HDFilmCehennemi'de başlık ara
 */
async function searchOnSite(query) {
    const cacheKey = `search:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, { headers: defaultHeaders });
        const html = await response.text();
        const $ = cheerio.load(html);
        
        const results = [];
        
        // Arama sonuçlarını parse et
        $('.movie-preview, .poster, article').each((i, el) => {
            const $el = $(el);
            const link = $el.find('a').first().attr('href') || $el.attr('href');
            const title = $el.find('.title, h2, h3').first().text().trim() || 
                         $el.find('a').first().attr('title') || 
                         $el.find('img').attr('alt') || '';
            const year = $el.find('.year, .date').first().text().trim();
            
            if (link && link.includes(BASE_URL)) {
                results.push({
                    url: link,
                    title: title,
                    year: year ? parseInt(year) : null,
                    slug: link.replace(BASE_URL, '').replace(/\//g, '')
                });
            }
        });
        
        // Alternatif: Direkt film kartlarını ara
        if (results.length === 0) {
            $('a[href*="hdfilmcehennemi"]').each((i, el) => {
                const href = $(el).attr('href');
                const title = $(el).attr('title') || $(el).text().trim();
                
                // Film/dizi sayfası URL'si mi kontrol et
                if (href && !href.includes('?s=') && !href.includes('/tag/') && 
                    !href.includes('/category/') && title) {
                    const existing = results.find(r => r.url === href);
                    if (!existing) {
                        results.push({
                            url: href,
                            title: title,
                            year: null,
                            slug: href.replace(BASE_URL, '').replace(/\//g, '')
                        });
                    }
                }
            });
        }
        
        setCache(cacheKey, results);
        return results;
    } catch (error) {
        console.error('Arama hatası:', error.message);
        return [];
    }
}

/**
 * İki başlığın benzerliğini hesapla (0-1 arası)
 */
function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);
    
    if (s1 === s2) return 1;
    
    // Kelime bazlı karşılaştırma
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
 * En iyi eşleşmeyi bul
 */
function findBestMatch(results, targetTitle, targetYear = null) {
    if (results.length === 0) return null;
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const result of results) {
        let score = calculateSimilarity(result.title, targetTitle);
        
        // Yıl eşleşmesi bonus puan
        if (targetYear && result.year) {
            if (result.year === targetYear) {
                score += 0.3;
            } else if (Math.abs(result.year - targetYear) <= 1) {
                score += 0.1;
            }
        }
        
        // Slug'da başlık geçiyorsa bonus
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
    
    // Minimum eşik: %40 benzerlik
    return bestScore >= 0.4 ? bestMatch : null;
}


/**
 * Dizi sayfasından bölüm URL'sini bul
 */
async function findEpisodeUrl(seriesUrl, season, episode) {
    const cacheKey = `episodes:${seriesUrl}`;
    let episodes = getCached(cacheKey);
    
    if (!episodes) {
        try {
            const response = await fetch(seriesUrl, { headers: defaultHeaders });
            const html = await response.text();
            const $ = cheerio.load(html);
            
            episodes = [];
            
            // Bölüm linklerini bul
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('-sezon-') && href.includes('-bolum')) {
                    // URL'den sezon ve bölüm numarasını çıkar
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
            
            // Alternatif format: sezon-X/bolum-Y
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
            
            setCache(cacheKey, episodes);
        } catch (error) {
            console.error('Bölüm listesi hatası:', error.message);
            return null;
        }
    }
    
    // İstenen bölümü bul
    const targetEpisode = episodes.find(ep => 
        ep.season === parseInt(season) && ep.episode === parseInt(episode)
    );
    
    return targetEpisode?.url || null;
}

/**
 * IMDb ID'den HDFilmCehennemi URL'si bul
 * 
 * @param {string} type - 'movie' veya 'series'
 * @param {string} imdbId - IMDb ID (tt1234567)
 * @param {number} season - Sezon numarası (sadece series için)
 * @param {number} episode - Bölüm numarası (sadece series için)
 * @returns {Promise<{url: string, title: string}|null>}
 */
async function findContent(type, imdbId, season = null, episode = null) {
    console.log(`İçerik aranıyor: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
    
    // 1. Cinemeta'dan başlık bilgisi al
    const meta = await getMetaFromCinemeta(type, imdbId);
    if (!meta) {
        console.log('Cinemeta\'dan bilgi alınamadı');
        return null;
    }
    
    const title = meta.name;
    const year = meta.year ? parseInt(meta.year) : null;
    console.log(`Başlık: ${title} (${year || 'yıl bilinmiyor'})`);
    
    // 2. HDFilmCehennemi'de ara
    const searchResults = await searchOnSite(title);
    console.log(`${searchResults.length} sonuç bulundu`);
    
    // 3. En iyi eşleşmeyi bul
    let match = findBestMatch(searchResults, title, year);
    
    // Eşleşme bulunamadıysa alternatif aramalar dene
    if (!match) {
        // Orijinal başlık ile dene
        if (meta.originalTitle && meta.originalTitle !== title) {
            console.log(`Orijinal başlık deneniyor: ${meta.originalTitle}`);
            const altResults = await searchOnSite(meta.originalTitle);
            match = findBestMatch(altResults, meta.originalTitle, year);
        }
        
        // Hala bulunamadıysa sadece ilk kelime ile dene
        if (!match) {
            const firstWord = title.split(' ')[0];
            if (firstWord.length > 3) {
                console.log(`İlk kelime deneniyor: ${firstWord}`);
                const altResults = await searchOnSite(firstWord);
                match = findBestMatch(altResults, title, year);
            }
        }
    }
    
    if (!match) {
        console.log('Eşleşme bulunamadı');
        return null;
    }
    
    console.log(`Eşleşme bulundu: ${match.title} -> ${match.url}`);
    
    // 4. Dizi ise bölüm URL'sini bul
    if (type === 'series' && season && episode) {
        const episodeUrl = await findEpisodeUrl(match.url, season, episode);
        if (!episodeUrl) {
            console.log(`Bölüm bulunamadı: S${season}E${episode}`);
            return null;
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
 * Cache'i temizle
 */
function clearCache() {
    cache.clear();
}

/**
 * Cache istatistikleri
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
    getCacheStats
};
