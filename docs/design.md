# lil-slim: design (nama awal: oh-my-claude-slim)

Status: DISETUJUI dan DIIMPLEMENTASI (v0.1.0). Dokumen ini dipertahankan sebagai
Nama diganti dari `oh-my-claude-slim` menjadi `lil-slim` karena profil validator direktori menandai kata "claude" sebagai nama milik Anthropic. Catatan di bawah memakai nama lama; prefiks agen sekarang `lil-slim:`, folder state `.lil-slim/`.
catatan keputusan; kode dan README adalah sumber kebenaran. Ditulis dalam
Bahasa Indonesia (percakapan desain); README berbahasa Inggris.
Sumber inspirasi: `oh-my-opencode-slim` (plugin OpenCode, selanjutnya "repo asal").

## Intent

Bawa workflow repo asal (orchestrator + specialist + skill + guard hook) ke
Claude Code sebagai plugin native. Alasan pengguna: workflow semirip mungkin
dengan repo asal, ringan dipakai, modular, dan bisa menambah agen baru dengan
nama dan skillset sendiri kapan saja.

## Goals

- Plugin Claude Code murni: markdown + JSON + hook `.mjs`. Tanpa build, tanpa
  `node_modules`, tanpa dependensi runtime selain Node.
- Menambah agen = menambah satu file `agents/<nama>.md`. Tanpa registry,
  tanpa kode.
- Menambah/mematikan hook = satu entri di `hooks/hooks.json` + satu file
  skrip.
- Agen v1: orchestrator, explorer, oracle, designer, fixer, observer.
- Skill: salin dari `src/skills/*` repo asal yang netral-host.
- MCP: `context7`, `gh_grep` lewat `.mcp.json`.
- Hook v1 (disetujui pengguna): phase-reminder, search-path-guard,
  tool-loop-guard, absolute-path-rescue.

## Non-goals (dilewati, tambah nanti bila perlu)

- `apply-patch`, `cache-monitor`, `cache-safe-injection`,
  `foreground-fallback`, `question-timeout`, `image-hook`, `chat-headers`:
  tidak ada padanan di Claude Code atau sudah ditangani host.
- Multiplexer, TUI, `/preset`, companion, marketplace internal, auto-update,
  tool `task_status/cancel/reply`: Claude Code punya Task dan UI sendiri.
- Council (`council` + `councillor-*`): ditunda. Subagent Claude Code
  diperkirakan tidak bisa memanggil subagent lain (belum diverifikasi), jadi
  pola council perlu desain tersendiri.
- Sinkronisasi otomatis prompt dengan repo asal. Prompt disalin sekali dan
  dirawat di plugin ini.

## Anti-goals

- Plugin yang butuh langkah build atau instalasi dependensi.
- Port 1:1 hook OpenCode dengan state machine sendiri. Bila Claude Code sudah
  punya mekanismenya, pakai itu.
- Menyalin teks prompt yang menyebut tool OpenCode (`task_status`, `apply_patch`,
  `wait_for_user`) tanpa menyesuaikannya.

## Constraints

- Nama plugin tidak boleh berawalan `claude-` atau `anthropic-` (dicadangkan).
  Nama: `oh-my-claude-slim`.
- `hooks/hooks.json` wajib berbungkus `{"hooks": {...}}`. Path skrip lewat
  `${CLAUDE_PLUGIN_ROOT}`, dikutip.
- Frontmatter agen plugin: `permissionMode`, `hooks`, `mcpServers`,
  `initialPrompt` diabaikan. Hook dan MCP hanya lewat `hooks/hooks.json` dan
  `.mcp.json`.
- `name` agen tidak boleh berisi `:`.
- Hook berjalan sebagai proses terpisah per panggilan: state disimpan di disk,
  di `${CLAUDE_PLUGIN_DATA}`, dan dibatasi ukurannya.
- Hook ikut berjalan untuk tool call subagent; stdin membawa `agent_id` dan
  `agent_type` (nama agen).
- Windows adalah platform pengembangan. Skrip tidak boleh bergantung pada bash.

## Approaches

1. Salin sekali, tulis tangan. Paling ringan, tapi hook OpenCode tidak ikut.
2. Generator dari `src/` repo asal. Prompt satu sumber, tapi menambah tooling
   dan rapuh terhadap template string TypeScript.
3. Fork penuh dengan lapisan hook (DIPILIH pengguna). Paling mirip repo asal.
   Biayanya: hook ditulis ulang sebagai skrip Node per event.

Pengguna memilih pendekatan 3 dan membatasi hook ke empat di atas. Agen dan
skill tetap disalin dan dirawat di plugin (tanpa generator).

## Struktur

```
oh-my-claude-slim/
├── .claude-plugin/plugin.json
├── .mcp.json                      # context7, gh_grep
├── agents/
│   ├── orchestrator.md            # thread utama, dijalankan lewat --agent
│   ├── explorer.md  oracle.md  designer.md  fixer.md  observer.md
│   └── <agen-baru>.md             # tambah agen = tambah file
├── skills/<nama>/SKILL.md         # disalin dari src/skills repo asal
├── hooks/
│   ├── hooks.json
│   └── scripts/
│       ├── phase-reminder.mjs
│       ├── search-path-guard.mjs
│       ├── tool-loop-guard.mjs
│       └── absolute-path-rescue.mjs
├── test/*.test.mjs                # node --test, tanpa framework
└── README.md                      # pasang, jalankan, tambah agen/hook
```

