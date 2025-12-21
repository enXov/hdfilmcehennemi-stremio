# HDFilmCehennemi Stremio Addon

HDFilmCehennemi içeriklerini Stremio üzerinden izlemenizi sağlayan bir addon.

## Özellikler

- 🎬 Film ve dizi desteği
- 🎙️ Çoklu ses seçeneği (Türkçe dublaj, orijinal ses)
- 📝 Altyazı desteği
- 🔄 Otomatik alternatif kaynak geçişi

## Kurulum Seçenekleri

### Seçenek 1: Kendi Sunucunuzda Çalıştırma

Bu addon'u kendi VPS/sunucunuzda çalıştırabilirsiniz. Ben kendi VPS sunucumda domainsiz bir şekilde çalıştırdığım için link vermiyorum.

### Seçenek 2: Yerel Olarak Çalıştırma

Bilgisayarınızda yerel olarak çalıştırabilirsiniz (sadece aynı ağdaki cihazlarda çalışır).

## 💻 Yerel Kurulum

### Gereksinimler

- Node.js 18+
- npm

### Kurulum

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

---

## 🔧 Yapılandırma

### Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `PORT` | 7000 | Sunucu portu |
| `LOG_LEVEL` | info | Log seviyesi (debug, info, warn, error) |

Örnek:
```bash
PORT=8080 LOG_LEVEL=debug npm start
```

---

## 📁 Proje Yapısı

```
├── addon.js      # Stremio addon sunucusu
├── scraper.js    # Video/altyazı çekme modülü
├── search.js     # İçerik arama ve eşleştirme
├── logger.js     # Log sistemi
├── errors.js     # Hata sınıfları
├── test.js       # Test scripti
└── package.json
```

---

## 🧪 Test

```bash
npm test
```

---

## 📜 Lisans

MIT License - Detaylar için [LICENSE](LICENSE) dosyasına bakın.

## ⚠️ Sorumluluk Reddi

Bu addon yalnızca eğitim amaçlıdır. İçeriklerin telif hakları sahiplerine aittir. Addon geliştiricisi içeriklerden sorumlu değildir.
