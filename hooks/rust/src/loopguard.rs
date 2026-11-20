//! tool-loop-guard: warn at 3 and block at 5 identical read-only calls with
//! identical results. Same state format, thresholds and fingerprint as the
//! Node script, so either implementation can read the other's state files.

use crate::common::{context, deny, is_plugin_agent, state_dir, str_of};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const WARN_AT: u64 = 3;
pub const BLOCK_AT: u64 = 5;
pub const MAX_STATE_FILES: usize = 64;
const STALE_TMP: Duration = Duration::from_secs(60);
const BLOCK_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
const EXEMPT: [&str; 9] = ["Task", "Agent", "TaskOutput", "TaskStop", "TaskGet", "TaskList", "BashOutput", "KillShell", "Monitor"];
const VOLATILE: [&str; 2] = ["durationMs", "duration_ms"];

pub fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut s = String::with_capacity(40);
    for x in h {
        let _ = write!(s, "{x:08x}");
    }
    s
}

/// JavaScript-compatible number text: integers without ".0", no exponent for
/// ordinary magnitudes. Exotic floats may differ from V8; that only resets state.
fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{f:.0}");
    }
    format!("{f}")
}

/// Mirrors `stable()` in tool-loop-guard.mjs: key-sorted JSON (UTF-16 order),
/// volatile timing keys dropped.
pub fn stable(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::String(s)) => serde_json::to_string(s).unwrap_or_default(),
        Some(Value::Array(a)) => {
            let parts: Vec<String> = a.iter().map(|x| stable(Some(x))).collect();
            format!("[{}]", parts.join(","))
        }
        Some(Value::Object(o)) => {
            let mut keys: Vec<&String> = o.keys().filter(|k| !VOLATILE.contains(&k.as_str())).collect();
            keys.sort_by_key(|k| k.encode_utf16().collect::<Vec<u16>>());
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), stable(o.get(k.as_str()))))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

pub fn fingerprint(tool: &str, args: Option<&Value>) -> String {
    sha1_hex(format!("{tool}\0{}", stable(args)).as_bytes())
}

fn state_file(dir: &Path, input: &Value) -> PathBuf {
    let session = str_of(input, "session_id");
    let agent = input.get("agent_id").and_then(Value::as_str).unwrap_or("main");
    dir.join(format!("loop-{}.json", sha1_hex(format!("{session}\0{agent}").as_bytes())))
}

struct State {
    fp: String,
    out: String,
    runs: u64,
}

fn load(file: &Path) -> Option<State> {
    let text = std::fs::read_to_string(file).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(State {
        fp: v.get("fp")?.as_str()?.to_string(),
        out: v.get("out").and_then(Value::as_str).unwrap_or("").to_string(),
        runs: v.get("runs")?.as_f64()? as u64,
    })
}

fn save(dir: &Path, file: &Path, st: &State) {
    let _ = std::fs::create_dir_all(dir);
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    let body = json!({"fp": st.fp, "out": st.out, "runs": st.runs}).to_string();
    let ok = std::fs::write(&tmp, body).is_ok() && (0..5).any(|_| std::fs::rename(&tmp, file).is_ok());
    if !ok {
        let _ = std::fs::remove_file(&tmp);
    }
    prune(dir);
}

