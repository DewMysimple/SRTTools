mod commands;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let external = commands::explorer::ExternalImports::default();
    external.enqueue(
        &std::env::args().collect::<Vec<_>>(),
        &std::env::current_dir().unwrap_or_default(),
    );
    let builder = tauri::Builder::default();
    // Must be the first plugin: second processes forward arguments before creating a WebView.
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        commands::explorer::forward,
    ));
    builder
        .manage(external)
        .manage(commands::FileAccess::default())
        .manage(commands::FolderImports::default())
        .manage(commands::FolderExports::default())
        .manage(commands::media::MediaAccess::default())
        .register_asynchronous_uri_scheme_protocol(commands::media::SCHEME, commands::media::handle)
        .plugin(tauri_plugin_dialog::init())
        // Store remains Rust-only. No general-purpose filesystem or store IPC is exposed.
        .plugin(tauri_plugin_store::Builder::default().build())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                webview.state::<commands::media::MediaAccess>().clear();
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if matches!(event, WindowEvent::Destroyed) {
                    window.state::<commands::media::MediaAccess>().clear();
                }
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
            commands::folder_import::select_import_folder,
            commands::folder_import::cancel_folder_import,
            commands::folder_export::prepare_folder_export,
            commands::folder_export::write_folder_export,
            commands::folder_export::finish_folder_export,
            commands::explorer::get_explorer_integration,
            commands::explorer::set_explorer_integration,
            commands::explorer::take_external_imports,
            commands::read_dropped_files,
            commands::media::select_video,
            commands::media::release_video,
            commands::select_directory,
            commands::save_output,
            commands::open_output_directory,
            commands::get_local_value,
            commands::set_local_value,
            commands::preset_storage::get_preset_values,
            commands::preset_storage::set_preset_values,
            commands::preset_storage::read_preset_import_file,
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Subtitle Tools");
}