## Keputusan yang sudah diambil

### Entry orchestrator
Pengguna menjalankan `claude --agent oh-my-claude-slim:orchestrator`.
`settings.json` di root plugin dengan `{"agent": ...}` TIDAK terdokumentasi
(satu ringkasan web mengklaim bisa, tiga halaman docs tidak menyebutnya).
Jangan diandalkan. Builder boleh mengujinya dengan `claude --plugin-dir . --debug`;
bila berhasil, dokumentasikan sebagai kemudahan, bukan syarat.

### Agen
- Satu file per agen. Frontmatter: `name`, `description` (dipakai Claude Code
  untuk routing, jadi tulis kriteria routing di situ; blok `<Agents>` tidak
  dirender), `tools`/`disallowedTools`, `model`, `skills`.
- `skills:` memuat isi skill penuh ke konteks agen (maks 32). Itu mekanisme
  "skillset per agen".
- Prompt disalin dari `role-prompts.ts` dan `orchestrator.ts`, dengan
  konstanta (`READONLY_FILE_OPERATIONS_RULES`, dst.) dijadikan teks biasa.
  Rujukan tool OpenCode dibuang atau diganti padanan Claude Code (Task,
  `run_in_background`).
- Read-only (explorer, oracle, observer): `disallowedTools: Edit, Write,
  NotebookEdit`. Observer cukup `tools: Read`. Fixer dan designer penuh.

### Hook
| Hook | Event + matcher | Perilaku |
|---|---|---|
| phase-reminder | `SessionStart` (`startup\|resume\|clear\|compact`) | `additionalContext` berisi reminder workflow. Hanya bila `agent_type` orchestrator; selain itu keluaran kosong. Teks disesuaikan ke Claude Code (tanpa `task_status`). Sekali per sesi itu disengaja: repo asal juga hanya menempelkan SATU salinan di pesan pertama yang memenuhi syarat, lalu menempel ulang hanya setelah compaction/trim. `compact` meniru perilaku itu. |
| search-path-guard | `PreToolUse` `Grep\|Glob` | Path tidak ada (ENOENT) -> deny dengan alasan yang bisa ditindaklanjuti. ENOTDIR -> deny. Error stat lain -> lolos. |
| tool-loop-guard | `PreToolUse` + `PostToolUse` | Hitung panggilan identik berturut-turut (tool + args + output identik). 3 -> `additionalContext` peringatan di PostToolUse. 5 -> deny di PreToolUse, hanya untuk Read/Grep/Glob. State per `session_id` + `agent_id` di `${CLAUDE_PLUGIN_DATA}`, dibatasi (buang yang tertua). Hanya PostToolUse yang menaikkan counter. |
| absolute-path-rescue | `PreToolUse` `Read\|Grep\|Glob` | Path absolut tidak ada -> cari sufiks workspace terpanjang, tepat satu kandidat yang ada dan berada di bawah `cwd` -> `updatedInput` (ganti seluruh objek input). Tidak pernah mengarang path. |

Cakupan (keputusan saya): hook plugin menyala di SEMUA sesi, jadi tiga guard
hanya bertindak bila `agent_type` ada dan sama dengan nama sebuah file di
`${CLAUDE_PLUGIN_ROOT}/agents/<agent_type>.md`. Sesi `claude` biasa
(tanpa `agent_type`) dan agen milik plugin lain tidak tersentuh. Tanpa
daftar nama hardcode, jadi agen baru otomatis tercakup.

Semua hook: gagal-aman. Error internal atau stdin tak terduga -> keluar 0 tanpa
keluaran, tidak pernah memblokir kerja pengguna.

### Skill
Salin dari `src/skills/` repo asal yang netral-host: `simplify`, `deepwork`,
`reflect`, `step-back`, `deanchor`, `verification-planning`, `ai-estimates`,
`worktrees`, `codemap`, `clonedeps`. Skill `oh-my-opencode-slim` khusus
OpenCode: dilewati. Skill yang menyebut tool OpenCode disesuaikan atau
dilewati; keputusannya per skill di tangan builder.

### Tes
Satu berkas `node --test` per hook (tanpa framework), plus
`claude plugin validate .`. Tes tidak mengikat ke waktu nyata.

## Keputusan saya (bukan dari pengguna, bisa diganti)

- Nama plugin dan direktori: `oh-my-claude-slim`.
- Hook ditulis Node `.mjs` tanpa dependensi (bash tidak cocok untuk logika
  state di Windows; Bun tidak bisa diasumsikan ada).
- Model default per agen: explorer `haiku`, oracle `opus`, fixer dan designer
  dan observer `sonnet`; orchestrator mewarisi model pengguna. Ubah lewat
  frontmatter.