fn prune(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(mtime) = e.metadata().and_then(|m| m.modified()) else { continue };
        if name.ends_with(".tmp") {
            if now.duration_since(mtime).unwrap_or_default() > STALE_TMP {
                let _ = std::fs::remove_file(e.path());
            }
        } else if name.starts_with("loop-") && name.ends_with(".json") {
            files.push((mtime, e.path()));
        }
    }
    if files.len() <= MAX_STATE_FILES {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - MAX_STATE_FILES;
    for (_, p) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

pub fn decide(input: &Value) -> Option<Value> {
    decide_in(input, &state_dir(), None)
}

/// `agents_root` overrides plugin-agent detection for tests.
pub fn decide_in(input: &Value, dir: &Path, agents_ok: Option<bool>) -> Option<Value> {
    let tool = input.get("tool_name")?.as_str()?;
    let event = str_of(input, "hook_event_name");
    if EXEMPT.contains(&tool) || (event != "PreToolUse" && event != "PostToolUse") {
        return None;
    }
    if !agents_ok.unwrap_or_else(|| is_plugin_agent(input)) {
        return None;
    }
    let file = state_file(dir, input);
    let fp = fingerprint(tool, input.get("tool_input"));
    let prev = load(&file);

    if event == "PreToolUse" {
        if let Some(p) = &prev {
            if BLOCK_TOOLS.contains(&tool) && p.fp == fp && p.runs >= BLOCK_AT {
                return Some(deny(&format!(
                    "Blocked: identical {tool} call repeated {} times with identical results. Change approach.",
                    p.runs
                )));
            }
        }
        return None;
    }

    let out = sha1_hex(stable(input.get("tool_response")).as_bytes());
    let runs = match &prev {
        Some(p) if p.fp == fp && p.out == out => p.runs + 1,
        _ => 1,
    };
    save(dir, &file, &State { fp, out, runs });
    if runs >= WARN_AT {
        return Some(context(
            "PostToolUse",
            &format!("You repeated the identical {tool} call {runs} times with identical results. Stop and change approach."),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, over: Value) -> Value {
        let mut base = json!({
            "hook_event_name": event, "session_id": "s1", "agent_type": "lil-slim:explorer",
            "tool_name": "Read", "tool_input": {"file_path": "/a"}, "tool_response": {"content": "same"}
        });
        for (k, v) in over.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lilhook-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sha1_known_vectors() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(&[b'a'; 1000]), "291e9a6c66994949b57ba5e650361e98fc36b1ba");
    }

    #[test]
    fn stable_sorts_keys_and_drops_timing() {
        let a = json!({"b": {"d": 3, "c": 2}, "a": 1, "durationMs": 99});
        let b = json!({"a": 1, "b": {"c": 2, "d": 3}});
        assert_eq!(stable(Some(&a)), stable(Some(&b)));
        assert_eq!(stable(Some(&a)), r#"{"a":1,"b":{"c":2,"d":3}}"#);
        assert_eq!(stable(None), "undefined");
        assert_eq!(stable(Some(&json!(1.0))), "1");
        assert_eq!(stable(Some(&json!("é\n"))), "\"é\\n\"");
    }

    #[test]
    fn warns_on_third_and_blocks_after_fifth() {
        let d = tmpdir("warn");
        let post = |i: usize| decide_in(&ev("PostToolUse", json!({})), &d, Some(true)).map(|_| i);
        assert!(post(1).is_none());
        assert!(post(2).is_none());
        assert!(post(3).is_some());
        post(4);
        post(5);
        let pre = decide_in(&ev("PreToolUse", json!({})), &d, Some(true)).unwrap();
        assert_eq!(pre["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(pre["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().contains("5 times"));
    }

    #[test]
    fn timing_fields_do_not_reset_the_run() {
        let d = tmpdir("timing");
        let mut last = None;
        for i in 0..5 {
            last = decide_in(&ev("PostToolUse", json!({"tool_name": "Glob", "tool_input": {"pattern": "*"}, "tool_response": {"filenames": ["a"], "durationMs": 40 + i}})), &d, Some(true));
        }
        assert!(last.is_some());
    }

    #[test]
    fn exempt_tools_and_other_agents_are_silent() {
        let d = tmpdir("exempt");
        for _ in 0..6 {
            assert!(decide_in(&ev("PostToolUse", json!({"tool_name": "TaskOutput"})), &d, Some(true)).is_none());
        }
        assert!(decide_in(&ev("PostToolUse", json!({})), &d, Some(false)).is_none());
    }

    #[test]
    fn corrupt_state_is_treated_as_empty() {
        let d = tmpdir("corrupt");
        decide_in(&ev("PostToolUse", json!({})), &d, Some(true));
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            std::fs::write(e.path(), "{{{").unwrap();
        }
        assert!(decide_in(&ev("PostToolUse", json!({})), &d, Some(true)).is_none());
        assert!(decide_in(&ev("PostToolUse", json!({})), &d, Some(true)).is_none());
        assert!(decide_in(&ev("PostToolUse", json!({})), &d, Some(true)).is_some());
    }

    #[test]
    fn state_files_are_capped() {
        let d = tmpdir("cap");
        for i in 0..(MAX_STATE_FILES + 6) {
            decide_in(&ev("PostToolUse", json!({"session_id": format!("sess-{i}")})), &d, Some(true));
        }
        let n = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("loop-")).count();
        assert!(n <= MAX_STATE_FILES, "got {n}");
    }
}
