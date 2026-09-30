import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// ====================================================
// ISI TEKS MANUAL BOOK (KHUSUS INSTAGRAM)
// ====================================================
const MANUAL_BOOK_TEXT = `=========================================================
      BUKU PANDUAN PENGGUNA (USER MANUAL)
            INSTAGRAM AUTOMATOR v1.0
=========================================================

DAFTAR ISI:
1. Persiapan Kredensial (API & Token)
2. Persiapan Folder & Program
3. Aturan Penamaan File (Feed, Reels, Story, Affiliate)
4. Balasan Komentar & Auto DM (Trigger & AI Gemini)
5. Mengatur Jadwal & Mengaktifkan Bot
6. Membaca Dashboard & Penanganan Error

---------------------------------------------------------
BAGIAN 1: PERSIAPAN KREDENSIAL (API & TOKEN)
---------------------------------------------------------
Di menu aplikasi, Anda wajib mengisi data penghubung:
A. INSTAGRAM API
   1. IG User ID: ID Angka unik dari Akun Instagram Bisnis/Kreator Anda.
   2. IG Access Token: Long-Lived Token dari Meta (Di-refresh otomatis tiap minggu).

B. CLOUDFLARE R2 (Untuk Hosting Gambar/Video Sementara)
   1. Account ID: Dari dashboard Cloudflare -> R2 -> Kanan atas.
   2. Access Key ID & Secret Access Key: Dari menu "Manage R2 API Tokens".
   3. Nama Bucket: Nama wadah yang Anda buat (misal: "ig-media").
   4. Public URL Base: URL subdomain R2.dev (misal: https://pub-xxx.r2.dev).

C. GEMINI API KEY (Untuk Balasan AI)
   1. Dapatkan gratis dari: https://aistudio.google.com/app/apikey
   2. Bisa isi lebih dari 1 key. Jika key pertama limit, otomatis pakai key kedua.

---------------------------------------------------------
BAGIAN 2: PERSIAPAN FOLDER & PROGRAM
---------------------------------------------------------
1. Folder Queue  : Wadah untuk bahan postingan baru.
2. Folder Posted : Wadah arsip file yang SUKSES tayang.
3. Path node.exe : Klik tombol "Deteksi". (Pastikan Node.js terinstal).
4. Folder Proyek : Buat folder khusus (Misal: C:\\BotInstagram). 
WAJIB: Klik tombol "⚡ Setup Otomatis" setelah Folder Proyek dipilih.

---------------------------------------------------------
BAGIAN 3: ATURAN PENAMAAN FILE (SANGAT PENTING)
---------------------------------------------------------
Instagram membagi postingan menjadi 3 jalur. Gunakan akhiran ini pada nama file Anda:

1. JALUR FEED (Gambar Kotak / Video Kotak) -> Gunakan "_feed"
   - promo_feed.txt
   - promo_feed.jpg

2. JALUR REELS (Video Vertikal) -> Gunakan "_reels"
   - sepatu_reels.txt
   - sepatu_reels.mp4

3. JALUR STORY (Gambar/Video Vertikal) -> Gunakan "_story"
   - pagi_story.jpg

4. CAROUSEL / SLIDE (Banyak Foto/Video di Feed) -> Gunakan "_slide(Angka)"
   - katalog_feed.txt
   - katalog_feed_slide1.jpg
   - katalog_feed_slide2.jpg
   - katalog_feed_slide3.mp4

5. LINK AFFILIATE (JUALAN) -> Gunakan "_link.txt"
   Jika Anda menyertakan file ini (misal: "promo_link.txt" berisi link Shopee):
   - Jika diposting ke Feed/Reels: Bot akan otomatis mengirim link tersebut via DM kepada netizen yang berkomentar dengan kata kunci tertentu (Misal: "Mau").
   - Jika diposting ke Story: Bot otomatis menyulap link tersebut menjadi "Stiker Tautan" yang bisa diklik di Story Anda!

---------------------------------------------------------
BAGIAN 4: BALAS KOMEN & AUTO DM (TRIGGER & AI)
---------------------------------------------------------
A. POST JUALAN (Punya file "_link.txt")
   Bot membalas berdasarkan KATA KUNCI dan langsung mengirim Link ke DM netizen.
   -> Buka "trigger-rules.json" di Folder Proyek untuk mengedit kata kunci pemicu (misal: "mau", "spill", "harga").

B. POST NON-JUALAN (Konten Umum)
   Bot memakai AI Gemini untuk membalas komentar biasa di postingan publik. AI menyesuaikan "Gaya Bahasa" yang Anda atur di Aplikasi.

---------------------------------------------------------
BAGIAN 5: MENGATUR JADWAL & MENGAKTIFKAN BOT
---------------------------------------------------------
- Jam Posting: Mengatur jam upload Feed/Reels/Story. Gunakan format 24 Jam (Misal: 14:30).
- Interval Komen & DM: Kecepatan bot mengecek komen baru untuk dikirimkan Auto DM (Saran: 2 atau 5 menit agar cepat membalas calon pembeli).
- Klik tombol Hijau "▶ Aktifkan Bot (Simpan & Terapkan)" agar jalan di background.

---------------------------------------------------------
BAGIAN 6: PENANGANAN ERROR (FOLDER "FAILED")
---------------------------------------------------------
Jika error karena salah file (misal durasi Reels kepanjangan) dan gagal 3x berturut-turut, file otomatis diseret ke folder "failed" agar antrean tidak macet.
-> Solusi: Perbaiki file di folder "failed", lalu kembalikan ke folder "queue".`;

