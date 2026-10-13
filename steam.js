const catalog = require('./catalog');
let running = false;
async function syncSteam() {
  const key = process.env.STEAM_API_KEY;
  if (running) return; running = true;
  try {
    if (!key) {
      // Anahtarsız yedek yol: eski herkese açık liste (Steam kaldırmış olabilir, deneme amaçlı)
      const r = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
      if (!r.ok) throw new Error('Anahtarsız Steam listesi alınamadı (' + r.status + '). STEAM_API_KEY ekle.');
      const apps = (await r.json()).applist.apps;
      const ins0 = catalog.prepare('INSERT INTO apps(appid,name) VALUES(?,?) ON CONFLICT(appid) DO UPDATE SET name=excluded.name');
      catalog.transaction(() => apps.forEach(a => a.name && ins0.run(a.appid, a.name)))();
      console.log('Steam listesi (anahtarsız):', apps.length, 'kayıt'); return;
    }
    const ins = catalog.prepare('INSERT INTO apps(appid,name) VALUES(?,?) ON CONFLICT(appid) DO UPDATE SET name=excluded.name');
    let last = 0, total = 0;
    for (;;) {
      const r = await fetch(`https://api.steampowered.com/IStoreService/GetAppList/v1/?key=${key}&include_games=true&max_results=50000&last_appid=${last}`);
      if (!r.ok) throw new Error('Steam yanıtı: ' + r.status);
      const { response } = await r.json();
      const apps = response.apps || [];
      catalog.transaction(() => apps.forEach(a => a.name && ins.run(a.appid, a.name)))();
      total += apps.length; console.log('Steam listesi:', total, 'oyun');
      if (!response.have_more_results) break;
      last = response.last_appid;
    }
  } finally { running = false; }
}
module.exports = { syncSteam };
