// Repeatable adaptation of the vendored workflow skills.
// usage: node hooks/rust/adapt-skills.mjs <skills-dir>
// Every rule must match at least once somewhere or the run fails, so an upstream
// change cannot silently leave unadapted text behind.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node adapt-skills.mjs <skills-dir>');
  process.exit(2);
}
const CORE = [
  'brainstorming', 'finishing-a-development-branch',
  'receiving-code-review', 'requesting-code-review', 'subagent-driven-development', 'systematic-debugging',
  'test-driven-development', 'verification-before-completion', 'writing-plans',
];
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const RUN = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/run.sh" sdd';
const SKILLS = CORE.join('|');

// [name, regex, replacement, appliesTo]  appliesTo: 'all' | 'skill' (SKILL.md only) | relative path
const rules = [
  ['cmd review-package (bash)', /`bash scripts\/review-package ([^`]*)`/g, (_, a) => `\`${RUN} review-package ${a}\``, 'skill'],
  ['cmd task-brief (bash)', /`bash scripts\/task-brief ([^`]*)`/g, (_, a) => `\`${RUN} task-brief ${a}\``, 'skill'],
  ['cmd workspace (bash)', /`bash scripts\/sdd-workspace ([^`]*)`/g, (_, a) => `\`${RUN} workspace ${a}\``, 'skill'],
  ['cmd workspace (relative)', /`\.\.\/subagent-driven-development\/scripts\/sdd-workspace ([^`]*)`/g, (_, a) => `\`${RUN} workspace ${a}\``, 'skill'],
  ['cmd review-package (relative)', /`\.\.\/subagent-driven-development\/scripts\/review-package ([^`]*)`/g, (_, a) => `\`${RUN} review-package ${a}\``, 'skill'],
  // companion files are read verbatim (no ${CLAUDE_PLUGIN_ROOT} substitution): name the command, don't spell a path
  ['companion review-package', /`bash scripts\/review-package ([^`]*)`/g, (_, a) => `the \`sdd review-package ${a}\` command from SKILL.md`, 'companion'],
  ['companion task-brief', /`bash scripts\/task-brief ([^`]*)`/g, (_, a) => `the \`sdd task-brief ${a}\` command from SKILL.md`, 'companion'],
  ['wording: absolute path A', /by its absolute path, from the working tree/g, 'from the working tree', 'all'],
  ['wording: absolute path B', /by its\s+absolute path, from the working tree/g, 'from the working tree', 'all'],
  ['wording: absolute path E', /by its absolute path,\s+from the working tree/g, 'from the working tree', 'all'],
  ['spec dir', /docs\/superpowers\/specs\//g, 'docs/lil-slim/specs/', 'all'],
  ['plan dir', /docs\/superpowers\/plans\//g, 'docs/lil-slim/plans/', 'all'],
  ['state dir', /\.superpowers\/sdd\b/g, '.lil-slim/sdd', 'all'],
  ['vendored skill names', new RegExp(`superpowers:(${SKILLS})`, 'g'), 'lil-slim:$1', 'all'],
  ['worktrees skill', /superpowers:using-git-worktrees/g, 'lil-slim:worktrees', 'all'],
  ['skill-writing guidance', /superpowers:writing-skills/g, 'the skill-writing guidance in your project', 'all'],
  ['platform references', /\s*\(see the per-platform references in\s+`\.\.\/using-superpowers\/references\/`\)/g, '', 'all'],
  ['worktree ownership wording', /Superpowers\s+created this worktree/g, 'lil-slim created this worktree', 'all'],
  // dispatch sites: each template's role decides the agent
  ['implementer agent', /Subagent \(general-purpose\):/g, 'Subagent (`lil-slim:fixer`):', 'subagent-driven-development/implementer-prompt.md'],
  ['task reviewer agent', /Subagent \(general-purpose\):/g, 'Subagent (`lil-slim:arbiter`):', 'subagent-driven-development/task-reviewer-prompt.md'],
  ['re-reviewer agent', /Subagent \(general-purpose\):/g, 'Subagent (`lil-slim:arbiter`):', 'subagent-driven-development/re-review-prompt.md'],
  ['code reviewer agent', /Subagent \(general-purpose\):/g, 'Subagent (`lil-slim:arbiter`):', 'requesting-code-review/code-reviewer.md'],
  ['code review dispatch', /`general-purpose` subagent/g, '`lil-slim:arbiter` subagent', 'requesting-code-review/SKILL.md'],
  ['builder check agent', /fresh general-purpose subagent/g, 'fresh `lil-slim:oracle` subagent', 'brainstorming/builder-check-prompt.md'],
];

const used = new Set();
let changed = 0;
for (const n of CORE) {
  for (const f of walk(path.join(dir, n))) {
    if (!f.endsWith('.md')) continue;
    const rel = path.relative(dir, f).split(path.sep).join('/');
    const isSkill = rel.endsWith('/SKILL.md');
    let s = readFileSync(f, 'utf8').replace(/\r/g, '');
    const before = s;
    // companions first, so the generic command rules (SKILL.md only) never see them
    rules.forEach(([name, re, to, scope], i) => {
      const applies = scope === 'all' || (scope === 'skill' && isSkill) || (scope === 'companion' && !isSkill) || scope === rel;
      if (!applies) return;
      re.lastIndex = 0;
      if (re.test(s)) {
        used.add(i);
        re.lastIndex = 0;
        s = s.replace(re, to);
      }
      re.lastIndex = 0;
    });
    if (s !== before) {
      writeFileSync(f, s);
      changed++;
    }
  }
}
const unused = rules.map((r, i) => [r[0], i]).filter(([, i]) => !used.has(i)).map(([n]) => n);
console.log(`adapted ${changed} files; rules that never matched: ${unused.length ? unused.join(' | ') : 'none'}`);
