//! Shared helpers: input parsing, plugin-agent filter, output shapes.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const PLUGIN_NAME: &str = "lil-slim";

pub fn read_input() -> Option<Value> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok()?;
    match serde_json::from_str::<Value>(&s) {
        Ok(v) if v.is_object() => Some(v),
        _ => None,
    }
}

pub fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Name of a plugin-owned agent from `agent_type`, or None.
pub fn agent_name(input: &Value) -> Option<String> {
    let t = input.get("agent_type")?.as_str()?;
    let name = t.strip_prefix(&format!("{PLUGIN_NAME}:"))?;
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn plugin_root() -> PathBuf {
    if let Some(r) = std::env::var_os("CLAUDE_PLUGIN_ROOT") {
        return PathBuf::from(r);
    }
    // <root>/hooks/rust/target/release/lil-hook  or  <root>/hooks/bin/lil-hook
    let exe = std::env::current_exe().unwrap_or_default();
    for anc in exe.ancestors().skip(1) {
        if anc.join("agents").is_dir() {
            return anc.to_path_buf();
        }
    }
    PathBuf::new()
}

pub fn is_plugin_agent(input: &Value) -> bool {
    let Some(name) = agent_name(input) else { return false };
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return false;
    }
    plugin_root().join("agents").join(format!("{name}.md")).exists()
}

pub fn state_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_PLUGIN_DATA") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::temp_dir().join(PLUGIN_NAME),
    }
}

pub fn deny(reason: &str) -> Value {
    json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason
    }})
}

pub fn context(event: &str, text: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})
}

pub fn exists(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}
