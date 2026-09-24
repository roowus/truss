//! Truss desktop shell — one native window pointed at the Truss server.
//! TRUSS_URL overrides the default https://truss.rewis (e.g. LAN or staging).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_URL: &str = "https://truss.rewis";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url = std::env::var("TRUSS_URL").unwrap_or_else(|_| DEFAULT_URL.into());
            let parsed: tauri::Url = url.parse().expect("TRUSS_URL must be a valid URL");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Truss")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Truss");
}
