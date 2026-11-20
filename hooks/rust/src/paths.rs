//! search-path-guard and absolute-path-rescue (they share the rescue algorithm).

use crate::common::{deny, exists, is_plugin_agent, str_of};
use crate::pathops::Flavor;
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::Path;

/// Re-anchor a guessed absolute path onto the workspace: the longest suffix of
/// the workspace found exactly once in the guess, with its FULL tail existing.
pub fn find_rescued_suffix(raw: &str, workspace: &str, fl: Flavor, exists_fn: &dyn Fn(&str) -> bool) -> Option<String> {
    let sep = fl.sep();
    let root = fl.resolve(workspace, "");
    let resolved_raw = fl.resolve(workspace, raw);
    if resolved_raw == root || resolved_raw.starts_with(&format!("{root}{sep}")) {
        return None;
    }
    let normalized: String = if sep == '/' { raw.to_string() } else { raw.replace('/', "\\") };
    let guess: Vec<&str> = normalized.split(sep).filter(|s| !s.is_empty()).collect();
    if guess.iter().any(|s| *s == ".." || *s == ".") {
        return None;
    }
    let root_segs: Vec<&str> = root.split(sep).filter(|s| !s.is_empty()).collect();
    for len in (1..=root_segs.len()).rev() {
        let anchor = &root_segs[root_segs.len() - len..];
        let hits: Vec<usize> = (0..=guess.len().saturating_sub(len))
            .filter(|&i| i + len <= guess.len() && anchor.iter().enumerate().all(|(j, seg)| guess[i + j] == *seg))
            .collect();
        if hits.is_empty() {
            continue;
        }
        if hits.len() > 1 {
            return None;
        }
        let mut parts: Vec<&str> = vec![root.as_str()];
        parts.extend(&guess[hits[0] + len..]);
        let candidate = if parts.len() == 1 {
            root.clone()
        } else {
            let mut c = root.trim_end_matches(sep).to_string();
            for t in &parts[1..] {
                c.push(sep);
                c.push_str(t);
            }
            c
        };
        return if exists_fn(&candidate) { Some(candidate) } else { None };
    }
    None
}

fn fs_exists(p: &str) -> bool {
    exists(Path::new(p))
}

fn is_missing(p: &str) -> bool {
    matches!(std::fs::metadata(p), Err(e) if e.kind() == ErrorKind::NotFound)
}

fn home_dir() -> String {
    let k = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(k).unwrap_or_default()
}

/// Mirrors resolveSearchPath in search-path-guard.mjs.
pub fn resolve_search_path(cwd: &str, raw: &str, fl: Flavor, is_win_platform: bool) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    if raw == "~" || raw.starts_with("~/") || (is_win_platform && raw.starts_with("~\\")) {
        let tail = if raw.len() >= 2 { &raw[2..] } else { "" };
        let joined = format!("{}{}{}", home_dir(), fl.sep(), tail);
        return Some(fl.resolve(cwd, &joined));
    }
    if is_win_platform {
        let b = raw.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b'/' {
            let drive = (b[1] as char).to_ascii_uppercase();
            return Some(fl.resolve(&format!("{drive}:\\"), &raw[3..]));
        }
    }
    if fl.is_absolute(raw) {
        return Some(raw.to_string());
    }
    Some(fl.resolve(cwd, raw))
}

pub fn search_guard(input: &Value) -> Option<Value> {
    let tool = str_of(input, "tool_name");
    if tool != "Grep" && tool != "Glob" {
        return None;
    }
    if !is_plugin_agent(input) {
        return None;
    }
    let raw = input.get("tool_input")?.get("path")?.as_str()?;
    if raw.is_empty() || (tool == "Glob" && (raw == "undefined" || raw == "null")) {
        return None;
    }
    let fl = Flavor::native();
    let cwd = str_of(input, "cwd");
    let resolved = resolve_search_path(cwd, raw, fl, cfg!(windows))?;
    match std::fs::metadata(&resolved) {
        Ok(_) => return None,
        Err(e) => {
            let not_dir = e.raw_os_error() == Some(if cfg!(windows) { 267 } else { 20 });
            if not_dir {
                return Some(deny(&format!(
                    "Search path is invalid: {resolved} (from \"{raw}\"). A path component is not a directory (ENOTDIR), so the {tool} search was blocked before it ran. Verify the target path and that every parent component is a directory."
                )));
            }
            if e.kind() != ErrorKind::NotFound {
                return None;
            }
        }
    }
    if fl.is_absolute(raw) && find_rescued_suffix(raw, cwd, fl, &fs_exists).is_some() {
        return None;
    }
    Some(deny(&format!(
        "Search path does not exist: {resolved} (from \"{raw}\"). The {tool} search was blocked before it ran. Verify the target path, or list its parent directory to find the correct location."
    )))
}

