//! lil-hook: Rust build of the lil-slim guard hooks, one subcommand per hook.
//!   phase-reminder | search-path-guard | absolute-path-rescue
//!   tool-loop-guard | readonly-shell-guard
//! Mirrors hooks/scripts/*.mjs. Any unreadable input or internal failure exits 0
//! with no output, so a hook bug never blocks the user's work.

mod common;
mod loopguard;
mod pathops;
mod paths;
mod phase;
mod shell;

use common::read_input;

fn main() {
    let hook = std::env::args().nth(1).unwrap_or_default();
    let Some(input) = read_input() else { return };
    let out = match hook.as_str() {
        "phase-reminder" => phase::decide(&input),
        "search-path-guard" => paths::search_guard(&input),
        "absolute-path-rescue" => paths::rescue(&input),
        "tool-loop-guard" => loopguard::decide(&input),
        "readonly-shell-guard" => shell::decide(&input),
        _ => None,
    };
    if let Some(v) = out {
        print!("{v}");
    }
}
