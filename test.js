/**
 * HDFilmCehennemi Addon Test
 */

const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');

async function test() {
    console.log('='.repeat(60));
    console.log('HDFilmCehennemi Stremio Addon Test');
    console.log('='.repeat(60));

    const testUrl = 'https://www.hdfilmcehennemi.ws/wake-up-dead-man-a-knives-out-mystery/';
    console.log(`\nTest URL: ${testUrl}\n`);

    const result = await getVideoAndSubtitles(testUrl);

    if (!result) {
        console.log('❌ Sonuç alınamadı!');
        return;
    }

    console.log('✅ Başarılı!\n');

    // Kaynak
    if (result.source) {
        console.log(`📡 Kaynak: ${result.source}`);
    }

    // Video URL
    console.log('\n📹 Video URL:');
    console.log(`   ${result.videoUrl || 'Yok'}`);

    // Ses Track'leri
    console.log(`\n🔊 Ses Track'leri (${result.audioTracks.length}):`);
    for (const track of result.audioTracks) {
        console.log(`   [${track.name}]`);
        console.log(`   ${track.url}`);
    }

    // Altyazılar
    console.log(`\n📝 Altyazılar (${result.subtitles.length}):`);
    for (const sub of result.subtitles) {
        const def = sub.default ? ' ⭐' : '';
        console.log(`   [${sub.lang}] ${sub.label}${def}`);
        console.log(`   ${sub.url}`);
    }

    // Alternatif Kaynaklar
    console.log(`\n🔄 Alternatif Kaynaklar (${result.alternativeSources.length}):`);
    for (const src of result.alternativeSources) {
        const active = src.active ? ' ✓' : '';
        console.log(`   ${src.name}${active}`);
    }

    console.log('\n' + '='.repeat(60));

    // Stremio stream format
    console.log('\n📦 Stremio Stream Format:');
    const stremioFormat = toStremioStreams(result, 'Bıçaklar Çekildi');
    console.log(JSON.stringify(stremioFormat, null, 2));
}

test().catch(console.error);
