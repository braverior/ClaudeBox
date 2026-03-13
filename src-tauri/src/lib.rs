mod claude;

use claude::ProcessManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessManager::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude::send_message,
            claude::send_response,
            claude::stop_session,
            claude::check_claude_installed,
            claude::get_git_branch,
            claude::open_in_browser,
            claude::list_dir,
            claude::read_file,
            claude::read_image_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