// ====================================================
// TIPE DATA & DEFAULT CONFIG (DISESUAIKAN DENGAN RUST IG)
// ====================================================
interface ScheduleConfig {
  poster_times: string[];
  responder_interval_minutes: number;
  refresh_token_day: string;
  refresh_token_time: string;
}

interface Profile {
  id: string;
  name: string;
  ig_user_id: string;
  ig_access_token: string;
  r2: {
    account_id: string;
    access_key_id: string;
    secret_access_key: string;
    bucket_name: string;
    public_url_base: string;
  };
  gemini_api_keys: string[];
  ai_reply_enabled: boolean;
  queue_folder: string;
  posted_folder: string;
  node_exe_path: string;
  project_folder: string;
  schedule: ScheduleConfig;
  ai_style_preset: string;
  ai_max_sentences: number;
  ai_custom_instruction: string;
}

interface ProfileSummary { id: string; name: string; }

interface DashboardState {
  last_post_id: string | null;
  last_post_type: string | null;
  last_post_time: string | null;
  queue_count: number;
  next_in_queue: string | null;
}

const EMPTY_CONFIG: Profile = {
  id: "", name: "", ig_user_id: "", ig_access_token: "",
  r2: { account_id: "", access_key_id: "", secret_access_key: "", bucket_name: "", public_url_base: "" },
  gemini_api_keys: [""], ai_reply_enabled: false, queue_folder: "", posted_folder: "", node_exe_path: "", project_folder: "",
  schedule: { poster_times: ["07:00"], responder_interval_minutes: 2, refresh_token_day: "MON", refresh_token_time: "03:00" },
  ai_style_preset: "ramah_sopan", ai_max_sentences: 2, ai_custom_instruction: "",
};

const STYLE_PRESET_OPTIONS = [
  { value: "ramah_sopan", label: "Ramah & Sopan (formal ringan)" },
  { value: "santai_gaul", label: "Santai & Akrab" },
  { value: "lucu_receh", label: "Lucu & Receh" },
  { value: "custom", label: "Custom (tulis sendiri)" },
];

