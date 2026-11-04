mod commands;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::FileAccess::default())
        .plugin(tauri_plugin_dialog::init())
        // Store remains Rust-only. No general-purpose filesystem or store IPC is exposed.
        .plugin(tauri_plugin_store::Builder::default().build())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                    let app = window.app_handle().clone();
                    let label = window.label().to_owned();
                    let paths = paths.clone();
                    // Tauri emits its built-in drag event before calling this handler.
                    // Publish our own event only after grants exist, off the UI thread.
                    tauri::async_runtime::spawn_blocking(move || {
                        let access = app.state::<commands::FileAccess>();
                        access.approve_dropped(&paths);
                        let paths: Vec<_> = paths
                            .iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect();
                        let _ = app.emit_to(&label, "subtitle-tools:files-dropped", paths);
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::select_files,
            commands::read_dropped_files,
            commands::select_directory,
            commands::save_output,
            commands::open_output_directory,
            commands::get_local_value,
            commands::set_local_value,
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Subtitle Tools");
}
