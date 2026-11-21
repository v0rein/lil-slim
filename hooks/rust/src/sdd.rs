//! `lil-hook sdd <cmd>`: Rust port of the superpowers plan-execution helper
//! scripts (sdd-repo, sdd-workspace, task-brief, review-package, task-start,
//! task-done). Same arguments, output lines and exit codes as the bash
//! originals, so the skills read the same either way. State lives under
//! `<repo>/.lil-slim/sdd/<plan>/` (the originals use `.superpowers/sdd/`).
//!
//! Exit codes: 2 usage / bad input, 3 not found or bad range, 4 unclosed
//! fence. Unlike the hooks, these are user-visible commands: errors go to
//! stderr and the exit status is meaningful.

use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

pub const STATE_DIR: &str = ".lil-slim/sdd";

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Out {
    fn ok(s: impl Into<String>) -> Out {
        Out { code: 0, stdout: s.into(), stderr: String::new() }
    }
    fn fail(code: i32, msg: impl Into<String>) -> Out {
        Out { code, stdout: String::new(), stderr: msg.into() }
    }
}

/// `-C DIR` handling shared by the commands that accept it. Returns the
/// remaining args and the working directory to use.
fn take_dir(args: &[String]) -> Result<(Vec<String>, Option<PathBuf>), Out> {
    if args.first().map(String::as_str) == Some("-C") {
        let d = args.get(1).map(String::as_str).unwrap_or("");
        let p = PathBuf::from(d);
        if d.is_empty() || !p.is_dir() {
            return Err(Out::fail(2, format!("bad -C directory: {d}\n")));
        }
        // like `cd DIR`: every later relative path (plan file, OUTFILE) is relative to DIR
        if std::env::set_current_dir(&p).is_err() {
            return Err(Out::fail(2, format!("bad -C directory: {d}\n")));
        }
        return Ok((args[2..].to_vec(), Some(p)));
    }
    Ok((args.to_vec(), None))
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
}

fn git_ok(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn cwd(dir: &Option<PathBuf>) -> PathBuf {
    dir.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

/// Path with forward slashes and no `\\?\` prefix (what Git Bash's `cygpath -m` prints).
fn pretty(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    s.replace('\\', "/")
}

/// Physical absolute path, resolving symlinks, without the `\\?\` prefix.
fn physical(p: &Path) -> PathBuf {
    let c = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy().to_string();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s))
}

fn repo_root(dir: &Option<PathBuf>, with_commit: bool) -> Result<PathBuf, Out> {
    let here = cwd(dir);
    let top = git(&here, &["rev-parse", "--show-toplevel"]);
    let mut said = String::new();
    if let Some(root) = &top {
        let root = PathBuf::from(root);
        if !with_commit || git_ok(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]) {
            return Ok(root);
        }
        let o = Command::new("git").arg("-C").arg(&root).args(["rev-parse", "--verify", "HEAD"]).output().ok();
        if let Some(o) = o {
            said = String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("").to_string();
        }
    } else {
        let o = Command::new("git").arg("-C").arg(&here).args(["rev-parse", "--show-toplevel"]).output().ok();
        if let Some(o) = o {
            said = String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("").to_string();
        }
    }
    Err(Out::fail(
        2,
        format!(
            "SDD scripts must run from inside the git working tree you're executing in, with at least one commit (current directory: {}). If this is a new project, run 'git init' and make a first commit, then rerun.\ngit said: {said}\n",
            here.display()
        ),
    ))
}

pub fn repo(args: &[String]) -> Out {
    let with_commit = args.first().map(String::as_str) == Some("--with-commit");
    let rest = if with_commit { &args[1..] } else { args };
    if !rest.is_empty() {
        return Out::fail(2, "usage: sdd-repo [--with-commit]\n");
    }
    match repo_root(&None, with_commit) {
        Ok(r) => Out::ok(format!("{}\n", r.to_string_lossy())),
        Err(e) => e,
    }
}