const HARI_OPTIONS = [
  { value: "MON", label: "Senin" }, { value: "TUE", label: "Selasa" }, { value: "WED", label: "Rabu" },
  { value: "THU", label: "Kamis" }, { value: "FRI", label: "Jumat" }, { value: "SAT", label: "Sabtu" }, { value: "SUN", label: "Minggu" },
];

function ChoiceButtons({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; }) {
  return (
    <div className="choice-row">
      {options.map((o) => (
        <button type="button" key={o.value} className={`choice-btn ${o.value === value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const APP_BUILD = "ig-automator-v1";

function getNextScheduleInfo(times: string[]) {
  if (!times || times.length === 0) return "Tidak ada jadwal";
  const now = new Date();
  const currentTotal = now.getHours() * 60 + now.getMinutes();
  const sorted = [...times].sort();

  for (const t of sorted) {
    const [h, m] = t.split(":").map(Number);
    if ((h * 60 + m) > currentTotal) return `Hari ini, ${t} WIB`;
  }
  return `Besok, ${sorted[0]} WIB`;
}

function formatReadableDate(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + " WIB";
  } catch { return isoString; }
}

export default function App() {
  const [config, setConfig] = useState<Profile>(EMPTY_CONFIG);
  const [profileList, setProfileList] = useState<ProfileSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  
  const [showManual, setShowManual] = useState(false);
  
  const [status, setStatus] = useState("");
  const [scheduleLog, setScheduleLog] = useState<string[]>([]);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  
  const [settingUp, setSettingUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showNewProfileForm, setShowNewProfileForm] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function normalizeProfile(loaded: Profile): Profile {
    if (!loaded.gemini_api_keys || loaded.gemini_api_keys.length === 0) loaded.gemini_api_keys = [""];
    if (!loaded.schedule) loaded.schedule = EMPTY_CONFIG.schedule;
    if (!loaded.schedule.poster_times || loaded.schedule.poster_times.length === 0) loaded.schedule.poster_times = ["07:00"];
    return loaded;
  }

  async function fetchDashboardData(profileId: string) {
    if (!profileId) return;
    try {
      const data = await invoke<DashboardState>("get_dashboard_data", { profileId });
      setDashboard(data);
    } catch (e) { console.error("Gagal ambil dashboard:", e); }
  }

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<ProfileSummary[]>("list_profiles");
        setProfileList(list);
        const active = await invoke<Profile>("get_active_profile");
        setConfig(normalizeProfile(active));
        await fetchDashboardData(active.id);
      } catch (err) { setStatus(`Gagal memuat: ${err}`); } 
      finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (config.id) {
      const interval = setInterval(() => fetchDashboardData(config.id), 10000);
      return () => clearInterval(interval);
    }
  }, [config.id]);

  async function handleSwitchProfile(id: string) {
    setLoading(true);
    try {
      const loaded = await invoke<Profile>("load_profile", { id });
      setConfig(normalizeProfile(loaded));
      await fetchDashboardData(id);
      setScheduleLog([]); setSetupLog([]);
      setStatus(`Pindah ke profil "${loaded.name}".`);
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setLoading(false); }
  }

  async function handleCreateProfile() {
    const name = newProfileName.trim() || "Akun IG Baru";
    try {
      const created = await invoke<Profile>("create_profile", { name });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      setConfig(normalizeProfile(created));
      await fetchDashboardData(created.id);
      setShowNewProfileForm(false); setNewProfileName(""); setStatus(`Profil "${created.name}" dibuat.`);
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  async function handleDeleteProfile() {
    if (!config.id) return;
    try {
      const remaining = await invoke<ProfileSummary[]>("delete_profile", { id: config.id });
      setProfileList(remaining);
      if (remaining.length > 0) {
        const loaded = await invoke<Profile>("load_profile", { id: remaining[0].id });
        setConfig(normalizeProfile(loaded));
        await fetchDashboardData(loaded.id);
      } else {
        const created = await invoke<Profile>("create_profile", { name: "IG Akun 1" });
        const list = await invoke<ProfileSummary[]>("list_profiles");
        setProfileList(list);
        setConfig(normalizeProfile(created));
        await fetchDashboardData(created.id);
      }
      setConfirmDelete(false); setStatus("Profil dihapus.");
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  function cleanedConfig(): Profile {
    return {
      ...config,
      gemini_api_keys: config.gemini_api_keys.filter((k) => k.trim() !== ""),
      schedule: { ...config.schedule, poster_times: config.schedule.poster_times.filter((t) => t.trim() !== "") },
    };
  }

  async function handleSave() {
    setStatus("Menyimpan...");
    try {
      await invoke("save_profile", { profile: cleanedConfig() });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      setStatus("Pengaturan tersimpan.");
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  async function handleApplySchedule() {
    setApplying(true); setScheduleLog([]); setStatus("Menerapkan jadwal...");
    try {
      const log = await invoke<string[]>("apply_schedule", { profile: cleanedConfig() });
      setScheduleLog(log); setStatus("Jadwal diterapkan.");
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setApplying(false); }
  }
  
  async function handleDisableSchedule() {
    if (!confirm(`Matikan bot untuk akun "${config.name}"? Jadwal tidak akan berjalan sampai Anda mengaktifkannya lagi.`)) return;
    
    setApplying(true); setScheduleLog([]); setStatus("Mematikan bot...");
    try {
      const msg = await invoke<string>("disable_schedule", { profileName: config.name });
      setScheduleLog([`[OFF] ${msg}`]);
      setStatus("Bot dinonaktifkan.");
    } catch (err) { setStatus(`Gagal mematikan bot: ${err}`); } 
    finally { setApplying(false); }
  }

  async function handleSetupProject() {
    setSettingUp(true); setSetupLog([]); setStatus("Menyiapkan otomatis...");
    try {
      const log = await invoke<string[]>("setup_project", { profile: cleanedConfig() });
      setSetupLog(log); setStatus("Setup selesai.");
      const reloaded = await invoke<Profile>("load_profile", { id: config.id });
      setConfig(normalizeProfile(reloaded));
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setSettingUp(false); }
  }

  async function handleDetectNode() {
    try {
      const path = await invoke<string>("detect_node_path");
      setConfig((prev) => ({ ...prev, node_exe_path: path })); setStatus(`Node.js ditemukan.`);
    } catch (err) { setStatus(`${err}`); }
  }

  async function pickFolder(target: "queue_folder" | "posted_folder" | "project_folder") {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setConfig((prev) => ({ ...prev, [target]: selected }));
  }

  function updateGeminiKey(index: number, value: string) {
    setConfig((prev) => {
      const updated = [...prev.gemini_api_keys];
      updated[index] = value;
      return { ...prev, gemini_api_keys: updated };
    });
  }

  function addGeminiKeyField() {
    setConfig((prev) => ({
      ...prev,
      gemini_api_keys: [...prev.gemini_api_keys, ""]
    }));
  }

  function removeGeminiKeyField(index: number) {
    setConfig((prev) => {
      const updated = prev.gemini_api_keys.filter((_, i) => i !== index);
      return { ...prev, gemini_api_keys: updated.length > 0 ? updated : [""] };
    });
  }

  function updatePosterTime(index: number, value: string) {
    setConfig((prev) => {
      const updated = [...prev.schedule.poster_times];
      updated[index] = value;
      return { ...prev, schedule: { ...prev.schedule, poster_times: updated } };
    });
  }

  function addPosterTime() {
    setConfig((prev) => ({
      ...prev,
      schedule: { ...prev.schedule, poster_times: [...prev.schedule.poster_times, "12:00"] },
    }));
  }

  function removePosterTime(index: number) {
    setConfig((prev) => {
      const updated = prev.schedule.poster_times.filter((_, i) => i !== index);
      return {
        ...prev,
        schedule: { ...prev.schedule, poster_times: updated.length > 0 ? updated : ["07:00"] },
      };
    });
  }

  if (loading) return <div className="container">Memuat pengaturan...</div>;

  return (
    <div className="container">
      {/* HEADER */}
      <div className="header-row">
        <h1>Instagram Automator</h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button type="button" className="choice-btn" style={{ padding: "5px 12px", fontSize: "11px", fontWeight: "bold" }} onClick={() => setShowManual(true)}>
            📖 Manual Book
          </button>
          <div className="status-indicator">
            <span className={`status-dot ${config.ig_access_token && config.node_exe_path && config.project_folder ? "active" : ""}`} />
            {config.ig_access_token && config.node_exe_path && config.project_folder ? "Siap Jalan" : "Belum Lengkap"}
          </div>
        </div>
      </div>
      <p className="subtitle">Pengaturan Post, Auto-DM & Jadwal · build {APP_BUILD}</p>

      {/* DASHBOARD LIVE PANEL */}
      <div className="dashboard-panel">
        <div className="dash-header">
          Monitoring Bot IG <div className="live-badge"><span className="live-dot"></span> REAL-TIME</div>
        </div>
        <div className="dash-grid">
          <div className="dash-box">
            <div className="dash-title">Terakhir Tayang</div>
            <div className="dash-text">
              {dashboard?.last_post_id ? (
                <>
                  <span className="dash-highlight">ID: {dashboard.last_post_id}</span>
                  Tipe: {dashboard.last_post_type === "jualan" ? "🛒 Jualan (Ada Link)" : "💬 Konten Umum"}<br/>
                  Pada: {formatReadableDate(dashboard.last_post_time || "")}
                </>
              ) : "Belum ada post tayang"}
            </div>
          </div>
          <div className="dash-box">
            <div className="dash-title">Antrean Selanjutnya</div>
            <div className="dash-text">
              {dashboard?.queue_count && dashboard.queue_count > 0 ? (
                <>
                  <span className="dash-highlight">Ada {dashboard.queue_count} konten antre</span>
                  Target: "{dashboard.next_in_queue}"<br/>
                  Jam: <span style={{color: "#86efac", fontWeight: "bold"}}>{getNextScheduleInfo(config.schedule.poster_times)}</span>
                </>
              ) : "Antrean kosong, mohon isi Queue"}
            </div>
          </div>
        </div>
      </div>

      <section>
        <h2>Profil Akun IG</h2>
        <ChoiceButtons options={profileList.map((p) => ({ value: p.id, label: p.name || "(tanpa nama)" }))} value={config.id} onChange={handleSwitchProfile} />
        
        <div className="key-input-group" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => { setShowNewProfileForm(!showNewProfileForm); setConfirmDelete(false); }}>+ Profil Baru</button>
          <button type="button" className="btn-remove" onClick={() => { setConfirmDelete(!confirmDelete); setShowNewProfileForm(false); }}>Hapus Profil Ini</button>
        </div>

        {showNewProfileForm && (
          <div style={{ marginTop: 10 }}>
            <label className="field-label">Nama profil baru</label>
            <div className="key-input-group">
              <input type="text" placeholder="Nama profil" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} />
              <button type="button" onClick={handleCreateProfile}>Buat Profil</button>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div style={{ marginTop: 10 }}>
            <p className="hint" style={{ color: "#fca5a5" }}>Hapus profil "{config.name}"? Jadwalnya akan ikut terhapus.</p>
            <div className="key-input-group">
              <button type="button" className="btn-remove" onClick={handleDeleteProfile}>Ya, hapus</button>
              <button type="button" onClick={() => setConfirmDelete(false)}>Batal</button>
            </div>
          </div>
        )}

        <label className="field-label" style={{ marginTop: 12 }}>Nama Profil</label>
        <input type="text" value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
      </section>

      <section>
        <h2>Instagram API</h2>
        <label className="field-label">Instagram User ID</label>
        <input type="text" placeholder="ID Angka Akun IG" value={config.ig_user_id} onChange={(e) => setConfig({ ...config, ig_user_id: e.target.value })} />
        <label className="field-label">Instagram Access Token</label>
        <input type="password" placeholder="Long-lived token dari Meta" value={config.ig_access_token} onChange={(e) => setConfig({ ...config, ig_access_token: e.target.value })} />
      </section>

      <section>
        <h2>Cloudflare R2 (hosting video/gambar)</h2>
        <label className="field-label">Cloudflare Account ID</label>
        <input type="text" value={config.r2.account_id} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, account_id: e.target.value } })} />
        <label className="field-label">R2 Access Key ID</label>
        <input type="text" value={config.r2.access_key_id} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, access_key_id: e.target.value } })} />
        <label className="field-label">R2 Secret Access Key</label>
        <input type="password" value={config.r2.secret_access_key} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, secret_access_key: e.target.value } })} />
        <label className="field-label">Nama Bucket</label>
        <input type="text" value={config.r2.bucket_name} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, bucket_name: e.target.value } })} />
        <label className="field-label">Public URL Base</label>
        <input type="text" value={config.r2.public_url_base} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, public_url_base: e.target.value } })} />
      </section>

      <section>
        <h2>Gemini API Key (Untuk Balas Komen Umum)</h2>
        {config.gemini_api_keys.map((key, index) => (
          <div className="gemini-key-row" key={index}>
            <label className="field-label">Key #{index + 1}</label>
            <div className="key-input-group">
              <input type="password" value={key} onChange={(e) => updateGeminiKey(index, e.target.value)} />
              {config.gemini_api_keys.length > 1 && (
                <button type="button" className="btn-remove" onClick={() => removeGeminiKeyField(index)}>✕</button>
              )}
            </div>
          </div>
        ))}
        <button type="button" className="btn-add" onClick={addGeminiKeyField}>+ Tambah Key</button>
      </section>

      <section>
        <h2>Balasan Komen Umum (AI)</h2>
        <label className="toggle-row">
          <input type="checkbox" checked={config.ai_reply_enabled} onChange={(e) => setConfig({ ...config, ai_reply_enabled: e.target.checked })} />
          <span>{config.ai_reply_enabled ? "AKTIF" : "NONAKTIF"}</span>
        </label>
        {config.ai_reply_enabled && (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>Gaya Bahasa</label>
            <ChoiceButtons options={STYLE_PRESET_OPTIONS} value={config.ai_style_preset} onChange={(v) => setConfig({ ...config, ai_style_preset: v })} />
            <label className="field-label">Panjang Balasan (kalimat)</label>
            <input type="number" min={1} max={5} value={config.ai_max_sentences} onChange={(e) => setConfig({ ...config, ai_max_sentences: Number(e.target.value) })} />
            <label className="field-label">Instruksi Tambahan</label>
            <textarea rows={3} value={config.ai_custom_instruction} onChange={(e) => setConfig({ ...config, ai_custom_instruction: e.target.value })} />
          </>
        )}
      </section>

      <section>
        <h2>Folder Konten</h2>
        <label className="field-label">Folder Queue</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.queue_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("queue_folder")}>Pilih Folder</button>
        </div>
        <label className="field-label">Folder Posted</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.posted_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("posted_folder")}>Pilih Folder</button>
        </div>
      </section>

      <section>
        <h2>Lokasi Program</h2>
        <label className="field-label">Path node.exe</label>
        <div className="folder-picker-row">
          <input type="text" value={config.node_exe_path} onChange={(e) => setConfig({ ...config, node_exe_path: e.target.value })} />
          <button type="button" onClick={handleDetectNode}>Deteksi</button>
        </div>
        <span className="hint" style={{ marginTop: "6px", marginBottom: "14px", color: "#fca5a5" }}>
          *Wajib install Node.js (versi LTS) dari nodejs.org terlebih dahulu sebelum klik Deteksi.
        </span>

        <label className="field-label">Folder Proyek</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.project_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("project_folder")}>Pilih Folder</button>
        </div>
        
        <button type="button" className="btn-save" style={{ marginTop: 14 }} onClick={handleSetupProject} disabled={settingUp}>
          {settingUp ? "Menyiapkan..." : "⚡ Setup Otomatis (folder + file + npm install)"}
        </button>
        {setupLog.length > 0 && <div className="log-box">{setupLog.map((l, i) => <div key={i} className={l.includes("GAGAL") ? "log-fail" : "log-ok"}>{l}</div>)}</div>}
      </section>

      <section>
        <h2>Jadwal (Windows Task Scheduler)</h2>
        <label className="field-label">Jam Posting (ig-poster.js)</label>
        {config.schedule.poster_times.map((time, index) => (
          <div className="key-input-group" key={index} style={{ marginBottom: 6 }}>
            <input type="text" maxLength={5} placeholder="07:30" value={time} onChange={(e) => updatePosterTime(index, e.target.value)} />
            {config.schedule.poster_times.length > 1 && (
              <button type="button" className="btn-remove" onClick={() => removePosterTime(index)}>✕</button>
            )}
          </div>
        ))}
        <button type="button" className="btn-add" onClick={addPosterTime}>+ Tambah Jam</button>

        <label className="field-label" style={{ marginTop: 16 }}>
          Interval Komen & DM Responder (menit)
          <span className="hint">Kecepatan bot mengecek komen baru untuk dikirimi Auto-DM</span>
        </label>
        <input type="number" min={1} value={config.schedule.responder_interval_minutes} onChange={(e) => setConfig({ ...config, schedule: { ...config.schedule, responder_interval_minutes: Number(e.target.value) } })} />

        <label className="field-label">Refresh Token (Hari & Jam)</label>
        <ChoiceButtons options={HARI_OPTIONS} value={config.schedule.refresh_token_day} onChange={(v) => setConfig({ ...config, schedule: { ...config.schedule, refresh_token_day: v } })} />
        <div className="key-input-group" style={{ marginTop: 8 }}>
          <input type="text" maxLength={5} placeholder="03:00" value={config.schedule.refresh_token_time} onChange={(e) => setConfig({ ...config, schedule: { ...config.schedule, refresh_token_time: e.target.value } })} />
        </div>

        {/* TOMBOL ON & OFF */}
        <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <button type="button" className="btn-save" style={{ flex: 2 }} onClick={handleApplySchedule} disabled={applying}>
            {applying ? "Proses..." : "▶ Aktifkan Bot (Simpan & Terapkan)"}
          </button>
          <button type="button" className="btn-save" style={{ flex: 1, background: "#dc2626", boxShadow: "none" }} onClick={handleDisableSchedule} disabled={applying}>
            ⏹ Matikan (OFF)
          </button>
        </div>
        
        {scheduleLog.length > 0 && <div className="log-box">{scheduleLog.map((l, i) => <div key={i} className={l.includes("GAGAL") ? "log-fail" : "log-ok"}>{l}</div>)}</div>}
      </section>

      <button type="button" className="btn-save" onClick={handleSave}>Simpan Pengaturan Saja</button>
      {status && <p className="status">{status}</p>}

      {/* MODAL MANUAL BOOK */}
      {showManual && (
        <div className="modal-overlay" onClick={() => setShowManual(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="dash-highlight" style={{ margin: 0, color: "#fff" }}>📖 Buku Panduan</h2>
              <button className="modal-close" onClick={() => setShowManual(false)}>✕</button>
            </div>
            <div className="modal-body">
              <pre className="manual-text">{MANUAL_BOOK_TEXT}</pre>
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
}
