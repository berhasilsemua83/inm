// ig-responder.js
// MESIN AUTO-KOMEN & AUTO-DM INSTAGRAM
// Fitur:
// 1. Post Jualan -> Deteksi trigger kata kunci -> Balas Komen Publik -> Kirim DM (Link Affiliate).
// 2. Fallback Jualan -> Jika DM gagal (akun di-private), otomatis kasih link di komen publik.
// 3. Post Non-Jualan -> Memakai AI Gemini untuk membalas natural.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const API_BASE = 'https://graph.facebook.com/v20.0';

const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');
const REPLIED_COMMENTS_FILE = path.join(__dirname, 'replied-comments.json');
const TRIGGER_RULES_FILE = path.join(__dirname, 'trigger-rules.json');
const AI_STYLE_FILE = path.join(__dirname, 'ai-style.json');
const LOG_FILE = path.join(__dirname, 'ig-responder.log');

const POST_MAX_AGE_HOURS = 72; // Hanya patroli di postingan 3 hari terakhir (hemat API)
const MIN_COMMENT_LENGTH = 3;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function loadJson(filePath, fallback) {
  try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : fallback; } 
  catch (e) { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ====================================================
// 1. AMBIL POSTINGAN & KOMENTAR TERBARU
// ====================================================
function getRecentPosts() {
  const index = loadJson(POSTED_INDEX_FILE, []);
  const cutoff = Date.now() - POST_MAX_AGE_HOURS * 60 * 60 * 1000;
  return index.filter(entry => new Date(entry.postedAt).getTime() >= cutoff);
}

async function fetchComments(mediaId) {
  const res = await axios.get(`${API_BASE}/${mediaId}/comments`, {
    params: { fields: 'id,text,username', access_token: IG_ACCESS_TOKEN },
  });
  return res.data.data || [];
}

// ====================================================
// 2. META GRAPH API (BALAS KOMEN & DM)
// ====================================================
async function replyCommentPublicly(commentId, text) {
  const res = await axios.post(`${API_BASE}/${commentId}/replies`, null, {
    params: { message: text, access_token: IG_ACCESS_TOKEN }
  });
  return res.data.id;
}

async function sendPrivateReplyDM(commentId, text) {
  const payload = {
    recipient: { comment_id: commentId },
    message: { text: text }
  };
  const res = await axios.post(`${API_BASE}/${IG_USER_ID}/messages`, payload, {
    params: { access_token: IG_ACCESS_TOKEN }
  });
  return res.data;
}

// ====================================================
// 3. LOGIKA TRIGGER JUALAN
// ====================================================
function matchTriggerRule(commentText) {
  const rulesConfig = loadJson(TRIGGER_RULES_FILE, { rules: [] });
  const lowerText = commentText.toLowerCase();

  for (const rule of rulesConfig.rules) {
    const matched = rule.keywords.some(kw => lowerText.includes(kw.toLowerCase()));
    if (matched) return rule; // Mengembalikan 1 paket rule (reply_comment & dm_message)
  }
  return null;
}

// ====================================================
// 4. LOGIKA AI GEMINI (NON-JUALAN)
// ====================================================
const STYLE_TEMPLATES = {
  ramah_sopan: 'Gaya bahasa: ramah, sopan, formal ringan (seperti admin brand profesional tapi hangat).',
  santai_gaul: 'Gaya bahasa: santai dan akrab, seperti ngobrol dengan teman dekat. Boleh pakai kata sehari-hari.',
  lucu_receh: 'Gaya bahasa: lucu, receh, banyak candaan ringan, boleh pakai emoji.',
};

async function generateAiReply(postCaption, commentText) {
  if (GEMINI_API_KEYS.length === 0) return null;

  const styleConfig = loadJson(AI_STYLE_FILE, { style_preset: 'ramah_sopan', max_sentences: 2, custom_instruction: '' });
  const maxSentences = styleConfig.max_sentences || 2;

  let styleText = styleConfig.style_preset === 'custom' 
    ? (styleConfig.custom_instruction || 'Gaya bahasa santai') 
    : (STYLE_TEMPLATES[styleConfig.style_preset] || STYLE_TEMPLATES.ramah_sopan);

  if (styleConfig.style_preset !== 'custom' && styleConfig.custom_instruction) {
    styleText += `\nAturan tambahan: ${styleConfig.custom_instruction}`;
  }

  const prompt = `Ini adalah caption postingan Instagram saya:
---
${postCaption}
---
Ini komentar dari netizen:
---
${commentText}
---
Balas komentar netizen ini dalam Bahasa Indonesia, maksimal ${maxSentences} kalimat.
${styleText}
Sesuaikan balasan dengan konteks postingan. Jangan promosi produk apapun. Jangan pakai tanda kutip di jawabanmu.`;

  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEYS[i]}`,
        { contents: [{ parts: [{ text: prompt }] }] }
      );
      const reply = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (reply) return reply;
    } catch (err) {
      log(`[AI] Key #${i + 1} gagal/limit, mencoba key selanjutnya...`);
    }
  }
  return null;
}