/// Lexical normalization used for the plan-path marker (like `pwd -P` of the
/// plan's directory plus its file name).
fn plan_identity(plan: &Path, root: &Path) -> String {
    let parent = plan.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let dir = physical(parent);
    let abs = dir.join(plan.file_name().unwrap_or_default());
    let abs_s = pretty(&abs);
    let root_s = pretty(root);
    match abs_s.strip_prefix(&format!("{root_s}/")) {
        Some(rel) => rel.to_string(),
        None => abs_s,
    }
}

fn owns(dir: &Path, plan_id: &str) -> bool {
    let marker = dir.join("plan-path");
    if marker.exists() {
        return fs::read_to_string(&marker).map(|s| s.trim_end_matches(['\n', '\r']) == plan_id).unwrap_or(false);
    }
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    fs::write(&marker, format!("{plan_id}\n")).is_ok()
}

fn workspace_dir(dir: &Option<PathBuf>, plan: &str) -> Result<PathBuf, Out> {
    let plan_path = PathBuf::from(plan);
    if !plan_path.is_file() {
        return Err(Out::fail(2, format!("no such plan file: {plan}\n")));
    }
    let slug = plan_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if slug.is_empty() || slug == "." || slug == ".." {
        return Err(Out::fail(2, format!("cannot derive a workspace name from: {plan}\n")));
    }
    let top = repo_root(dir, false)?;
    let root = physical(&top);
    let base = root.join(STATE_DIR);
    let plan_id = plan_identity(&plan_path, &root);
    let parent_name = plan_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| physical(p))
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".into());

    let mut d = base.join(&slug);
    if !owns(&d, &plan_id) {
        d = base.join(format!("{slug}-{parent_name}"));
        if !owns(&d, &plan_id) {
            let mut n = 2;
            loop {
                d = base.join(format!("{slug}-{parent_name}-{n}"));
                if owns(&d, &plan_id) {
                    break;
                }
                n += 1;
            }
        }
    }
    let ignore = base.join(".gitignore");
    if !ignore.exists() {
        let _ = fs::write(&ignore, "*\n");
    }
    Ok(d)
}

pub fn workspace(args: &[String]) -> Out {
    let (rest, dir) = match take_dir(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if rest.len() != 1 {
        return Out::fail(2, "usage: sdd-workspace [-C DIR] PLAN_FILE\n");
    }
    match workspace_dir(&dir, &rest[0]) {
        Ok(d) => Out::ok(format!("{}\n", pretty(&d))),
        Err(e) => e,
    }
}

fn is_task_id(id: &str) -> Option<&str> {
    // letters/digits, optionally dot-separated, with at least one digit
    let b = id.as_bytes();
    let mut i = 0;
    loop {
        let start = i;
        while i < b.len() && b[i].is_ascii_alphanumeric() {
            i += 1;
        }
        if i == start {
            return None;
        }
        if i < b.len() && b[i] == b'.' && i + 1 < b.len() && b[i + 1].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        break;
    }
    let tok = &id[..i];
    if tok.bytes().any(|c| c.is_ascii_digit()) {
        Some(tok)
    } else {
        None
    }
}

/// Parse `#+<ws>Task<ws>ID...`; returns (heading level, ID).
fn task_heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if level == 0 {
        return None;
    }
    let rest = &line[level..];
    let rest2 = rest.trim_start_matches([' ', '\t']);
    if rest2.len() == rest.len() {
        return None;
    }
    let after = rest2.strip_prefix("Task")?;
    let id_part = after.trim_start_matches([' ', '\t']);
    if id_part.len() == after.len() {
        return None;
    }
    Some((level, is_task_id(id_part)?))
}

/// "shaped like a task" heading: `#+ WORD ID` with a digit in the ID (hint only).
fn shaped_heading(line: &str) -> bool {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if level == 0 {
        return false;
    }
    let rest = &line[level..];
    let r = rest.trim_start_matches([' ', '\t']);
    if r.len() == rest.len() {
        return false;
    }
    let mut it = r.splitn(2, [' ', '\t']);
    let word = it.next().unwrap_or("");
    let tail = it.next().unwrap_or("").trim_start_matches([' ', '\t']);
    if word.is_empty() {
        return false;
    }
    let id: String = tail.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    !id.is_empty() && id.bytes().any(|c| c.is_ascii_digit())
}

