//! Lexical path operations mirroring Node's `path.posix` / `path.win32`
//! (isAbsolute, resolve). Pure string work, so both flavors are testable on
//! any OS. Windows drive-relative paths (`C:x`) are approximated.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavor {
    Posix,
    Win,
}

impl Flavor {
    pub fn native() -> Flavor {
        if cfg!(windows) {
            Flavor::Win
        } else {
            Flavor::Posix
        }
    }

    pub fn sep(self) -> char {
        match self {
            Flavor::Posix => '/',
            Flavor::Win => '\\',
        }
    }

    pub fn is_absolute(self, p: &str) -> bool {
        let b = p.as_bytes();
        match self {
            Flavor::Posix => b.first() == Some(&b'/'),
            Flavor::Win => {
                if b.is_empty() {
                    return false;
                }
                if b[0] == b'/' || b[0] == b'\\' {
                    return true;
                }
                b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
            }
        }
    }

    /// Lexical `path.resolve(base, p)`; `base` is expected to be absolute.
    pub fn resolve(self, base: &str, p: &str) -> String {
        match self {
            Flavor::Posix => {
                let full = if p.starts_with('/') { p.to_string() } else { format!("{base}/{p}") };
                let mut out: Vec<&str> = Vec::new();
                for seg in full.split('/') {
                    match seg {
                        "" | "." => {}
                        ".." => {
                            out.pop();
                        }
                        s => out.push(s),
                    }
                }
                format!("/{}", out.join("/"))
            }
            Flavor::Win => resolve_win(base, p),
        }
    }
}

/// (root, rest, has_drive_root). root is "X:\", "\\server\share\", "\", "X:" or "".
fn split_win(s: &str) -> (String, &str, bool) {
    let b = s.as_bytes();
    let is_sep = |c: u8| c == b'/' || c == b'\\';
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        if b.len() > 2 && is_sep(b[2]) {
            return (format!("{}:\\", s[..1].to_ascii_uppercase()), &s[3..], true);
        }
        return (format!("{}:", s[..1].to_ascii_uppercase()), &s[2..], false);
    }
    if b.len() >= 2 && is_sep(b[0]) && is_sep(b[1]) {
        let rest = &s[2..];
        let mut parts = rest.splitn(3, |c| c == '/' || c == '\\');
        let host = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        let tail = parts.next().unwrap_or("");
        return (format!("\\\\{host}\\{share}\\"), tail, true);
    }
    if !b.is_empty() && is_sep(b[0]) {
        return ("\\".to_string(), &s[1..], false);
    }
    (String::new(), s, false)
}

fn resolve_win(base: &str, p: &str) -> String {
    let (broot, brest, _) = split_win(base);
    let (proot, prest, pabs) = split_win(p);
    let (root, tail): (String, String) = if pabs {
        (proot, prest.to_string())
    } else if proot == "\\" {
        let drive = if broot.len() >= 2 && broot.as_bytes()[1] == b':' { broot[..2].to_string() } else { String::new() };
        (format!("{drive}\\"), prest.to_string())
    } else if proot.len() == 2 && proot.ends_with(':') {
        if broot.len() >= 2 && broot[..2].eq_ignore_ascii_case(&proot) {
            (broot.clone(), format!("{brest}\\{prest}"))
        } else {
            (format!("{proot}\\"), prest.to_string())
        }
    } else {
        (broot.clone(), format!("{brest}\\{p}"))
    };
    let mut out: Vec<&str> = Vec::new();
    for seg in tail.split(|c| c == '/' || c == '\\') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    format!("{root}{}", out.join("\\"))
}

#[cfg(test)]
mod tests {
    use super::Flavor::{Posix, Win};

    #[test]
    fn absolute_matches_node() {
        assert!(Posix.is_absolute("/a"));
        assert!(!Posix.is_absolute("a/b"));
        assert!(!Posix.is_absolute(""));
        assert!(Win.is_absolute("C:\\a"));
        assert!(Win.is_absolute("C:/a"));
        assert!(Win.is_absolute("\\a"));
        assert!(Win.is_absolute("//srv/share"));
        assert!(!Win.is_absolute("C:a"));
        assert!(!Win.is_absolute("a\\b"));
    }

    #[test]
    fn posix_resolve() {
        assert_eq!(Posix.resolve("/w/proj", "src"), "/w/proj/src");
        assert_eq!(Posix.resolve("/w/proj", "../x"), "/w/x");
        assert_eq!(Posix.resolve("/w/proj", "/abs/y"), "/abs/y");
        assert_eq!(Posix.resolve("/w/proj", ""), "/w/proj");
        assert_eq!(Posix.resolve("/w", "../../.."), "/");
    }

    #[test]
    fn win_resolve() {
        assert_eq!(Win.resolve("C:\\w\\proj", "src"), "C:\\w\\proj\\src");
        assert_eq!(Win.resolve("C:\\w\\proj", "C:/Users/proj/src/a.ts"), "C:\\Users\\proj\\src\\a.ts");
        assert_eq!(Win.resolve("C:\\w\\proj", "..\\x"), "C:\\w\\x");
        assert_eq!(Win.resolve("D:\\", "Projects/x"), "D:\\Projects\\x");
        assert_eq!(Win.resolve("C:\\w", "\\abs"), "C:\\abs");
        assert_eq!(Win.resolve("C:\\w", ""), "C:\\w");
        assert_eq!(Win.resolve("C:\\", ""), "C:\\");
        assert_eq!(Win.resolve("C:\\a", "d:\\x"), "D:\\x");
    }
}
