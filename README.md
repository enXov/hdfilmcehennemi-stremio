# HDFilmCehennemi Stremio Addon

HDFilmCehennemi içeriklerini Stremio üzerinden izlemenizi sağlayan bir addon.

## Özellikler

- 🎬 Film ve dizi desteği
- 🎙️ Çoklu ses seçeneği (Türkçe dublaj, orijinal ses)
- 📝 Altyazı desteği
- 🔄 Otomatik alternatif kaynak geçişi

## Kurulum Seçenekleri

### Seçenek 1: Kendi Sunucunuzda Çalıştırma

Bu addon'u kendi VPS/sunucunuzda çalıştırabilirsiniz. 

NOTLAR:
Stremio sadece HTTPs kabul ediyor, yani bir domain veya reverse proxy şart.
Eğer sunucunuz Türkiye dışında ise ki genellikle dışında olur o zaman normal proxy'e ihtiyacınız var. HDFilmCehennemi nedense erişimi Türkiye dışındaki ülkelere erişimi kısıtlamış(cloudflare). Fakat özellikle proxy belirlemenizi önermem çünkü şuanda public free proxy list kullanıyoruz Türkiye lokasyonlu.

FREE PUBLIC PROXY LIST GÜVENİLİR Mİ??????: kişiden kişiye değişir fakat %99 ihtimal ile güvenli, proxy sahibi sadece nereye istek attığınızı, isteğin içeriğni ve IP adresinizi görüyor fakat görse bir şey olmaz çünkü atılan istek zaten HDFilmCehennemi sitesi bunu bilse bir şey olmaz. Eğer çok endişeli iseniz film/dizi izledikten sonra modeminizi resetleyebilirsiniz(modem resetlendikten sonra IP adresiniz otomatik olarak değişecektir. Eski bir router'ınız yok ise). Sadece search/scraping için proxy kullanıyoruz, video url normal bir şekilde proxysiz oynatılıyor.

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
| `PROXY_ENABLED` | auto | Proxy modu: `auto` (gerektiğinde), `always` (her zaman), `never` (kapalı) |
| `PROXY_LIST_URL` | ProxyScrape TR | Özel proxy listesi URL'i (opsiyonel) |

### Örnek .env

```env
PORT=7000
LOG_LEVEL=info
PROXY_ENABLED=auto
# PROXY_LIST_URL=https://custom-proxy-list.com/tr.txt
```

Örnek kullanım:
```bash
PORT=8080 LOG_LEVEL=debug npm start
```

---

## 🧪 Test

```bash
npm test
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

## 📜 Lisans

MIT License - Detaylar için [LICENSE](LICENSE) dosyasına bakın.

## ⚠️ Sorumluluk Reddi

Bu addon yalnızca eğitim amaçlıdır. İçeriklerin telif hakları sahiplerine aittir. Addon geliştiricisi içeriklerden sorumlu değildir.
