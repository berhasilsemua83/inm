// ig-poster.js
// MESIN AUTO-POST INSTAGRAM
// Mendukung:
// 1. Feed (Single Gambar/Video)
// 2. Reels (Video Vertikal)
// 3. Story (Gambar/Video Vertikal)
// 4. Carousel Feed (Maksimal 10 Slide Gambar/Video)
// 5. Menyimpan Data Affiliate Link untuk digunakan oleh ig-responder.js

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Konfigurasi Folder & File
const QUEUE_DIR = process.env.QUEUE_FOLDER || path.join(__dirname, 'queue');
const POSTED_DIR = process.env.POSTED_FOLDER || path.join(__dirname, 'posted');
const FAILED_DIR = path.join(__dirname, 'failed');

const LOG_FILE = path.join(__dirname, 'ig-poster.log');
const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');
const FAILED_ITEMS_FILE = path.join(__dirname, 'failed-items.json');
const LOCK_FILE = path.join(__dirname, 'ig-poster.lock');

const MAX_FAILURES = 3;
const HTTP_TIMEOUT_MS = 60 * 1000;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const VIDEO_EXTS = ['.mp4'];

// Kredensial API Instagram
const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const API_BASE = 'https://graph.facebook.com/v20.0'; // Meta API IG

const R2_PUBLIC_URL_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

// Inisialisasi Cloudflare R2
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ====================================================
// FUNGSI BANTUAN (HELPER)
// ====================================================
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function errMsg(err) {
  if (err && err.response && err.response.data) {
    return typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
  }
  return err && err.message ? err.message : String(err);
}

function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log(`PERINGATAN: ${path.basename(file)} korup. Dicadangkan ke .bak`);
    try { fs.copyFileSync(file, `${file}.${Date.now()}.bak`); } catch (e) {}
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readTextSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try { return fs.readFileSync(filePath, 'utf-8').trim(); }
  catch (err) { return ''; }
}

