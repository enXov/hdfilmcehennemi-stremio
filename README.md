# HDFilmCehennemi Stremio Addon

HDFilmCehennemi içeriklerini Stremio üzerinden izlemenizi sağlayan bir addon.

## Özellikler

- 🎬 Film ve dizi desteği
- 🎙️ Çoklu ses seçeneği (Türkçe dublaj, orijinal ses)
- 📝 Altyazı desteği
- 🔄 Otomatik alternatif kaynak geçişi

## Kurulum

### Gereksinimler

- Node.js 18+
- npm

### Yerel Kurulum

```bash
# Repoyu klonla
git clone https://github.com/enXov/hdfilmcehennemi-stremio.git
cd hdfilmcehennemi-stremio

# Bağımlılıkları yükle
npm install

# Addon'u başlat
npm start
```

Addon varsayılan olarak `http://localhost:7000` adresinde çalışır.

### Addon'u Test Etme

```bash
npm test
```

### Stremio'ya Ekleme

1. Addon'u başlat
2. Stremio'yu aç
3. Ayarlar > Addons > Community Addons
4. `http://localhost:7000/manifest.json` adresini ekle

## Kullanım

Addon kurulduktan sonra, Stremio'da bir film veya dizi seçtiğinizde HDFilmCehennemi kaynakları otomatik olarak görünecektir.


## Proje Yapısı

```
├── addon.js      # Stremio addon sunucusu
├── scraper.js    # Video/altyazı çekme modülü
├── search.js     # İçerik arama ve eşleştirme
├── test.js       # Test scripti
└── package.json
```

## Lisans

MIT License - Detaylar için [LICENSE](LICENSE) dosyasına bakın.

## Sorumluluk Reddi

Bu addon yalnızca eğitim amaçlıdır. İçeriklerin telif hakları sahiplerine aittir.
