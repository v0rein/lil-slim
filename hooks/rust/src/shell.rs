//! readonly-shell-guard: deny write-capable shell commands for the read-only
//! auditors. A seatbelt against accidents, not a sandbox. Mirrors
//! hooks/scripts/readonly-shell-guard.mjs; the `regex` crate has no
//! lookaround or backreferences, so those parts are hand-written scanners.

use crate::common::{agent_name, deny, is_plugin_agent, str_of};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

pub const READONLY_SHELL_AGENTS: [&str; 3] = ["arbiter", "hunter", "proctor"];

const GIT_READ: [&str; 19] = [
    "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep", "cat-file", "ls-tree", "describe", "shortlog", "rev-list", "show-ref", "merge-base", "diff-tree", "for-each-ref", "name-rev", "version",
];
const ALWAYS_WRITE: [&str; 21] = [
    "rm", "rmdir", "mv", "cp", "touch", "mkdir", "chmod", "chown", "ln", "tee", "dd", "truncate", "install", "patch", "wget", "apt", "apt-get", "brew", "choco", "winget", "sudo",
];
const TMP_OK: [&str; 7] = ["rm", "rmdir", "mv", "cp", "touch", "mkdir", "tee"];

fn re(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).expect("static regex"))
}

fn pkg_write() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^(install|i|add|remove|rm|uninstall|update|upgrade|ci|link|publish|unlink|dedupe)$")
}
fn code_writes() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r#"writeFile|appendFile|unlink|rmSync|\brm\(|rename|mkdir|copyFile|truncate|createWriteStream|child_process|execSync|\bspawn|\bexec\(|\.write\(|open\([^)]*['"][wax+]|os\.(remove|system|unlink)|shutil|subprocess"#)
}
fn env_assign() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^[A-Za-z_][A-Za-z0-9_]*=")
}
fn tmp_var() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^\$\{?(TMP|TEMP|TMPDIR)\}?(/|$)")
}
fn sed_inplace() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^-[a-zA-Z]*i")
}
fn curl_out() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^(-o|-O|--output|--remote-name|-T|--upload-file)$")
}
fn find_write() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^-(delete|fprint|fprintf|fls)$")
}
fn find_exec() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^-(exec|execdir|ok|okdir)$")
}
fn branch_ro() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^(-a|-r|-v|-vv|--list|--all|--show-current|--contains)$")
}
fn config_ro() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^--(get|list|get-all)$")
}
fn redirect() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"(?:\d|&)?>>?\s*([^\s;&|)]+)")
}
fn drive_prefix() -> &'static Regex {
    static C: OnceLock<Regex> = OnceLock::new();
    re(&C, r"^([A-Za-z]):(/.*)$")
}

fn tmp_prefixes(tmp: &str) -> Vec<String> {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let mut out: Vec<String> = vec!["/tmp".to_string(), norm(tmp), norm(&std::env::temp_dir().to_string_lossy())];
    let extra: Vec<String> = out
        .iter()
        .filter_map(|p| drive_prefix().captures(p).map(|m| format!("/{}{}", m[1].to_lowercase(), &m[2])))
        .collect();
    out.extend(extra);
    out.retain(|p| !p.is_empty());
    out.dedup();
    out
}

fn is_tmp(target: &str, prefixes: &[String]) -> bool {
    let t = target.replace('\\', "/");
    if t.contains("..") {
        return false;
    }
    if tmp_var().is_match(&t) {
        return true;
    }
    prefixes.iter().any(|p| t == *p || t.starts_with(&format!("{p}/")))
}

/// Replace every "..." (with \-escapes) and '...' span by `Q`, like MASK.
fn mask(cmd: &str) -> String {
    let c: Vec<char> = cmd.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        let q = c[i];
        if q == '"' || q == '\'' {
            let mut j = i + 1;
            let mut closed = false;
            while j < c.len() {
                if q == '"' && c[j] == '\\' && j + 1 < c.len() {
                    j += 2;
                    continue;
                }
                if c[j] == q {
                    closed = true;
                    break;
                }
                j += 1;
            }
            if closed {
                out.push('Q');
                i = j + 1;
                continue;
            }
        }
        out.push(q);
        i += 1;
    }
    out
}

/// Split on `&&`, `||`, `|`, `;`, newline, and a lone `&` that is not part of
/// `>&`, `&&`, `&>`-style redirects (the Node SPLIT regex with lookarounds).
fn split_segments(s: &str) -> Vec<String> {
    let c: Vec<char> = s.chars().collect();
    let mut segs = vec![String::new()];
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        let next = c.get(i + 1).copied();
        let prev = if i > 0 { Some(c[i - 1]) } else { None };
        let cut = match ch {
            '&' if next == Some('&') => {
                i += 1;
                true
            }
            '|' if next == Some('|') => {
                i += 1;
                true
            }
            '|' | ';' | '\n' => true,
            '&' => {
                let lookbehind_ok = !matches!(prev, Some('>') | Some('&'));
                let lookahead_ok = !matches!(next, Some('>') | Some('&') | Some('0'..='9'));
                lookbehind_ok && lookahead_ok
            }
            _ => false,
        };
        if cut {
            segs.push(String::new());
        } else {
            segs.last_mut().unwrap().push(ch);
        }
        i += 1;
    }
    segs
}

