#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// main.rs untuk INSTAGRAM AUTOMATOR

use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ====== NAMA-NAMA FILE SCRIPT BOT IG ======
const SCRIPT_IG_POSTER: &str = include_str!("../scripts/ig-poster.js");
const SCRIPT_IG_RESPONDER: &str = include_str!("../scripts/ig-responder.js");
const SCRIPT_REFRESH_TOKEN: &str = include_str!("../scripts/refresh-token.js");
const SCRIPT_TRIGGER_RULES: &str = include_str!("../scripts/trigger-rules.json");
const SCRIPT_PACKAGE_JSON: &str = include_str!("../scripts/package.json");

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct R2Config {
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    bucket_name: String,
    public_url_base: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct ScheduleConfig {
    poster_times: Vec<String>,
    responder_interval_minutes: u32,
    refresh_token_day: String,
    refresh_token_time: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Profile {
    id: String,
    name: String,
    ig_user_id: String,
    ig_access_token: String,
    r2: R2Config,
    gemini_api_keys: Vec<String>,
    ai_reply_enabled: bool,
    queue_folder: String,
    posted_folder: String,
    node_exe_path: String,
    project_folder: String,
    schedule: ScheduleConfig,
    ai_style_preset: String,
    ai_max_sentences: u32,
    ai_custom_instruction: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ProfilesStore {
    profiles: Vec<Profile>,
    active_profile_id: String,
}

#[derive(Serialize, Clone)]
struct ProfileSummary {
    id: String,
    name: String,
}

#[derive(Serialize)]
struct DashboardState {
    last_post_id: Option<String>,
    last_post_type: Option<String>,
    last_post_time: Option<String>,
    queue_count: usize,
    next_in_queue: Option<String>,
}

fn new_profile_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("p{millis}")
}

fn default_profile(name: &str) -> Profile {
    let mut p = Profile::default();
    p.id = new_profile_id();
    p.name = name.to_string();
    p.gemini_api_keys = vec!["".to_string()];
    p.schedule.poster_times = vec!["07:00".to_string()];
    p.schedule.responder_interval_minutes = 2; // Cek Komen/DM lebih cepat (2 menit)
    p.schedule.refresh_token_day = "MON".to_string();
    p.schedule.refresh_token_time = "03:00".to_string();
    p.ai_style_preset = "ramah_sopan".to_string();
    p.ai_max_sentences = 2;
    p
}

fn slugify(input: &str) -> String {
    let cleaned: String = input
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if cleaned.is_empty() { "profil".to_string() } else { cleaned }
}

fn profiles_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("Gagal: {e}"))?;
    if !dir.exists() { fs::create_dir_all(&dir).map_err(|e| format!("Gagal: {e}"))?; }
    Ok(dir.join("ig-profiles.json")) // Nama file diubah biar ga tabrakan sama Threads
}

fn read_store(app: &tauri::AppHandle) -> Result<ProfilesStore, String> {
    let path = profiles_file_path(app)?;
    if !path.exists() {
        let default = default_profile("IG Akun 1");
        let store = ProfilesStore { active_profile_id: default.id.clone(), profiles: vec![default] };
        write_store(app, &store)?;
        return Ok(store);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Gagal baca json: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Format JSON rusak: {e}"))
}

fn write_store(app: &tauri::AppHandle, store: &ProfilesStore) -> Result<(), String> {
    let path = profiles_file_path(app)?;
    let content = serde_json::to_string_pretty(store).unwrap();
    fs::write(&path, content).map_err(|e| format!("Gagal simpan json: {e}"))
}

#[tauri::command]
fn list_profiles(app: tauri::AppHandle) -> Result<Vec<ProfileSummary>, String> {
    let store = read_store(&app)?;
    Ok(store.profiles.iter().map(|p| ProfileSummary { id: p.id.clone(), name: p.name.clone() }).collect())
}

#[tauri::command]
fn get_active_profile(app: tauri::AppHandle) -> Result<Profile, String> {
    let store = read_store(&app)?;
    if let Some(p) = store.profiles.iter().find(|p| p.id == store.active_profile_id) { return Ok(p.clone()); }
    if let Some(p) = store.profiles.first() { return Ok(p.clone()); }
    Err("Tidak ada profil.".into())
}

#[tauri::command]
fn load_profile(app: tauri::AppHandle, id: String) -> Result<Profile, String> {
    let store = read_store(&app)?;
    store.profiles.iter().find(|p| p.id == id).cloned().ok_or_else(|| "Profil tidak ditemukan.".into())
}

#[tauri::command]
fn create_profile(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    let mut store = read_store(&app)?;
    let new_p = default_profile(if name.trim().is_empty() { "Profil Baru" } else { &name });
    store.profiles.push(new_p.clone());
    store.active_profile_id = new_p.id.clone();
    write_store(&app, &store)?;
    Ok(new_p)
}

#[tauri::command]
fn delete_profile(app: tauri::AppHandle, id: String) -> Result<Vec<ProfileSummary>, String> {
    let mut store = read_store(&app)?;
    if let Some(p) = store.profiles.iter().find(|p| p.id == id) { cleanup_tasks_for_profile(&p.name); }
    store.profiles.retain(|p| p.id != id);
    if store.active_profile_id == id {
        store.active_profile_id = store.profiles.first().map(|p| p.id.clone()).unwrap_or_default();
    }
    write_store(&app, &store)?;
    Ok(store.profiles.iter().map(|p| ProfileSummary { id: p.id.clone(), name: p.name.clone() }).collect())
}

fn upsert_profile_in_store(app: &tauri::AppHandle, profile: &Profile) -> Result<(), String> {
    let mut store = read_store(app)?;
    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) { *existing = profile.clone(); } 
    else { store.profiles.push(profile.clone()); }
    store.active_profile_id = profile.id.clone();
    write_store(app, &store)
}

