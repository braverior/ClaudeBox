mod claude;

use claude::ProcessManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ProcessManager::new())
        .setup(|app| {
            // Clean up stale clipboard images from previous sessions
            claude::cleanup_old_tmp_images();

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
            claude::clear_session_resume,
            claude::apply_system_proxy,
            claude::probe_url,
            claude::check_claude_installed,
            claude::check_node_version,
            claude::check_model_available,
            claude::get_git_branch,
            claude::list_git_branches,
            claude::checkout_git_branch,
            claude::open_in_browser,
            claude::open_in_terminal,
            claude::reveal_in_finder,
            claude::git_diff_files,
            claude::git_diff,
            claude::list_dir,
            claude::read_file,
            claude::read_image_base64,
            claude::save_clipboard_image,
            claude::storage_read,
            claude::storage_write,
            claude::storage_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