fn basename(p: &str) -> &str {
    p.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(p)
}

fn segment_reason(seg: &str, prefixes: &[String]) -> Option<String> {
    let mut tokens: Vec<&str> = seg.split_whitespace().collect();
    while let Some(t) = tokens.first() {
        let wrapper = matches!(*t, "command" | "time" | "env" | "nohup" | "exec");
        if env_assign().is_match(t) || wrapper {
            tokens.remove(0);
        } else {
            break;
        }
    }
    let first = *tokens.first()?;
    let mut cmd = basename(first).to_string();
    if cmd.to_lowercase().ends_with(".exe") {
        cmd.truncate(cmd.len() - 4);
    }
    let args: Vec<&str> = tokens[1..].to_vec();
    let plain: Vec<&str> = args.iter().copied().filter(|t| !t.starts_with('-')).collect();

    match cmd.as_str() {
        "git" => {
            let sub = *plain.first()?;
            if GIT_READ.contains(&sub) {
                return None;
            }
            if sub == "branch" && args.iter().all(|t| branch_ro().is_match(t) || *t == "branch") {
                return None;
            }
            if sub == "remote" && (args.contains(&"-v") || plain.len() == 1) {
                return None;
            }
            if (sub == "stash" || sub == "worktree") && plain.get(1) == Some(&"list") {
                return None;
            }
            if sub == "config" && args.iter().any(|t| config_ro().is_match(t) || *t == "-l") {
                return None;
            }
            return Some(format!("git {sub} changes repository state"));
        }
        "sed" if args.iter().any(|t| sed_inplace().is_match(t) || t.starts_with("--in-place")) => return Some("sed -i edits files in place".into()),
        "perl" if args.iter().any(|t| sed_inplace().is_match(t)) => return Some("perl -i edits files in place".into()),
        "curl" if args.iter().any(|t| curl_out().is_match(t)) => return Some("curl writes a file".into()),
        "npm" | "pnpm" | "yarn" | "bun" if pkg_write().is_match(plain.first().copied().unwrap_or("")) => {
            return Some(format!("{cmd} {} changes dependencies", plain[0]))
        }
        "pip" | "pip3" | "gem" | "cargo" | "go" if matches!(plain.first().copied().unwrap_or(""), "install" | "uninstall" | "add" | "remove" | "get") => {
            return Some(format!("{cmd} {} changes the environment", plain[0]))
        }
        "find" => {
            if args.iter().any(|t| find_write().is_match(t)) {
                return Some("find writes or deletes".into());
            }
            if let Some(i) = args.iter().position(|t| find_exec().is_match(t)) {
                return segment_reason(&args[i + 1..].join(" "), prefixes);
            }
            return None;
        }
        "xargs" => return segment_reason(&plain.join(" "), prefixes),
        "eval" | "source" | "." => return Some("eval/source runs uninspectable code".into()),
        _ => {}
    }
    if ALWAYS_WRITE.contains(&cmd.as_str()) {
        if TMP_OK.contains(&cmd.as_str()) && !plain.is_empty() && plain.iter().all(|p| is_tmp(p, prefixes)) {
            return None;
        }
        return Some(format!("{cmd} modifies the filesystem"));
    }
    None
}

/// Find `<intro> (["'])BODY\1` spans: returns each BODY. `intro` is matched
/// first, then the quote char, then the body up to the same quote (lazy).
fn quoted_after(cmd: &str, intro: &Regex) -> Vec<String> {
    let mut found = Vec::new();
    for m in intro.find_iter(cmd) {
        let rest = &cmd[m.end()..];
        let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        let body = &rest[1..];
        if let Some(end) = body.find(q) {
            found.push(body[..end].to_string());
        }
    }
    found
}

/// Bodies of `$( ... )` (no nested parens) and `` `...` ``.
fn substitutions(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let c: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '$' && c.get(i + 1) == Some(&'(') {
            let mut j = i + 2;
            while j < c.len() && c[j] != ')' && c[j] != '(' {
                j += 1;
            }
            if j < c.len() && c[j] == ')' {
                out.push(c[i + 2..j].iter().collect());
                i = j;
            }
        } else if c[i] == '`' {
            if let Some(off) = c[i + 1..].iter().position(|x| *x == '`') {
                out.push(c[i + 1..i + 1 + off].iter().collect());
                i += off + 1;
            }
        }
        i += 1;
    }
    out
}

