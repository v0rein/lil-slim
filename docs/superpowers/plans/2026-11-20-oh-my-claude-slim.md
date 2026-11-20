# oh-my-claude-slim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin Claude Code ringan yang membawa workflow oh-my-opencode-slim (orchestrator + 5 spesialis + skill + 4 guard hook), modular: agen/hook baru = file baru.

**Architecture:** Markdown + JSON + skrip Node `.mjs` tanpa dependensi. Tiap hook = satu modul yang mengekspor `decide(input, deps)` murni, dibungkus `runHook` dari `lib/hook-io.mjs` (parse stdin, gagal-aman, cetak JSON). Agen = satu `.md` per agen.

**Tech Stack:** Node 26 (`node --test`, `node:assert/strict`), tanpa npm. Tidak ada `package.json`.

**Spec:** `docs/design.md` (disetujui). Sumber prompt/logika: repo `oh-my-opencode-slim` (`src/agents/role-prompts.ts`, `src/agents/orchestrator.ts`, `src/config/constants.ts`, `src/hooks/{search-path-guard,absolute-path-rescue,tool-loop-guard}/`, `src/skills/`).

## Global Constraints

- Nama plugin `oh-my-claude-slim` (awalan `claude-`/`anthropic-` dicadangkan).
- `hooks/hooks.json` berbungkus `{"hooks": {...}}`; command `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<x>.mjs"`.
- Frontmatter agen: `permissionMode`, `hooks`, `mcpServers`, `initialPrompt` diabaikan di plugin; `name` tanpa `:`.
- Hook: keluar 0 tanpa keluaran pada error/stdin aneh; tidak pernah memblokir karena bug sendiri.
- Tiga guard hanya bertindak bila `agent_type` (awalan `oh-my-claude-slim:` dibuang) = nama file di `agents/`. phase-reminder hanya untuk `orchestrator`.
- State hook di `${CLAUDE_PLUGIN_DATA}` (fallback `os.tmpdir()/oh-my-claude-slim`), dibatasi.
- Tanpa bash; tes tidak memakai timer/`sleep`.
- Teks model-facing (prompt, skill) tidak boleh menyebut `task_status`, `task_cancel`, `task_reply`, `apply_patch`, `wait_for_user`, `OpenCode`, `@explorer`/`@fixer`/`@oracle`/`@designer`/`@observer`.
- Jalankan semua tes: `node --test test/` dari root plugin.
- Tidak ada commit kecuali pengguna meminta.

## Review Focus

- Path Windows: `C:/x/y` (slash maju, huruf drive) di rescue dan guard.
- stdin kosong, bukan JSON, atau `tool_input` bukan objek: tidak ada keluaran, exit 0.
- Argumen path hilang, bukan string, kosong, atau literal `"undefined"`/`"null"` (Glob): tidak ada keputusan.
- Dua PostToolUse paralel menulis state bersamaan, atau file state rusak: state di-reset, tidak crash.
- Sesi tanpa `agent_type` (claude biasa) atau agen plugin lain: semua guard diam.

---