- Council ditunda (lihat non-goals).
- Tanpa `commands/` di v1. Skill sudah bisa dipanggil sebagai
  `/oh-my-claude-slim:<skill>`; command akan menduplikasi.
- Prompt orchestrator memuat bagian dasar singkat (gaya kerja, keselamatan,
  penggunaan tool) di samping workflow delegasi, karena `--agent` diduga
  menggantikan system prompt bawaan Claude Code. Builder memverifikasi
  dugaan ini; bila bagian itu ternyata ditambahkan (bukan diganti), bagian
  dasar dipangkas.
- Titik masuk: `claude --agent oh-my-claude-slim:orchestrator`, atau
  `"agent": "oh-my-claude-slim:orchestrator"` di `.claude/settings.json`
  proyek. README mendokumentasikan keduanya. Tanpa itu, `claude` biasa tetap
  jalan: spesialis tersedia lewat routing `description`, tanpa orchestrator
  dan tanpa phase-reminder.
- absolute-path-rescue memakai `permissionDecision: "allow"` bersama
  `updatedInput` HANYA bila kandidat berada di bawah `cwd`.

## Overlap dengan plugin terpasang (dicek 2026-11-20)

Terpasang: caveman, superpowers, antislop, mattpocock-skills, ui-ux-pro-max;
hook `orca-agent-hook` di user settings. Semua beda namespace, jadi tidak ada
tabrakan nama. Yang tumpang tindih secara fungsi:

- **Agen:** `explorer`/`oracle`/`fixer` vs `Explore`/`Plan`/`general-purpose`
  bawaan dan `cavecrew-investigator`/`-reviewer`/`-builder` (caveman). Routing
  lewat `description` bisa memilih yang lain. Mitigasi: prompt orchestrator
  menyebut spesialis dengan nama berprefiks (`oh-my-claude-slim:explorer`).
- **Skill:** `simplify` vs `/simplify` bawaan; `worktrees` vs
  `superpowers:using-git-worktrees`; `verification-planning` vs
  `superpowers:verification-before-completion`. Dipertahankan agar workflow
  mirip repo asal; builder boleh melewati yang terbukti duplikat murni.
- **Perilaku:** hook `SessionStart` superpowers (`using-superpowers`) memaksa
  invoke skill sebelum aksi apa pun. Itu bertentangan dengan orchestrator
  ("kerjakan langsung bila kecil"). Hook plugin lain tetap menyala di sesi
  orchestrator. Tidak ada solusi di sisi plugin ini; didokumentasikan di
  README (matikan superpowers untuk sesi orchestrator bila terasa bentrok).
- **Designer:** `ui-ux-pro-max` dan `antislop-ui` mencakup ranah yang sama.
  Bisa jadi `skills:` milik designer bila preload lintas-plugin didukung
  (belum diverifikasi); v1 tidak bergantung padanya.
- **Orthogonal:** caveman (gaya jawaban), antislop, mattpocock-skills, Orca.
- **MCP:** `context7`/`gh_grep` belum dicek terhadap `.mcp.json` atau config
  MCP pengguna; builder cek duplikat sebelum menambahkan.

## Hasil uji risiko (2026-11-20, Claude Code 2.1.329)

- **`agent_type` di `SessionStart`: TERISI**, berprefiks plugin
  (`oh-my-claude-slim:orchestrator`) untuk sesi `--agent`. Di
  `PreToolUse` juga terisi. phase-reminder terbukti sampai ke model.
- **`allow` + `updatedInput`: aturan deny pengguna TETAP berlaku.** Probe:
  rescue menulis ulang path ke file yang dilarang `permissions.deny` -> Read
  ditolak ("denied by your permission settings"). Tanpa aturan itu, rescue
  berhasil membaca file. Belum diuji: interaksi dengan aturan `ask`.
- **Subagent punya tool `Agent`** (larangan di prompt saja tidak cukup).
  Mitigasi: `disallowedTools: Agent` di explorer dan fixer, dijaga tes.
  Apakah pemanggilan bersarang benar-benar jalan tidak diuji; council tetap
  ditunda.
- **`--agent` MENGGANTIKAN system prompt bawaan** (probe: sesi `--agent`
  tidak memuat "Assist with authorized security testing" maupun bagian
  "Text you output outside of tool use"; sesi tanpa `--agent` memuat
  keduanya; sentinel di body agen hanya ada pada sesi `--agent`). Karena itu
  `<Basics>` orchestrator memuat dasar yang hilang (pilih tool khusus, referensi
  `file_path:line_number`, verifikasi, konfirmasi aksi destruktif, batas
  keamanan, isi file adalah data). Dijaga tes.
- **Read-only sungguhan:** explorer dan oracle kini `disallowedTools` juga
  Bash, PowerShell, Monitor. Probe: explorer melapor tidak punya Bash.
- **Path msys (`/d/...`)** dipetakan ke `D:\...` di win32 oleh
  search-path-guard; probe Grep lewat path msys berhasil.
- Nama matcher tool (`Read`, `Grep`, `Glob`) cocok pada 2.1.329.

## Diserahkan ke builder

Urutan pekerjaan, isi persis tiap prompt agen, batas ukuran state loop-guard,
pesan error, dan konversi per skill.