/// The text of a plan line as it goes into the brief. The original script uses
/// awk, which keeps a trailing CR on Linux and macOS but loses it on Windows
/// (Git Bash opens the file in text mode). Match each platform's original.
fn brief_line(raw: &str) -> &str {
    if cfg!(windows) {
        raw.strip_suffix('\r').unwrap_or(raw)
    } else {
        raw
    }
}

pub fn task_brief(args: &[String]) -> Out {
    let (rest, dir) = match take_dir(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if rest.len() < 2 || rest.len() > 3 {
        return Out::fail(2, "usage: task-brief [-C DIR] PLAN_FILE TASK_NUMBER [OUTFILE]\n");
    }
    let plan = &rest[0];
    let n = &rest[1];
    if !Path::new(plan).is_file() {
        return Out::fail(2, format!("no such plan file: {plan}\n"));
    }
    let out_path: PathBuf = if rest.len() == 3 {
        PathBuf::from(&rest[2])
    } else {
        match workspace_dir(&dir, plan) {
            Ok(d) => d.join(format!("task-{n}-brief.md")),
            Err(e) => return e,
        }
    };
    let text = match fs::read(plan) {
        Ok(b) => String::from_utf8_lossy(&b).to_string(),
        Err(e) => return Out::fail(2, format!("cannot read {plan}: {e}\n")),
    };

    let mut infence = false;
    let mut fence_line = 0usize;
    let mut hidden = false;
    let mut tasks = 0usize;
    let mut intask = false;
    let mut level = 0usize;
    let mut found = false;
    let mut shaped: Vec<String> = Vec::new();
    let mut brief = String::new();

    for (idx, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let ln = idx + 1;
        if line.starts_with("```") {
            infence = !infence;
            if infence {
                fence_line = ln;
                hidden = false;
            }
        }
        let th = task_heading(line);
        if infence && th.is_some() {
            hidden = true;
        }
        if !infence {
            if let Some((lv, id)) = th {
                tasks += 1;
                let sub = intask
                    && lv > level
                    && id.len() > n.len()
                    && id.starts_with(n.as_str())
                    && id.as_bytes()[n.len()].is_ascii_alphabetic() | (id.as_bytes()[n.len()] == b'.');
                if !sub {
                    intask = id == n.as_str();
                    level = lv;
                }
            }
            if shaped.len() < 5 && shaped_heading(line) {
                shaped.push(line.to_string());
            }
        }
        if intask {
            brief.push_str(brief_line(raw));
            brief.push('\n');
            found = true;
        }
    }
    // the final split piece after a trailing newline is empty; do not add a stray blank line
    if text.ends_with('\n') && brief.ends_with("\n\n") && intask {
        brief.pop();
    }

    let mut warn = String::new();
    let where_ = format!("the code fence opened at line {fence_line} of {plan} never closes");
    if infence && hidden && (intask || !found) {
        warn.push_str(&format!("task-brief: {where_}, so no Task heading after it can be seen; close that fence in the plan and rerun\n"));
        if intask {
            return Out::fail(4, warn);
        }
    } else if infence && intask {
        warn.push_str(&format!("task-brief: warning: {where_}; it hides no Task heading, so this brief is complete\n"));
    }
    if tasks == 0 && !shaped.is_empty() && !(infence && hidden) {
        warn.push_str("task-brief: no task headings found. Task headings must use the English word \"Task\" (\"### Task 1: ...\"), even when the rest of the plan is in another language. Headings shaped like tasks:\n");
        for h in &shaped {
            warn.push_str(&format!("  {h}\n"));
        }
    }
    // the original writes the (possibly empty) brief file before it checks that
    // the task exists, so an empty file is left behind on "not found"
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&out_path, &brief) {
        return Out::fail(2, format!("cannot write {}: {e}\n", out_path.display()));
    }
    if brief.is_empty() {
        let mut e = warn;
        e.push_str(&format!("task {n} not found in {plan} (no heading matching 'Task {n}')\n"));
        return Out::fail(3, e);
    }
    let lines = brief.matches('\n').count();
    Out { code: 0, stdout: format!("wrote {}: {lines} lines\n", out_path.display().to_string().replace('\\', "/")), stderr: warn }
}

