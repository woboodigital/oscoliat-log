const fs = require('fs');
if (fs.existsSync('.env')) fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
});
require('../steam').syncSteam().catch(e => { console.error(e.message); process.exit(1); });