pub fn classify(command: &str, tmp: &str) -> Option<String> {
    if command.trim().is_empty() {
        return None;
    }
    let prefixes = tmp_prefixes(tmp);

    static SH: OnceLock<Regex> = OnceLock::new();
    static EV: OnceLock<Regex> = OnceLock::new();
    static INTERP: OnceLock<Regex> = OnceLock::new();
    let sh = re(&SH, r"\b(?:ba|z)?sh\s+-c\s+");
    let ev = re(&EV, r"\beval\s+");
    let interp = re(&INTERP, r"\b(?:node|nodejs|python3?|perl|ruby)\s+(?:-e|-c|-p|--eval|--print)\s+");

    for body in quoted_after(command, sh).into_iter().chain(quoted_after(command, ev)) {
        if let Some(r) = classify(&body, tmp) {
            return Some(r);
        }
    }
    for body in quoted_after(command, interp) {
        if code_writes().is_match(&body) {
            return Some("inline code writes files or spawns processes".into());
        }
    }
    for body in substitutions(command) {
        if let Some(r) = classify(&body, tmp) {
            return Some(r);
        }
    }

    let masked = mask(command);
    for m in redirect().captures_iter(&masked) {
        let target = &m[1];
        if target.starts_with('&') || target == "/dev/null" || target == "NUL" || is_tmp(target, &prefixes) {
            continue;
        }
        return Some(format!("redirect to {target} writes a file"));
    }
    for seg in split_segments(&masked) {
        if let Some(r) = segment_reason(&seg, &prefixes) {
            return Some(r);
        }
    }
    None
}

pub fn decide(input: &Value) -> Option<Value> {
    if str_of(input, "tool_name") != "Bash" || !is_plugin_agent(input) {
        return None;
    }
    let agent = agent_name(input)?;
    if !READONLY_SHELL_AGENTS.contains(&agent.as_str()) {
        return None;
    }
    let command = input.get("tool_input")?.get("command")?.as_str()?;
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    let reason = classify(command, &tmp)?;
    Some(deny(&format!(
        "{agent} is read-only: {reason}. Run only inspection or test commands, and report what should change instead of changing it."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(c: &str) -> bool {
        classify(c, "/tmp").is_some()
    }

    #[test]
    fn writes_are_denied() {
        for c in [
            "rm -rf src", "rm src/a.js", "git commit -am x", "git checkout -- .", "git reset --hard HEAD",
            "git stash", "git apply fix.diff", "git push origin main", "git clean -fd",
            "sed -i s/a/b/ src/a.js", "sed --in-place s/a/b/ src/a.js", "echo hi > src/x.js",
            "cat a >> README.md", "cat a | tee out.txt", "mv a b", "cp a b", "touch f", "mkdir out",
            "chmod +x run.sh", "npm install left-pad", "pnpm add zod", "pip install requests",
            "node -e \"require('fs').writeFileSync('a','b')\"", "python -c \"open('a','w').write('x')\"",
            "bash -c \"rm -rf x\"", "find . -name x -delete", "find . -name x -exec rm {} ;",
            "grep -l x . | xargs rm", "ls && rm x", "ls; git push", "curl -o out.sh http://x", "eval \"rm -rf x\"",
        ] {
            assert!(denied(c), "should deny: {c}");
        }
    }

    #[test]
    fn reads_are_allowed() {
        for c in [
            "git status --short", "git diff HEAD --stat", "git log --oneline | head -5", "git show HEAD:src/a.js",
            "cat -n src/a.js", "ls -R src test", "grep -rn \"rm -rf\" src", "grep -c \"a>b\" f", "echo \"a > b\"",
            "node --test 2>&1 | tail -30", "node --test > /dev/null 2>&1", "node --test > /tmp/run.log 2>&1",
            "git diff 2>/dev/null", "cd \"/w\" && git status", "node -e \"console.log(1+1)\"", "sed -n 1,5p f",
            "wc -l src/*.js", "mktemp -d", "rm -rf /tmp/scratch", "find . -name \"*.js\"", "find . -name x -exec grep -l y {} ;",
        ] {
            assert!(!denied(c), "should allow: {c}");
        }
    }

    #[test]
    fn tmp_prefix_depends_on_argument() {
        assert!(classify("rm -rf /var/scratch/x", "/var/scratch").is_none());
        assert!(classify("rm -rf /var/other/x", "/var/scratch").is_some());
    }

    #[test]
    fn split_keeps_redirect_ampersands() {
        assert_eq!(split_segments("a 2>&1 | b").len(), 2);
        assert_eq!(split_segments("a &> f").len(), 1);
        assert_eq!(split_segments("a & b").len(), 2);
        assert_eq!(split_segments("a && b || c").len(), 3);
    }

    #[test]
    fn empty_and_blank_are_none() {
        assert!(classify("", "/tmp").is_none());
        assert!(classify("   \n", "/tmp").is_none());
    }
}