pub fn rescue(input: &Value) -> Option<Value> {
    let key = match str_of(input, "tool_name") {
        "Read" => "file_path",
        "Grep" | "Glob" => "path",
        _ => return None,
    };
    if !is_plugin_agent(input) {
        return None;
    }
    let tool_input = input.get("tool_input")?.as_object()?;
    let raw = tool_input.get(key)?.as_str()?;
    let fl = Flavor::native();
    if raw.is_empty() || !fl.is_absolute(raw) {
        return None;
    }
    let cwd = str_of(input, "cwd");
    if cwd.is_empty() || !is_missing(raw) {
        return None;
    }
    let rescued = find_rescued_suffix(raw, cwd, fl, &fs_exists)?;
    let mut updated = tool_input.clone();
    updated.insert(key.to_string(), Value::String(rescued));
    Some(json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "updatedInput": Value::Object(updated)
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pathops::Flavor::{Posix, Win};

    const WS: &str = "/home/u/Work/Parent/Child/Project";

    fn ex(want: &'static str) -> impl Fn(&str) -> bool {
        move |p| p == want
    }

    #[test]
    fn re_anchors_a_guess_with_dropped_parents() {
        let r = find_rescued_suffix("/home/u/Work/Project/src/a.ts", WS, Posix, &ex("/home/u/Work/Parent/Child/Project/src/a.ts"));
        assert_eq!(r.as_deref(), Some("/home/u/Work/Parent/Child/Project/src/a.ts"));
    }

    #[test]
    fn under_workspace_is_never_rescued() {
        assert_eq!(find_rescued_suffix(&format!("{WS}/nope.ts"), WS, Posix, &|_| true), None);
    }

    #[test]
    fn missing_tail_ambiguous_anchor_and_dots_are_rejected() {
        assert_eq!(find_rescued_suffix("/home/u/Work/Project/src/a.ts", WS, Posix, &|_| false), None);
        assert_eq!(find_rescued_suffix("/x/Project/y/Project/src/a.ts", WS, Posix, &|_| true), None);
        assert_eq!(find_rescued_suffix("/home/u/Work/Project/../src/a.ts", WS, Posix, &|_| true), None);
    }

    #[test]
    fn windows_forward_slash_guess() {
        let r = find_rescued_suffix("C:/Users/proj/src/a.ts", "C:\\Users\\u\\proj", Win, &ex("C:\\Users\\u\\proj\\src\\a.ts"));
        assert_eq!(r.as_deref(), Some("C:\\Users\\u\\proj\\src\\a.ts"));
    }

    #[test]
    fn empty_tail_rescues_to_workspace_root() {
        let r = find_rescued_suffix("/home/u/Work/Project", WS, Posix, &|p| p == WS);
        assert_eq!(r.as_deref(), Some(WS));
    }

    #[test]
    fn search_path_resolution() {
        assert_eq!(resolve_search_path("/w/proj", "src", Posix, false).as_deref(), Some("/w/proj/src"));
        assert_eq!(resolve_search_path("/w/proj", "/abs/x", Posix, false).as_deref(), Some("/abs/x"));
        assert_eq!(resolve_search_path("", "src", Posix, false), None);
        assert_eq!(resolve_search_path("C:\\w", "/d/Projects/x", Win, true).as_deref(), Some("D:\\Projects\\x"));
        assert_eq!(resolve_search_path("/w", "/d/Projects/x", Posix, false).as_deref(), Some("/d/Projects/x"));
        assert_eq!(resolve_search_path("C:\\w", "/dev/null", Win, true).as_deref(), Some("/dev/null"));
    }
}
