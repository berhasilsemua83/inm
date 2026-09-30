// refresh-token.js (VERSI INSTAGRAM)
// Refresh long-lived access token Meta agar bot tidak mati setelah 60 hari.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENV_PATH = path.join(__dirname, '.env');
const LOG_FILE = path.join(__dirname, 'refresh-token.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function updateEnvToken(newToken) {
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');

  // Ganti token lama dengan token baru yang fresh dari server Meta
  if (envContent.match(/^IG_ACCESS_TOKEN=.*/m)) {
    envContent = envContent.replace(
      /^IG_ACCESS_TOKEN=.*/m,
      `IG_ACCESS_TOKEN=${newToken}`
    );
  } else {
    envContent += `\nIG_ACCESS_TOKEN=${newToken}\n`;
  }

  fs.writeFileSync(ENV_PATH, envContent);
  log('[SUKSES] File .env berhasil diupdate dengan token baru.');
}

async function main() {
  log('=== Menjalankan IG Refresh Token ===');

  const currentToken = process.env.IG_ACCESS_TOKEN;

  if (!currentToken) {
    log('ERROR: IG_ACCESS_TOKEN tidak ditemukan di .env');
    return;
  }

  try {
    const res = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: currentToken,
      },
    });

    const newToken = res.data.access_token;
    const expiresIn = res.data.expires_in; // Dalam hitungan detik (biasanya 60 hari)

    if (!newToken) {
      throw new Error('Response API Meta tidak berisi access_token baru');
    }

    updateEnvToken(newToken);

    const expiresInDays = Math.round(expiresIn / 86400);
    log(`[AMAN] Token IG berhasil di-refresh. Berlaku ${expiresInDays} hari ke depan.`);
  } catch (err) {
    const errMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    log(`[GAGAL] Refresh token: ${errMsg}`);
    log('Peringatan: Token lama tetap dipakai. Pastikan token tidak expired (batas 60 hari).');
  }
}

main();