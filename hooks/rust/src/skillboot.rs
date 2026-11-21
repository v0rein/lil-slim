//! skill-bootstrap: inject the `lil-slim:using-lil-slim` skill at session
//! start, like the original plugin does. Mirrors hooks/scripts/skill-bootstrap.mjs.

use crate::common::{agent_name, context, plugin_root, str_of};
use serde_json::Value;
use std::path::Path;

/// The skill body without frontmatter, LF only; None if absent or empty.
pub fn load_skill(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join("skills").join("using-lil-slim").join("SKILL.md")).ok()?;
    let text = raw.replace('\r', "");
    let body = match text.strip_prefix("---\n") {
        Some(rest) => match rest.find("\n---\n") {
            Some(i) => &rest[i + 5..],
            None => text.as_str(),
        },
        None => text.as_str(),
    };
    let body = body.trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

fn is_off(v: Option<String>) -> bool {
    matches!(v.unwrap_or_default().to_lowercase().as_str(), "off" | "0" | "false" | "no")
}

pub fn render(body: &str) -> String {
    format!(
        "<EXTREMELY_IMPORTANT>\nYou have lil-slim skills.\n\n**Below is the full content of your 'lil-slim:using-lil-slim' skill. For all other skills, use the 'Skill' tool:**\n\n---\n{body}\n</EXTREMELY_IMPORTANT>"
    )
}

pub fn decide(input: &Value) -> Option<Value> {
    decide_in(input, &plugin_root(), std::env::var("LIL_SLIM_SKILLS").ok())
}

pub fn decide_in(input: &Value, root: &Path, switch: Option<String>) -> Option<Value> {
    if str_of(input, "hook_event_name") != "SessionStart" {
        return None;
    }
    if input.get("agent_type").is_some() && agent_name(input).as_deref() != Some("orchestrator") {
        return None;
    }
    if is_off(switch) {
        return None;
    }
    let body = load_skill(root)?;
    Some(context("SessionStart", &render(&body)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree(skill: Option<&str>) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lilboot-{}-{}", std::process::id(), skill.map_or(0, |s| s.len())));
        let _ = std::fs::remove_dir_all(&d);
        if let Some(s) = skill {
            std::fs::create_dir_all(d.join("skills").join("using-lil-slim")).unwrap();
            std::fs::write(d.join("skills").join("using-lil-slim").join("SKILL.md"), s).unwrap();
        } else {
            std::fs::create_dir_all(&d).unwrap();
        }
        d
    }
    fn start(agent: Option<&str>) -> Value {
        match agent {
            Some(a) => json!({"hook_event_name": "SessionStart", "agent_type": a}),
            None => json!({"hook_event_name": "SessionStart"}),
        }
    }

    #[test]
    fn injects_for_orchestrator_and_plain_sessions() {
        let d = tree(Some("---\nname: x\ndescription: y\n---\nBODY LINE\n"));
        let a = decide_in(&start(Some("lil-slim:orchestrator")), &d, None).unwrap();
        let text = a["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(text.starts_with("<EXTREMELY_IMPORTANT>\nYou have lil-slim skills."));
        assert!(text.contains("BODY LINE") && !text.contains("name: x"));
        assert!(text.ends_with("</EXTREMELY_IMPORTANT>"));
        assert!(decide_in(&start(None), &d, None).is_some());
    }

    #[test]
    fn nothing_for_others_or_when_off() {
        let d = tree(Some("---\nname: x\n---\nB\n"));
        for a in ["lil-slim:explorer", "other:orchestrator", "orchestrator"] {
            assert!(decide_in(&start(Some(a)), &d, None).is_none(), "{a}");
        }
        assert!(decide_in(&json!({"hook_event_name": "PreToolUse"}), &d, None).is_none());
        for v in ["off", "OFF", "0", "false", "no"] {
            assert!(decide_in(&start(None), &d, Some(v.into())).is_none(), "{v}");
        }
        assert!(decide_in(&start(None), &d, Some("on".into())).is_some());
    }

    #[test]
    fn missing_or_empty_skill_is_silent() {
        assert!(decide_in(&start(None), &tree(None), None).is_none());
        assert!(decide_in(&start(None), &tree(Some("---\nname: x\n---\n")), None).is_none());
    }

    #[test]
    fn crlf_skill_files_render_with_lf_only() {
        let d = tree(Some("---\r\nname: x\r\n---\r\nA\r\nB\r\n"));
        let a = decide_in(&start(None), &d, None).unwrap();
        assert!(!a["hookSpecificOutput"]["additionalContext"].as_str().unwrap().contains('\r'));
    }
}