// ====================================================
// 5. PROSES UTAMA
// ====================================================
async function main() {
  log('=== Menjalankan IG Responder (Cek Komen & DM) ===');

  const repliedComments = new Set(loadJson(REPLIED_COMMENTS_FILE, []));
  const recentPosts = getRecentPosts();

  if (recentPosts.length === 0) {
    log('Tidak ada post dalam 72 jam terakhir. Selesai.');
    return;
  }

  let newlyReplied = [];

  for (const post of recentPosts) {
    let comments = [];
    try {
      comments = await fetchComments(post.postId);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      log(`Gagal ambil komen post ${post.postId}: ${msg}`);
      continue;
    }

    for (const comment of comments) {
      if (repliedComments.has(comment.id)) continue;
      
      const textClean = comment.text.trim();
      if (textClean.length < MIN_COMMENT_LENGTH || !/[a-zA-Z]/.test(textClean)) continue;

      log(`[Komen Baru] di Post ${post.postId}: "${textClean}"`);

      try {
        // SKENARIO 1: POST JUALAN (Kirim DM atau Lempar ke AI)
        if (post.type === 'jualan' && post.affiliateLink) {
          const rule = matchTriggerRule(textClean);
          
          if (rule) {
            log(`Trigger jualan cocok! Mengirim DM ke netizen...`);
            const fullDmText = `${rule.dm_message}\n${post.affiliateLink}`;
            
            try {
              // 1. Coba kirim DM dulu (Private Reply)
              await sendPrivateReplyDM(comment.id, fullDmText);
              log(`[SUKSES DM] Pesan affiliate terkirim!`);
              
              // 2. Balas komen publik (Cek DM ya kak)
              await replyCommentPublicly(comment.id, rule.reply_comment);
            } catch (dmErr) {
              // FALLBACK: Kalau DM gagal (misal netizen private akun)
              log(`[GAGAL DM] Akun mungkin diprivate. Fallback ke komen publik.`);
              const fallbackText = `Halo kak! Sayang sekali DM kakak tidak bisa kami kirimi pesan 😢. Ini link produknya ya kak: ${post.affiliateLink}`;
              await replyCommentPublicly(comment.id, fallbackText);
            }
            newlyReplied.push(comment.id);

          } else {
            // JIKA BUKAN KATA KUNCI JUALAN -> LEMPAR KE AI GEMINI!
            log(`[HYBRID] Komen tidak ada trigger jualan, melempar ke AI Gemini...`);
            const aiReply = await generateAiReply(post.captionText, textClean);
            if (aiReply) {
              await replyCommentPublicly(comment.id, aiReply);
              log(`[SUKSES AI] Balas komen umum di post jualan: "${aiReply}"`);
              newlyReplied.push(comment.id);
            } else {
              log(`[SKIP] AI gagal membuat balasan.`);
            }
          }
        }
        
        // SKENARIO 2: POST UMUM (Balas via AI Gemini)
        else {
          const aiReply = await generateAiReply(post.captionText, textClean);
          if (aiReply) {
            await replyCommentPublicly(comment.id, aiReply);
            log(`[SUKSES AI] Balas komen: "${aiReply}"`);
            newlyReplied.push(comment.id);
          } else {
            log(`[SKIP] AI gagal membuat balasan (mungkin limit API).`);
          }
        }
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        log(`[ERROR] Gagal membalas komen ${comment.id}: ${msg}`);
      }
    }
  }

  // Simpan ID komentar yang sudah dibalas agar tidak di-spam bot berulang kali
  if (newlyReplied.length > 0) {
    const allReplied = [...Array.from(repliedComments), ...newlyReplied];
    // Batasi memori agar file JSON tidak bengkak (simpan 5000 komen terakhir saja)
    const trimmedReplied = allReplied.length > 5000 ? allReplied.slice(allReplied.length - 5000) : allReplied;
    saveJson(REPLIED_COMMENTS_FILE, trimmedReplied);
    log(`Selesai. ${newlyReplied.length} komentar baru berhasil dibalas.`);
  } else {
    log('Selesai. Tidak ada komentar baru yang perlu dibalas.');
  }
}

main();