fn sync_env_file(profile: &Profile) -> Result<(), String> {
    if profile.project_folder.trim().is_empty() { return Ok(()); }
    let gemini_keys_joined = profile.gemini_api_keys.join(",");
    let content = format!(
        "IG_USER_ID={}\nIG_ACCESS_TOKEN={}\nR2_ACCOUNT_ID={}\nR2_ACCESS_KEY_ID={}\nR2_SECRET_ACCESS_KEY={}\nR2_BUCKET_NAME={}\nR2_PUBLIC_URL_BASE={}\nGEMINI_API_KEYS={}\nQUEUE_FOLDER={}\nPOSTED_FOLDER={}\n",
        profile.ig_user_id, profile.ig_access_token, profile.r2.account_id, profile.r2.access_key_id,
        profile.r2.secret_access_key, profile.r2.bucket_name, profile.r2.public_url_base, gemini_keys_joined,
        profile.queue_folder, profile.posted_folder,
    );
    let env_path = format!("{}\\.env", profile.project_folder.trim_end_matches('\\'));
    fs::write(&env_path, content).map_err(|e| format!("Gagal menulis .env: {e}"))
}

fn sync_ai_style_file(profile: &Profile) -> Result<(), String> {
    if profile.project_folder.trim().is_empty() { return Ok(()); }
    #[derive(Serialize)]
    struct AiStyleFile { style_preset: String, max_sentences: u32, custom_instruction: String }
    let style = AiStyleFile {
        style_preset: if profile.ai_style_preset.is_empty() { "ramah_sopan".to_string() } else { profile.ai_style_preset.clone() },
        max_sentences: if profile.ai_max_sentences == 0 { 2 } else { profile.ai_max_sentences },
        custom_instruction: profile.ai_custom_instruction.clone(),
    };
    let content = serde_json::to_string_pretty(&style).unwrap();
    let path = format!("{}\\ai-style.json", profile.project_folder.trim_end_matches('\\'));
    fs::write(&path, content).map_err(|e| format!("Gagal menulis ai-style.json: {e}"))
}

#[tauri::command]
fn save_profile(app: tauri::AppHandle, profile: Profile) -> Result<(), String> {
    upsert_profile_in_store(&app, &profile)?;
    sync_env_file(&profile)?;
    sync_ai_style_file(&profile)?;
    Ok(())
}

const MAX_POSTER_SLOTS: u32 = 30;
fn task_name_poster(slug: &str, index: u32) -> String { format!("IGAutomator_{slug}_Poster_{index}") }
fn task_name_responder(slug: &str) -> String { format!("IGAutomator_{slug}_Responder") }
fn task_name_refresh_token(slug: &str) -> String { format!("IGAutomator_{slug}_RefreshToken") }