pub fn review_package(args: &[String]) -> Out {
    let (rest, dir) = match take_dir(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if rest.len() < 3 || rest.len() > 4 {
        return Out::fail(2, "usage: review-package [-C DIR] PLAN_FILE BASE HEAD [OUTFILE]\n");
    }
    let (plan, base, head) = (&rest[0], &rest[1], &rest[2]);
    if !Path::new(plan).is_file() {
        return Out::fail(2, format!("no such plan file: {plan}\n"));
    }
    let repo = match repo_root(&dir, true) {
        Ok(r) => r,
        Err(e) => return e,
    };
    if !git_ok(&repo, &["rev-parse", "--verify", "--quiet", base]) {
        return Out::fail(2, format!("bad BASE: {base}\n"));
    }
    if !git_ok(&repo, &["rev-parse", "--verify", "--quiet", head]) {
        return Out::fail(2, format!("bad HEAD: {head}\n"));
    }
    if !git_ok(&repo, &["merge-base", "--is-ancestor", base, head]) {
        return Out::fail(3, format!("HEAD is not a descendant of BASE: {base}..{head}\n"));
    }
    let range = format!("{base}..{head}");
    let count: u64 = git(&repo, &["rev-list", "--count", &range]).and_then(|s| s.parse().ok()).unwrap_or(0);
    if count == 0 {
        return Out::fail(3, format!("empty commit range: {range}\n"));
    }
    let out_path: PathBuf = if rest.len() == 4 {
        PathBuf::from(&rest[3])
    } else {
        let d = match workspace_dir(&dir, plan) {
            Ok(d) => d,
            Err(e) => return e,
        };
        let b7 = git(&repo, &["rev-parse", "--short", base]).unwrap_or_default();
        let h7 = git(&repo, &["rev-parse", "--short", head]).unwrap_or_default();
        d.join(format!("review-{b7}..{h7}.diff"))
    };
    let log = git(&repo, &["log", "--oneline", &range]).unwrap_or_default();
    let stat = git(&repo, &["diff", "--stat", &range]).unwrap_or_default();
    let diff = Command::new("git").arg("-C").arg(&repo).args(["diff", "-U10", &range]).output().map(|o| o.stdout).unwrap_or_default();
    let mut body: Vec<u8> = Vec::new();
    let _ = write!(body, "# Review package: {base}..{head}\n\n## Commits\n{log}\n\n## Files changed\n{stat}\n\n## Diff\n");
    body.extend_from_slice(&diff);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&out_path, &body) {
        return Out::fail(2, format!("cannot write {}: {e}\n", out_path.display()));
    }
    Out::ok(format!("wrote {}: {count} commit(s), {} bytes\n", out_path.display().to_string().replace('\\', "/"), body.len()))
}