// ====================================================
// CEK KELENGKAPAN .env
// ====================================================
function checkEnv() {
  const required = [
    'IG_USER_ID', 'IG_ACCESS_TOKEN',
    'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL_BASE',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    log(`ERROR: variabel .env belum diisi: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

// ====================================================
// SISTEM LOCK
// ====================================================
let lockOwned = false;
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.closeSync(fd);
    lockOwned = true; return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return true; 
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 2 * 60 * 60 * 1000) { 
        fs.writeFileSync(LOCK_FILE, String(Date.now()));
        lockOwned = true; return true;
      }
    } catch (e) {}
    return false;
  }
}
function releaseLock() {
  if (!lockOwned) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  lockOwned = false;
}

// ====================================================
// 1. SCAN FOLDER QUEUE (IG VERSION)
// ====================================================
function scanQueue() {
  if (!fs.existsSync(QUEUE_DIR)) throw new Error(`Folder queue tidak ada: ${QUEUE_DIR}`);

  const groups = {};

  for (const fileName of fs.readdirSync(QUEUE_DIR)) {
    const fullPath = path.join(QUEUE_DIR, fileName);
    if (!fs.statSync(fullPath).isFile()) continue;

    const ext = path.extname(fileName).toLowerCase();
    let baseName = path.basename(fileName, ext);

    // 1. Cek apakah ini file link affiliate
    let isLink = false;
    if (baseName.toLowerCase().endsWith('_link')) {
      isLink = true;
      baseName = baseName.replace(/_link$/i, '');
    }

    // 2. Cek nomor slide (Carousel Feed)
    let slideNum = 1;
    const slideMatch = baseName.match(/_slide(\d+)$/i);
    if (slideMatch) {
      slideNum = parseInt(slideMatch[1], 10);
      baseName = baseName.replace(/_slide\d+$/i, '');
    }

    // 3. Tentukan Placement (Feed, Reels, Story)
    let type = 'feed'; // Default
    if (baseName.toLowerCase().endsWith('_reels')) type = 'reels';
    else if (baseName.toLowerCase().endsWith('_story')) type = 'story';
    else if (baseName.toLowerCase().endsWith('_feed')) type = 'feed';

    const fileTime = fs.statSync(fullPath).mtimeMs;

    if (!groups[baseName]) {
      groups[baseName] = { type, earliestTime: fileTime, slides: [] };
    } else if (fileTime < groups[baseName].earliestTime) {
      groups[baseName].earliestTime = fileTime;
    }

    if (isLink) {
      groups[baseName].linkPath = fullPath;
    } else if (ext === '.txt') {
      groups[baseName].txtPath = fullPath;
    } else if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
      groups[baseName].slides.push({ path: fullPath, ext, num: slideNum });
    }
  }

  for (const g of Object.values(groups)) {
    g.slides.sort((a, b) => a.num - b.num);
  }

  return groups;
}

function getNextItem() {
  const groups = scanQueue();
  const candidates = [];

  for (const [id, group] of Object.entries(groups)) {
    if (!group.txtPath && group.slides.length === 0) continue;
    candidates.push({ id, group, time: group.earliestTime });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.time - b.time);
  return candidates[0]; 
}

// ====================================================
// 2. CLOUDFLARE R2
// ====================================================
async function uploadMedia(mediaPath, ext) {
  const isVideo = VIDEO_EXTS.includes(ext);
  const safeName = path.basename(mediaPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectKey = `ig-auto/${Date.now()}-${safeName}`;

  log(`Upload ke R2: ${path.basename(mediaPath)}...`);
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: fs.readFileSync(mediaPath),
    ContentType: isVideo ? 'video/mp4' : (ext === '.png' ? 'image/png' : 'image/jpeg'),
  }));

  return { url: `${R2_PUBLIC_URL_BASE}/${objectKey}`, objectKey };
}

async function deleteFromR2(objectKey) {
  if (!objectKey) return;
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: objectKey }));
    log(`[OK] File dihapus dari R2: ${objectKey}`);
  } catch (err) {
    log(`[Peringatan] Gagal menghapus R2: ${errMsg(err)}`);
  }
}

// ====================================================
// 3. META IG GRAPH API
// ====================================================
async function createContainer({ type, mediaUrl, isVideo, text, isCarouselItem, childrenIds }) {
  const params = { access_token: IG_ACCESS_TOKEN };

  if (text && type !== 'story') params.caption = text; // Story tidak boleh ada caption

  // Jika ini anak/slide dari Carousel
  if (isCarouselItem) {
    params.is_carousel_item = true;
    if (isVideo) params.media_type = 'VIDEO';
    if (mediaUrl) {
      if (isVideo) params.video_url = mediaUrl; else params.image_url = mediaUrl;
    }
  } 
  // Jika ini wadah Induk Carousel
  else if (childrenIds) {
    params.media_type = 'CAROUSEL';
    params.children = childrenIds.join(',');
  } 
  // Jika Postingan Biasa (Single)
  else {
    if (type === 'reels') {
      params.media_type = 'REELS';
      params.video_url = mediaUrl;
    } else if (type === 'story') {
      params.media_type = 'STORIES';
      if (isVideo) params.video_url = mediaUrl; else params.image_url = mediaUrl;
    } else {
      // Default: Feed
      if (isVideo) {
        params.media_type = 'VIDEO';
        params.video_url = mediaUrl;
      } else {
        params.image_url = mediaUrl;
      }
    }
  }

  const res = await axios.post(`${API_BASE}/${IG_USER_ID}/media`, null, { params, timeout: HTTP_TIMEOUT_MS });
  return res.data.id;
}

async function waitUntilFinished(containerId) {
  for (let i = 0; i < 30; i++) {
    const res = await axios.get(`${API_BASE}/${containerId}`, {
      params: { fields: 'status_code,status', access_token: IG_ACCESS_TOKEN },
      timeout: HTTP_TIMEOUT_MS,
    });

    const status = res.data.status_code || res.data.status;
    if (status === 'FINISHED' || status === 'PUBLISHED') return true;
    if (status === 'ERROR') throw new Error(`IG API menolak media ini.`);

    log(`Menunggu media siap (Status: ${status})...`);
    await sleep(10000); 
  }
  throw new Error('Timeout menunggu media selesai diproses');
}

async function publishContainer(containerId) {
  const res = await axios.post(`${API_BASE}/${IG_USER_ID}/media_publish`, null, {
    params: { creation_id: containerId, access_token: IG_ACCESS_TOKEN },
    timeout: HTTP_TIMEOUT_MS,
  });
  return res.data.id;
}

// ====================================================
// 4. LOGIKA POSTING
// ====================================================
async function postToInstagram({ type, text, slides }) {
  let uploadedKeys = [];

  try {
    if (slides.length === 0) throw new Error("Instagram mewajibkan minimal 1 gambar/video.");

    // KONDISI 1: Single Media (Reels / Story / Single Feed)
    if (slides.length === 1) {
      log(`Membuat container IG (${type.toUpperCase()})...`);
      const s = slides[0];
      const uploaded = await uploadMedia(s.path, s.ext);
      uploadedKeys.push(uploaded.objectKey);

      const isVideo = VIDEO_EXTS.includes(s.ext);
      if (type === 'reels' && !isVideo) throw new Error("Reels WAJIB berupa file video (.mp4).");

      const cid = await createContainer({ type, mediaUrl: uploaded.url, isVideo, text });
      
      // Video butuh waktu diproses server Meta
      if (isVideo || type === 'reels' || type === 'story') {
        await waitUntilFinished(cid);
      }
      return await publishContainer(cid);
    }

    // KONDISI 2: Carousel Feed (Maks 10)
    if (type !== 'feed') throw new Error("Banyak media (Slide) hanya didukung untuk tipe _feed.");
    if (slides.length > 10) throw new Error("Maksimal 10 slide per post.");

    log(`Membuat container IG CAROUSEL (${slides.length} SLIDE)...`);
    let childrenIds = [];

    for (const s of slides) {
      const uploaded = await uploadMedia(s.path, s.ext);
      uploadedKeys.push(uploaded.objectKey);

      const childId = await createContainer({ 
        type, mediaUrl: uploaded.url, isVideo: VIDEO_EXTS.includes(s.ext), isCarouselItem: true 
      });
      
      await waitUntilFinished(childId);
      childrenIds.push(childId);
    }

    const cid = await createContainer({ type, text, childrenIds });
    return await publishContainer(cid);

  } finally {
    for (const key of uploadedKeys) { await deleteFromR2(key); }
  }
}

// ====================================================
// 5. PROSES UTAMA & ERROR HANDLING
// ====================================================
function moveFilesToDir(destDir, filePaths) {
  try { if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); } catch (err) { return; }

  for (const p of filePaths) {
    if (!p || !fs.existsSync(p)) continue;
    const dest = path.join(destDir, path.basename(p));
    try { fs.renameSync(p, dest); } 
    catch (err) {
      try { fs.copyFileSync(p, dest); fs.unlinkSync(p); } catch (e) {}
    }
  }
}

const NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
const SYSTEM_API_CODES = [190, 102, 4, 17, 32, 613, 9, 2]; 

function isSystemError(err) {
  if (!err) return false;
  const metaError = err.response?.data?.error;
  if (metaError && metaError.code) return SYSTEM_API_CODES.includes(metaError.code);
  if (!err.response && err.code && NETWORK_ERROR_CODES.includes(err.code)) return true;
  const status = err.response?.status;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;
  if (err.$metadata?.httpStatusCode >= 500) return true;
  return false;
}

async function main() {
  log('=== Menjalankan IG Poster ===');
  if (!checkEnv()) return;
  if (!acquireLock()) { log('Proses bot sebelumnya masih berjalan.'); return; }

  try {
    const item = getNextItem();
    if (!item) { log('Antrean kosong. Selesai.'); return; }

    const { id, group } = item;

    try {
      const text = readTextSafe(group.txtPath);
      const affiliateLink = readTextSafe(group.linkPath);

      log(`Memposting [${id}] - Tipe: ${group.type.toUpperCase()}`);
      
      const postId = await postToInstagram({ type: group.type, text, slides: group.slides });

      // 1. Simpan ke database posted-index (Untuk dibaca Dashboard dan ig-responder)
      let index = readJsonSafe(POSTED_INDEX_FILE, []);
      if (!Array.isArray(index)) index = [];
      index.push({
        postId: postId,
        type: affiliateLink ? 'jualan' : 'nonjualan', // Tandai untuk ig-responder
        postFormat: group.type,
        captionText: text,
        affiliateLink: affiliateLink, // Simpan link agar ig-responder bisa ngirim ke DM netizen!
        postedAt: new Date().toISOString()
      });
      writeJsonAtomic(POSTED_INDEX_FILE, index);

      // 2. Rapikan hitungan gagal & Pindah file
      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      if (fails[id]) { delete fails[id]; writeJsonAtomic(FAILED_ITEMS_FILE, fails); }

      let allFiles = [group.txtPath, group.linkPath, ...group.slides.map(s => s.path)];
      moveFilesToDir(POSTED_DIR, allFiles);

      log(`[SUKSES] ${id} tayang di IG. Post ID: ${postId}`);

    } catch (err) {
      log(`[GAGAL] memproses ${id}: ${errMsg(err)}`);

      if (isSystemError(err)) {
        log('Kendala sistem/jaringan. File aman, akan dicoba di jadwal berikutnya.');
        return;
      }

      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      fails[id] = { count: (fails[id]?.count || 0) + 1, err: errMsg(err).slice(0, 500) };
      writeJsonAtomic(FAILED_ITEMS_FILE, fails);

      if (fails[id].count >= MAX_FAILURES) {
        let allFiles = [group.txtPath, group.linkPath, ...group.slides.map(s => s.path)];
        moveFilesToDir(FAILED_DIR, allFiles);
        log(`[DIPINDAHKAN] ${id} gagal ${MAX_FAILURES}x. Masuk folder failed.`);
      } else {
        log(`Kegagalan ke-${fails[id].count} dari ${MAX_FAILURES}.`);
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch(err => log(`ERROR tak terduga: ${errMsg(err)}`));