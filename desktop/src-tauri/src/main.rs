// Vocalo desktop: a native window (WKWebView on macOS) around the stage that the
// Vocalo Node process serves on localhost. No bundled Chromium, no Node inside.
//   vocalo-desktop [url]     (default http://127.0.0.1:8766, or $VOCALO_URL)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let url = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("http"))
        .or_else(|| std::env::var("VOCALO_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:8766".into());

    tauri::Builder::default()
        .setup(move |app| {
            let parsed = url.parse().expect("invalid Vocalo URL");
            let builder = WebviewWindowBuilder::new(app, "stage", WebviewUrl::External(parsed))
                .title("Vocalo")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .background_color(tauri::window::Color(0, 0, 0, 255));
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vocalo desktop");
}