fn run_schtasks(args: &[&str]) -> String {
    match hidden_command("schtasks").args(args).output() {
        Ok(out) => if out.status.success() { format!("OK: schtasks {}", args.join(" ")) } 
                   else { format!("GAGAL: schtasks {} -> {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()) },
        Err(e) => format!("ERROR menjalankan schtasks: {e}"),
    }
}

fn delete_task_silent(name: &str) { let _ = hidden_command("schtasks").args(["/Delete", "/TN", name, "/F"]).output(); }
fn cleanup_tasks_for_profile(profile_name: &str) {
    let slug = slugify(profile_name);
    for i in 1..=MAX_POSTER_SLOTS { delete_task_silent(&task_name_poster(&slug, i)); }
    delete_task_silent(&task_name_responder(&slug));
    delete_task_silent(&task_name_refresh_token(&slug));
}

#[tauri::command]
fn disable_schedule(profile_name: String) -> Result<String, String> {
    cleanup_tasks_for_profile(&profile_name);
    Ok("Bot IG berhasil DIMATIKAN. Jadwal telah dicabut.".into())
}

fn build_tr_value(node_exe: &str, script_path: &str) -> String { format!("\"{node_exe}\" \"{script_path}\"") }

#[tauri::command]
fn apply_schedule(app: tauri::AppHandle, profile: Profile) -> Result<Vec<String>, String> {
    upsert_profile_in_store(&app, &profile)?;
    sync_env_file(&profile)?;
    sync_ai_style_file(&profile)?;

    if profile.node_exe_path.trim().is_empty() { return Err("Path node.exe belum diisi.".into()); }
    if profile.project_folder.trim().is_empty() { return Err("Folder proyek belum diisi.".into()); }

    let slug = slugify(&profile.name);
    let mut log = Vec::new();
    let node_exe = &profile.node_exe_path;
    let project = profile.project_folder.trim_end_matches('\\');

    for i in 1..=MAX_POSTER_SLOTS { delete_task_silent(&task_name_poster(&slug, i)); }
    let script_tp = format!("{project}\\ig-poster.js");
    let tr_tp = build_tr_value(node_exe, &script_tp);
    for (idx, time) in profile.schedule.poster_times.iter().enumerate() {
        let name = task_name_poster(&slug, (idx as u32) + 1);
        let res = run_schtasks(&["/Create", "/SC", "DAILY", "/ST", time, "/TN", &name, "/TR", &tr_tp, "/RU", "SYSTEM", "/F"]);
        log.push(format!("[{} - IG Poster @ {time}] {res}", profile.name));
    }

    let name_cr = task_name_responder(&slug);
    delete_task_silent(&name_cr);
    if profile.schedule.responder_interval_minutes > 0 {
        let res = run_schtasks(&["/Create", "/SC", "MINUTE", "/MO", &profile.schedule.responder_interval_minutes.to_string(), "/TN", &name_cr, "/TR", &build_tr_value(node_exe, &format!("{project}\\ig-responder.js")), "/RU", "SYSTEM", "/F"]);
        log.push(format!("[{} - IG Komen & DM] {res}", profile.name));
    }

    let name_rt = task_name_refresh_token(&slug);
    delete_task_silent(&name_rt);
    if !profile.schedule.refresh_token_day.is_empty() && !profile.schedule.refresh_token_time.is_empty() {
        let res = run_schtasks(&["/Create", "/SC", "WEEKLY", "/D", &profile.schedule.refresh_token_day, "/ST", &profile.schedule.refresh_token_time, "/TN", &name_rt, "/TR", &build_tr_value(node_exe, &format!("{project}\\refresh-token.js")), "/RU", "SYSTEM", "/F"]);
        log.push(format!("[{} - Refresh Token] {res}", profile.name));
    }

    Ok(log)
}

#[tauri::command]
fn setup_project(app: tauri::AppHandle, profile: Profile) -> Result<Vec<String>, String> {
    let project = profile.project_folder.trim_end_matches('\\').to_string();
    let mut log = Vec::new();

    if !std::path::Path::new(&project).exists() { fs::create_dir_all(&project).unwrap(); }

    fs::write(format!("{project}\\ig-poster.js"), SCRIPT_IG_POSTER).unwrap();
    fs::write(format!("{project}\\ig-responder.js"), SCRIPT_IG_RESPONDER).unwrap();
    fs::write(format!("{project}\\refresh-token.js"), SCRIPT_REFRESH_TOKEN).unwrap();

    let trigger_path = format!("{project}\\trigger-rules.json");
    if !std::path::Path::new(&trigger_path).exists() { fs::write(&trigger_path, SCRIPT_TRIGGER_RULES).unwrap(); }
    let pkg_path = format!("{project}\\package.json");
    if !std::path::Path::new(&pkg_path).exists() { fs::write(&pkg_path, SCRIPT_PACKAGE_JSON).unwrap(); }

    let q_path = if profile.queue_folder.is_empty() { format!("{project}\\queue") } else { profile.queue_folder.clone() };
    let p_path = if profile.posted_folder.is_empty() { format!("{project}\\posted") } else { profile.posted_folder.clone() };
    if !std::path::Path::new(&q_path).exists() { fs::create_dir_all(&q_path).unwrap(); }
    if !std::path::Path::new(&p_path).exists() { fs::create_dir_all(&p_path).unwrap(); }

    let mut up_prof = profile.clone();
    up_prof.queue_folder = q_path; up_prof.posted_folder = p_path;
    upsert_profile_in_store(&app, &up_prof)?;
    sync_env_file(&up_prof)?; sync_ai_style_file(&up_prof)?;
    log.push("File & folder IG sukses dibuat.".into());

    let node_dir = std::path::Path::new(&profile.node_exe_path).parent().unwrap().to_string_lossy().to_string();
    let npm_out = hidden_command(&format!("{node_dir}\\npm.cmd")).arg("install").current_dir(&project).output();
    if let Ok(o) = npm_out {
        if o.status.success() { log.push("OK: npm install selesai.".into()); }
        else { log.push(format!("GAGAL npm install: {}", String::from_utf8_lossy(&o.stderr))); }
    }
    Ok(log)
}

#[tauri::command]
fn detect_node_path() -> Result<String, String> {
    let out = hidden_command("where").arg("node").output().map_err(|e| format!("Error: {e}"))?;
    if !out.status.success() { return Err("node.exe tidak ditemukan di PATH.".into()); }
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string())
}

#[tauri::command]
fn get_dashboard_data(app: tauri::AppHandle, profile_id: String) -> Result<DashboardState, String> {
    let store = read_store(&app)?;
    let profile = store.profiles.iter().find(|p| p.id == profile_id).ok_or("Profil tidak ditemukan")?;

    let mut state = DashboardState {
        last_post_id: None, last_post_type: None, last_post_time: None, queue_count: 0, next_in_queue: None,
    };

    if profile.project_folder.trim().is_empty() { return Ok(state); }

    let posted_file = format!("{}\\posted-index.json", profile.project_folder.trim_end_matches('\\'));
    if let Ok(content) = fs::read_to_string(&posted_file) {
        if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
            if let Some(last) = parsed.last() {
                state.last_post_id = last.get("postId").and_then(|v| v.as_str()).map(|s| s.to_string());
                state.last_post_type = last.get("type").and_then(|v| v.as_str()).map(|s| s.to_string());
                state.last_post_time = last.get("postedAt").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }
    }

    if !profile.queue_folder.is_empty() {
        if let Ok(entries) = fs::read_dir(&profile.queue_folder) {
            let mut oldest_time = std::time::SystemTime::UNIX_EPOCH;
            let mut oldest_name = String::new();
            let mut groups = std::collections::HashSet::new();
            let mut first = true;

            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        let filename = entry.file_name().to_string_lossy().to_string();
                        let base = filename.split('.').next().unwrap_or("").to_string();
                        let base_clean = base.replace("_link", "");
                        let base_clean = if let Some(idx) = base_clean.find("_slide") { base_clean[..idx].to_string() } else { base_clean };
                        
                        groups.insert(base_clean.clone());

                        let file_time = meta.modified().unwrap_or_else(|_| meta.created().unwrap_or(std::time::SystemTime::now()));
                        if first || file_time < oldest_time {
                            oldest_time = file_time;
                            oldest_name = base_clean;
                            first = false;
                        }
                    }
                }
            }
            state.queue_count = groups.len();
            if !oldest_name.is_empty() { state.next_in_queue = Some(oldest_name); }
        }
    }

    Ok(state)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_profiles, get_active_profile, load_profile, create_profile, delete_profile,
            save_profile, apply_schedule, setup_project, detect_node_path,
            get_dashboard_data, disable_schedule
        ])
        .run(tauri::generate_context!())
        .expect("Gagal menjalankan aplikasi Tauri");
}