# Oscoliat Puan Defteri

## Yerelde çalıştırma
1. Node.js 18+ kur, `npm install`
2. `cp .env.example .env`, ADMIN_PASSWORD ve STEAM_API_KEY yaz (Turso alanlarını boş bırak)
3. `npm start` -> http://localhost:3000 (Steam listesi ilk açılışta otomatik çekilir)

## Ücretsiz yayına alma (Render + Turso + GitHub)
1. **GitHub:** Ücretsiz hesapla yeni bir *private* depo aç, bu klasörü yükle (`.env` yüklenmez, `.gitignore` engeller).
2. **Turso (kalıcı veritabanı):** turso.tech'te hesap aç, bir veritabanı oluştur. Panelden `TURSO_DATABASE_URL` (libsql://...) ve bir veritabanı token'ı (`TURSO_AUTH_TOKEN`) al.
3. **Render:** render.com'da GitHub ile giriş yap, New > Blueprint seç, depoyu göster. `render.yaml` her şeyi hazırlar. Sorulan 4 değeri gir: `ADMIN_PASSWORD`, `STEAM_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. Birkaç dakika sonra `https://oscoliat-log.onrender.com` benzeri bir adres verilir. İlk açılışta Steam listesi arka planda çekilir, 1-2 dakika sürebilir.
5. **OBS overlay:** `https://ADRESIN/overlay.html`

## Bilmen gerekenler
- Render ücretsiz planı 15 dk trafik olmazsa uyur, ilk istekte ~1 dk geç açılır. OBS overlay'i açıkken sayfa 2 sn'de bir istek attığı için yayın boyunca uyumaz. İstersen ücretsiz UptimeRobot ile 5 dk'da bir ping at.
- Kayıtlar Turso'da durur; sunucu yeniden başlasa da silinmez. Yine de arada CSV indirip yedek al.
- Domain alınca Render panelinden Custom Domain eklenir, kod değişmez.