### Task 1: Scaffold + `lib/hook-io.mjs`

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json` (isi `{"hooks":{}}`), `hooks/scripts/lib/hook-io.mjs`
- Test: `test/hook-io.test.mjs`

**Interfaces:**
- Produces (`hooks/scripts/lib/hook-io.mjs`):
  - `parseInput(text: string): object | null` — JSON objek, selain itu `null`.
  - `agentName(input: object): string | null` — `agent_type` string, bagian setelah `:` terakhir; `null` bila hilang/bukan string.
  - `isPluginAgent(input: object, agentsDir?: string): boolean` — `agentName` cocok `/^[a-z0-9-]+$/` dan `<agentsDir>/<nama>.md` ada. Default `agentsDir` = `../../../agents` relatif modul.
  - `denyOutput(reason: string): object` → `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}`.
  - `contextOutput(event: 'SessionStart'|'PostToolUse', text: string): object` → `{hookSpecificOutput:{hookEventName:event,additionalContext:text}}`.
  - `stateDir(env?: NodeJS.ProcessEnv): string` — `env.CLAUDE_PLUGIN_DATA` atau `os.tmpdir()/oh-my-claude-slim`.
  - `runHook(decide: (input: object) => object | null | Promise<object | null>): Promise<void>` — baca stdin, `parseInput`, panggil `decide`, cetak `JSON.stringify(hasil)` bila bukan `null`; tangkap semua error dan keluar 0 senyap.
  - `isMain(metaUrl: string): boolean` — `import.meta.url` sama dengan `process.argv[1]`.

- [ ] **Step 1: Tes gagal** — `test/hook-io.test.mjs`:
  - `parseInput('')`, `parseInput('nope')`, `parseInput('[1]')`, `parseInput('"x"')` → `null`; `parseInput('{"a":1}')` → `{a:1}`.
  - `agentName({agent_type:'oh-my-claude-slim:explorer'})` → `'explorer'`; `{agent_type:'explorer'}` → `'explorer'`; `{}` dan `{agent_type:5}` → `null`.
  - `isPluginAgent` dengan `agentsDir` = dir temp berisi `explorer.md`: `explorer` true; `ghost` false; `../x` false; tanpa `agent_type` false.
  - `stateDir({CLAUDE_PLUGIN_DATA:'/d'})` → `'/d'`.
- [ ] **Step 2:** `node --test test/hook-io.test.mjs` → FAIL (modul tidak ada).
- [ ] **Step 3:** Tulis `hook-io.mjs` per antarmuka. `runHook` membaca `process.stdin` sampai selesai (`for await`).
- [ ] **Step 4:** Tulis `.claude-plugin/plugin.json` (`name`, `version: "0.1.0"`, `description`, `license: "MIT"`) dan `hooks/hooks.json`. Tes e2e di file yang sama: jalankan `node -e` kecil yang memakai `runHook` dengan stdin `garbage` → exit 0, stdout kosong.
- [ ] **Step 5:** `node --test test/hook-io.test.mjs` → PASS.

### Task 2: absolute-path-rescue

**Files:**
- Create: `hooks/scripts/absolute-path-rescue.mjs`
- Test: `test/absolute-path-rescue.test.mjs`

**Interfaces:**
- Consumes: `isPluginAgent`, `runHook`, `isMain` (Task 1).
- Produces:
  - `findRescuedSuffix(raw: string, workspace: string, pathOps?: Pick<typeof path,'isAbsolute'|'join'|'resolve'|'sep'>, exists?: (p: string) => boolean): string | null` — port persis dari `findRescuedSuffix` repo asal (anchor = sufiks workspace terpanjang, tepat satu kemunculan, ekor penuh harus ada, `..`/`.` mematikan rescue, path di bawah workspace → `null`).
  - `decide(input: object, deps?: {exists?: (p: string) => boolean, isMissing?: (p: string) => boolean, pathOps?: object, agentsDir?: string}): object | null`.

Perilaku `decide`: hanya `tool_name` ∈ `Read` (kunci `file_path`), `Grep`/`Glob` (kunci `path`); `isPluginAgent` benar; nilai string absolut, kosong tidak; hanya ENOENT yang memicu (`isMissing`); workspace = `input.cwd`. Hasil: `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...tool_input, [kunci]: dirujuk}}}` (objek input LENGKAP, bukan hanya kunci yang diubah). Selain itu `null`.

- [ ] **Step 1: Tes gagal** (pakai `path.posix` dan `path.win32` injeksi; `exists` fake):
  - workspace `/home/u/Work/Parent/Child/Project`, tebakan `/home/u/Work/Project/src/a.ts`, `exists` benar untuk `/home/u/Work/Parent/Child/Project/src/a.ts` → hasil kunci diganti ke path itu.
  - Tebakan di bawah workspace → `null`. Ekor tidak ada → `null`. Dua kemunculan anchor → `null`. `..` di tebakan → `null`.
  - win32: workspace `C:\Users\u\proj`, tebakan `C:/Users/proj/src/a.ts` (slash maju) dengan ekor ada → dirujuk ke `C:\Users\u\proj\src\a.ts`.
  - `decide` dengan `Read` + `file_path` memicu; `updatedInput` mempertahankan kunci lain (`offset`, `limit`); `Edit` → `null`; tanpa `agent_type` → `null`; path relatif → `null`; error stat selain ENOENT (`isMissing` false) → `null`.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Port `findRescuedSuffix`; tulis `decide`; di bawah: `if (isMain(import.meta.url)) await runHook(decide)`. `isMissing` default: `statSync` melempar `ENOENT`.
- [ ] **Step 4:** Tambah entri `PreToolUse` matcher `Read|Grep|Glob` ke `hooks/hooks.json`. Tes e2e: `spawnSync('node',[script],{input: JSON})` dengan tebakan nyata di dir temp → stdout JSON ber-`updatedInput`.
- [ ] **Step 5:** `node --test test/absolute-path-rescue.test.mjs` → PASS.

### Task 3: search-path-guard

**Files:**
- Create: `hooks/scripts/search-path-guard.mjs`
- Modify: `hooks/hooks.json`
- Test: `test/search-path-guard.test.mjs`

**Interfaces:**
- Consumes: `isPluginAgent`, `denyOutput`, `runHook`, `isMain` (Task 1); `findRescuedSuffix` (Task 2).
- Produces:
  - `resolveSearchPath(cwd: string | undefined, raw: string, pathOps?): string | null` — port dari repo asal (`~`, absolut, relatif terhadap `cwd`).
  - `decide(input: object, deps?: {stat?: (p: string) => void, exists?, pathOps?, agentsDir?}): object | null` — `stat` melempar error ber-`code`.

Perilaku: `tool_name` `Grep`/`Glob`, `isPluginAgent`; `tool_input.path` harus string tak kosong (Glob: bukan `"undefined"`/`"null"`). ENOENT → deny `Search path does not exist: <resolved> (from "<raw>"). The <tool> search was blocked before it ran. Verify the target path, or list its parent directory to find the correct location.`; ENOTDIR → deny `Search path is invalid: <resolved> (from "<raw>"). A path component is not a directory (ENOTDIR), so the <tool> search was blocked before it ran. Verify the target path and that every parent component is a directory.`; error lain → `null`. **Pengecualian wajib:** bila path absolut yang ENOENT bisa diselamatkan `findRescuedSuffix` (hook rescue berjalan paralel dan mengganti inputnya), guard mengembalikan `null` supaya tidak membatalkan rescue.

- [ ] **Step 1: Tes gagal:** ENOENT → deny berisi `does not exist`; ENOTDIR → deny berisi `ENOTDIR`; EACCES → `null`; path ada → `null`; `Read` → `null`; tanpa `agent_type` → `null`; `path` hilang / `''` / angka → `null`; Glob `path:'undefined'` → `null`; tebakan yang bisa di-rescue (exists benar untuk kandidat) → `null`; `~/x` di-resolve ke home.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implement per antarmuka; `stat` default `statSync`.
- [ ] **Step 4:** Entri `PreToolUse` matcher `Grep|Glob`. Tes e2e spawn: path tidak ada → stdout berisi `"permissionDecision":"deny"`.
- [ ] **Step 5:** PASS.

### Task 4: tool-loop-guard

**Files:**
- Create: `hooks/scripts/tool-loop-guard.mjs`
- Modify: `hooks/hooks.json`
- Test: `test/tool-loop-guard.test.mjs`

**Interfaces:**
- Consumes: Task 1 helper, `stateDir`.
- Produces:
  - `fingerprint(tool: string, args: unknown): string` — hash sha1 dari `tool` + JSON stabil (kunci diurutkan rekursif).
  - `WARN_AT = 3`, `BLOCK_AT = 5`, `BLOCK_TOOLS = new Set(['Read','Grep','Glob'])`, `EXEMPT = new Set(['Task','Agent'])`, `MAX_STATE_FILES = 64`.
  - `decide(input: object, deps?: {dir?: string, agentsDir?: string}): object | null` — menangani `hook_event_name` `PreToolUse` dan `PostToolUse`.

Perilaku: state per `session_id` + `agent_id` (atau `main`) di `<dir>/loop-<sha1>.json` berisi `{fp, out, runs}`. **PostToolUse** (satu-satunya yang menaikkan `runs`): bila `fp` dan hash `tool_response` sama dengan state → `runs+1`, selain itu `{fp,out,runs:1}`; `runs >= WARN_AT` → `contextOutput('PostToolUse', 'You repeated the identical <tool> call <runs> times with identical results. Stop and change approach.')`. **PreToolUse:** tool ∈ `BLOCK_TOOLS`, `fp` sama state, `runs >= BLOCK_AT` → `denyOutput('Blocked: identical <tool> call repeated <runs> times with identical results. Change approach.')`. Tool `EXEMPT` dan non-plugin-agent → `null`. File state rusak/tidak terbaca → anggap kosong. Penulisan: tulis ke file sementara lalu `renameSync`; setelah menulis, bila jumlah file `loop-*` > `MAX_STATE_FILES`, hapus yang `mtime`-nya tertua.

- [ ] **Step 1: Tes gagal** (dir temp, agen `explorer.md` ada):
  - 2 PostToolUse identik → `null`; ke-3 → konteks peringatan; ke-5 PostToolUse lalu PreToolUse identik `Read` → deny; PreToolUse `Bash` identik pada `runs=5` → `null` (hanya peringatan).
  - Respons berbeda di tengah → `runs` reset ke 1. Argumen berbeda → reset.
  - PreToolUse sendiri tidak menaikkan `runs`.
  - Urutan kunci argumen berbeda, isi sama → fingerprint sama.
  - File state berisi `{{{` → diperlakukan kosong, tanpa error. 70 sesi berbeda → file `loop-*` ≤ 64.
  - `session_id` berbeda dan `agent_id` berbeda tidak berbagi state. `Agent` dan `Task` diabaikan. Tanpa `agent_type` → `null`.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implement. Hash `tool_response` dari `JSON.stringify` stabil.
- [ ] **Step 4:** Entri `PreToolUse` dan `PostToolUse` (tanpa matcher / `.*`) di `hooks.json`. E2E spawn 3× PostToolUse dengan `CLAUDE_PLUGIN_DATA` temp → panggilan ke-3 menghasilkan `additionalContext`.
- [ ] **Step 5:** PASS.

### Task 5: phase-reminder

**Files:**
- Create: `hooks/scripts/phase-reminder.mjs`
- Modify: `hooks/hooks.json`
- Test: `test/phase-reminder.test.mjs`

**Interfaces:**
- Consumes: `agentName`, `contextOutput`, `runHook`, `isMain`.
- Produces: `PHASE_REMINDER_TEXT: string`; `decide(input: object): object | null`.

Teks (adaptasi `PHASE_REMINDER_TEXT` repo asal): `<system-reminder>\nScheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. Otherwise: plan lanes → dispatch specialists with the Agent tool (independent lanes in parallel, run_in_background when useful) → reconcile their results → verify.\n</system-reminder>`.

Perilaku: `hook_event_name === 'SessionStart'` dan `agentName(input) === 'orchestrator'` → `contextOutput('SessionStart', PHASE_REMINDER_TEXT)`; selain itu `null`.

- [ ] **Step 1: Tes gagal:** `{hook_event_name:'SessionStart', agent_type:'oh-my-claude-slim:orchestrator'}` → konteks berisi `Scheduler workflow`; `agent_type:'explorer'` → `null`; tanpa `agent_type` → `null`; event lain → `null`; teks tidak mengandung kata terlarang dari Global Constraints.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Entri `SessionStart` matcher `startup|resume|clear|compact`. **Step 5:** PASS.

### Task 6: Agen + `.mcp.json`

**Files:**
- Create: `agents/{orchestrator,explorer,oracle,designer,fixer,observer}.md`, `.mcp.json`
- Test: `test/agents.test.mjs`

**Interfaces:**
- Produces: tiap agen berfrontmatter `name` (= nama file), `description` (kriteria routing satu-dua kalimat), `model`, serta `disallowedTools` atau `tools`; `oracle` memakai `skills: [simplify]`.

| Agen | model | akses | sumber prompt |
|---|---|---|---|
| orchestrator | (diwarisi) | semua | `buildOrchestratorPrompt` (Role, Workflow, Verify, Communication) tanpa blok `<Agents>`; sebut spesialis sebagai `oh-my-claude-slim:<nama>` lewat tool Agent; tambah bagian dasar singkat (gaya kerja, keselamatan, penggunaan tool) |
| explorer | `haiku` | `disallowedTools: Edit, Write, NotebookEdit` | `EXPLORER_PROMPT` |
| oracle | `opus` | idem | `ORACLE_PROMPT` + `skills: [simplify]` (setelah Task 7) |
| designer | `sonnet` | penuh | `DESIGNER_PROMPT` |
| fixer | `sonnet` | penuh | `FIXER_PROMPT` |
| observer | `sonnet` | `tools: Read` | `OBSERVER_PROMPT` |

Konstanta dijadikan teks biasa: `READONLY_FILE_OPERATIONS_RULES`, `WRITABLE_FILE_OPERATIONS_RULES` (`src/config/constants.ts`), `USER_REQUEST_RULE`, `SCOPED_VALIDATION_RULES` (`role-prompts.ts`). Ganti rujukan `@designer` di prompt fixer menjadi `oh-my-claude-slim:designer`; hapus baris tentang `task_*`. Spesialis tidak memanggil agen lain (tulis satu baris itu di tiap prompt).

`.mcp.json`: `{"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp"},"gh_grep":{"type":"http","url":"https://mcp.grep.app"}}}`. Tanpa kunci API (v1; dokumentasikan di README). Sebelum menulis, cek `~/.claude.json` dan MCP proyek untuk duplikat; bila sudah ada, lewati entri itu dan catat di README.

- [ ] **Step 1: Tes gagal** `test/agents.test.mjs` (parser frontmatter mini: baris `kunci: nilai`, `[a, b]` jadi array): untuk tiap `agents/*.md`: `name` = nama file dan tanpa `:`; `description` tak kosong; badan tidak mengandung kata terlarang (Global Constraints); explorer/oracle memuat `disallowedTools` dengan `Edit` dan `Write`; observer `tools` = `Read`; tiap `skills` ada di `skills/<nama>/SKILL.md`; set agen persis enam; `.mcp.json` JSON valid dengan kedua server.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Tulis keenam agen dan `.mcp.json`. Orchestrator dibatasi anggaran: setiap kalimat yang bisa dihapus tanpa mengubah perilaku, dihapus (aturan "model-facing bytes are a budget" repo asal).
- [ ] **Step 4:** `claude plugin validate .` → tanpa error. Bila `skills: [simplify]` gagal karena skill belum ada, selesaikan Task 7 lalu ulangi.
- [ ] **Step 5:** `node --test test/agents.test.mjs` → PASS.

### Task 7: Skill

**Files:**
- Create: `skills/<nama>/SKILL.md` untuk `ai-estimates`, `deanchor`, `deepwork`, `simplify`, `step-back`, `verification-planning`, `worktrees` (salin dari `src/skills/<nama>/SKILL.md` repo asal; `simplify` bawa juga `README.md` bila dirujuk)
- Test: `test/skills.test.mjs`

Dilewati di v1 (khusus OpenCode): `oh-my-opencode-slim`, `reflect` (membaca DB sesi OpenCode), `codemap`, `clonedeps`. Catat di README. `deepwork` dan `worktrees` menyebut tool OpenCode: ganti dengan padanan Claude Code (tool Agent, `run_in_background`) atau buang kalimatnya.

- [ ] **Step 1: Tes gagal:** tiap `skills/*/SKILL.md` punya frontmatter `name` = nama dir dan `description`; badan tanpa kata terlarang; set skill sama persis dengan tujuh di atas.
- [ ] **Step 2:** FAIL. **Step 3:** Salin dan adaptasi; hapus hanya yang bergantung pada OpenCode, jangan menulis ulang sisanya. **Step 4:** `node --test test/` → semua PASS; `claude plugin validate .` bersih.

### Task 8: README + verifikasi risiko terbuka

**Files:**
- Create: `README.md`
- Modify: `docs/design.md` (hasil uji di bagian "Risiko terbuka")

README memuat: pasang (`claude --plugin-dir <path>` atau marketplace lokal), jalankan (`claude --agent oh-my-claude-slim:orchestrator` atau `"agent"` di `.claude/settings.json`), cara menambah agen (satu file contoh), cara menambah/mematikan hook (satu entri `hooks.json`), skill yang dilewati, peringatan overlap superpowers, dan catatan MCP tanpa kunci.

- [ ] **Step 1:** Jalankan `claude --plugin-dir . --agent oh-my-claude-slim:orchestrator --debug` di dir proyek uji. Catat dari log hook: apakah `agent_type` terisi pada `SessionStart` (dan bentuknya, berawalan plugin atau tidak). Bila kosong, ubah `phase-reminder` menyala tanpa filter agen dan perbarui tesnya.
- [ ] **Step 2:** Minta orchestrator membaca file dengan path salah yang bisa diselamatkan. Catat: apakah `permissionDecision:"allow"` + `updatedInput` melewati prompt izin atau aturan deny pengguna. Bila melewati aturan deny, ganti ke `ask` atau hapus hook rescue.
- [ ] **Step 3:** Catat apakah `--agent` menggantikan atau menambah system prompt bawaan; bila menambah, pangkas bagian dasar orchestrator.
- [ ] **Step 4:** Catat apakah subagent bisa memanggil subagent (menentukan nasib council).
- [ ] **Step 5:** Tulis hasil keempat uji ke `docs/design.md`, jalankan `node --test test/` terakhir kali, lalu laporkan ke pengguna apa yang lulus dan apa yang diubah.