pub fn task_start(args: &[String]) -> Out {
    if args.len() != 2 {
        return Out::fail(2, "usage: task-start PLAN_FILE TASK_NUMBER\n");
    }
    let repo = match repo_root(&None, true) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let b = task_brief(args);
    if b.code != 0 {
        return b;
    }
    let Some(path) = b.stdout.strip_prefix("wrote ").and_then(|s| s.rsplit_once(": ")).map(|(p, _)| p.to_string()) else {
        return Out::fail(1, format!("task-brief did not report a path: {}\n", b.stdout.trim()));
    };
    let base = git(&repo, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default();
    Out { code: 0, stdout: format!("brief: {path}\nbase: {base}\n"), stderr: b.stderr }
}

fn render_cmd(argv: &[String]) -> String {
    argv.iter()
        .map(|a| if a.chars().any(|c| c.is_whitespace() || matches!(c, '"' | ';' | '|' | '&')) { format!("'{a}'") } else { a.clone() })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn task_done(args: &[String]) -> Out {
    if args.len() < 5 || args[3] != "--" {
        return Out::fail(2, "usage: task-done PLAN_FILE TASK_NUMBER BASE -- TEST_COMMAND [ARGS...]\n");
    }
    let (plan, n, base) = (&args[0], &args[1], &args[2]);
    let argv = &args[4..];
    let repo = match repo_root(&None, true) {
        Ok(r) => r,
        Err(e) => return e,
    };
    if !git_ok(&repo, &["rev-parse", "--verify", "--quiet", base]) {
        return Out::fail(2, format!("bad BASE: {base}\n"));
    }
    let dir = match workspace_dir(&None, plan) {
        Ok(d) => d,
        Err(e) => return e,
    };
    let log = dir.join(format!("task-{n}-tests.log"));
    let ledger = dir.join("progress.md");
    let cmd = render_cmd(argv);

    let output = Command::new(&argv[0]).args(&argv[1..]).output();
    let (rc, bytes) = match output {
        Ok(o) => {
            let mut b = o.stdout;
            b.extend_from_slice(&o.stderr);
            (o.status.code().unwrap_or(1), b)
        }
        Err(e) => (127, format!("{e}\n").into_bytes()),
    };
    let _ = fs::write(&log, &bytes);
    let text = String::from_utf8_lossy(&bytes).to_string();
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(5)..].join("\n");
    let mut stdout = if tail.is_empty() { String::new() } else { format!("{tail}\n") };
    if rc != 0 {
        return Out {
            code: rc,
            stdout,
            stderr: format!("task-done: test command exited {rc}; Task {n} NOT recorded (full output: {})\n", pretty(&log)),
        };
    }
    let last = lines.iter().rev().find(|l| !l.trim().is_empty()).copied().unwrap_or("(no output)");
    if !ledger.exists() {
        let _ = fs::write(&ledger, format!("# SDD ledger — plan: {plan}\n"));
    }
    let b7 = git(&repo, &["rev-parse", "--short=7", base]).unwrap_or_default();
    let h7 = git(&repo, &["rev-parse", "--short=7", "HEAD"]).unwrap_or_default();
    let line = format!("Task {n}: complete (commits {b7}..{h7}, tests: {cmd} → {last})");
    if let Ok(mut f) = fs::OpenOptions::new().append(true).create(true).open(&ledger) {
        let _ = writeln!(f, "{line}");
    }
    stdout.push_str(&format!("ledger: {line}\n"));
    Out::ok(stdout)
}

pub fn run(args: &[String]) -> Out {
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    match sub {
        "repo" => repo(rest),
        "workspace" => workspace(rest),
        "task-brief" => task_brief(rest),
        "review-package" => review_package(rest),
        "task-start" => task_start(rest),
        "task-done" => task_done(rest),
        _ => Out::fail(2, "usage: lil-hook sdd <repo|workspace|task-brief|review-package|task-start|task-done> ...\n"),
    }
}

#[allow(dead_code)]
fn _unused(_: Component) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids() {
        assert_eq!(is_task_id("3: x"), Some("3"));
        assert_eq!(is_task_id("6b"), Some("6b"));
        assert_eq!(is_task_id("A1"), Some("A1"));
        assert_eq!(is_task_id("2.1 foo"), Some("2.1"));
        assert_eq!(is_task_id("Overview"), None);
        assert_eq!(is_task_id("notes"), None);
        assert_eq!(is_task_id(""), None);
    }

    #[test]
    fn headings() {
        assert_eq!(task_heading("### Task 4: Foo"), Some((3, "4")));
        assert_eq!(task_heading("## Task 6b"), Some((2, "6b")));
        assert_eq!(task_heading("## Task Overview"), None);
        assert_eq!(task_heading("Task 1"), None);
        assert_eq!(task_heading("##Task 1"), None);
        assert_eq!(task_heading("#### Task 7a"), Some((4, "7a")));
    }

    #[test]
    fn brief_lines_follow_each_platforms_awk() {
        if cfg!(windows) {
            assert_eq!(brief_line("a\r"), "a");
        } else {
            assert_eq!(brief_line("a\r"), "a\r");
        }
        assert_eq!(brief_line("a"), "a");
    }

    #[test]
    fn shaped() {
        assert!(shaped_heading("## Tarea 1"));
        assert!(!shaped_heading("## Overview"));
        assert!(!shaped_heading("text"));
    }
}
