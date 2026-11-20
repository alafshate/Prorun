# ProRun

A Windows desktop workspace for local development projects, built with Tauri 2, React, TypeScript, and Rust. The packaged application embeds its interface and opens directly from an executable. A browser, Node.js, and a development server are **not** required to run ProRun itself. Your projects still need their own runtimes and dependencies.

**Build status:** a Windows x64 standalone executable is built at **`artifacts/ProRun.exe`** (about 5 MB), with the production interface embedded. The native ConPTY startup cursor handshake has been fixed and its regression tests pass. Full GUI and Git Bash interaction remain unverified in the managed agent environment because Windows denies its runtime operations; launch the executable normally from Explorer to validate your workspace. No NSIS installer has been produced yet. See [VALIDATION.md](VALIDATION.md).

## Installation and use

1. Double-click **`artifacts/ProRun.exe`** on a machine with Microsoft Edge WebView2 Runtime installed. No terminal or development server is needed. If you later build an NSIS installer, you can use `artifacts/*-setup.exe` instead.
2. Install [Git for Windows](https://gitforwindows.org/). Windows 10 version 1809 or newer is required for ConPTY; Windows 11 is recommended.
3. Open ProRun, choose **Add project**, and select the project's root folder. Its folder name becomes the project name.
4. Choose **Add service**. Set a name, working directory (`.`, `./frontend`, or an absolute path), and startup command, such as `npm run dev`, `python -u app.py`, or `cargo run`.
5. Use **Run all / Stop all** or each service's controls. Other projects continue running while you switch projects.
6. Select **Service logs** to view, clear, copy, and follow stdout/stderr. Select **Terminals → New terminal** for independent interactive Git Bash sessions. Closing a terminal tab terminates its process tree.
7. Select **Actions → Add action** to save a reusable command for this project, then choose **Run** whenever needed. Rebuild the desktop application to include this feature in an existing executable.

The sidebar's **Settings** page detects Git Bash or accepts a custom `bin/bash.exe` or `usr/bin/bash.exe` path. WSL's `bash.exe` is rejected. ProRun resolves Git's launcher to the actual MSYS bash executable.

All application service commands, actions, and terminal sessions start through Git Bash. They use a clean shell to preserve the chosen working directory. Git's tools and the Windows user PATH are available; user shell startup files are not automatically sourced. Use `source ~/.bashrc` in a terminal or explicitly in a service command if needed. `npm_config_script_shell` is set to Git Bash so npm package scripts use it as well. Tools may launch their own native subprocesses.

Terminals support ANSI colors, interactive input, full-screen applications, selection, mouse wheel scrolling, resize, and **Ctrl+Shift+C / Ctrl+Shift+V** copy/paste. **Ctrl+C** interrupts a foreground command. Output and screen state are retained when switching projects or tabs. Closing the application stops every owned service, action, and terminal tree. Stop is a forceful Windows Job Object termination; applications should not rely on receiving a shell exit trap.

## Project actions

The **Actions** tab beside **Service logs** stores an unlimited list of named commands per project. Add, edit, duplicate, or delete actions using the list controls. Working directories default to the project root (`.`), and accept relative or absolute Windows paths. Actions are saved in the existing `config.json`; older configurations load with an empty actions list.

Each action runs manually in Git Bash using the same process supervision as services. Different actions can run concurrently; an action already running cannot start a second execution. **Run all / Stop all apply only to services.** Action rows show Idle, Running, Success, or Failed, elapsed time, and the exit code when available. A stopped action returns to Idle. Stop an action before editing it or changing its project's root. Duplicates receive a fresh ID and start Idle.

Run selects that action's live stdout/stderr output. Select any action row or use the output dropdown to inspect another action. Output supports clear, copy, scrolling, and Follow, with the same 512 KB / 4,000-chunk native limits as service logs. Execution history and output stay in memory and reset on application restart. Missing paths, unavailable Git Bash, and command failures appear in the status/output. **Stop**, deleting a running action, removing its project, and closing ProRun terminate the owned process tree.

## AI Usage

Open **AI Usage** in the sidebar for global OpenAI Codex and Claude Code capacity cards, daily/weekly/monthly token charts, provider/project/model/token-type filters, API-equivalent estimates, and configurable 80/90/100% in-app alerts. Monitoring continues when navigating projects, refreshes every two minutes while ProRun is open, and supports manual refresh. It does not start, stop, or write to project services or terminals.

**Configure sources:** select **AI Usage → Configure**. Codex defaults to `CODEX_HOME` or `%USERPROFILE%\.codex`; Claude defaults to `CLAUDE_CONFIG_DIR` or `%USERPROFILE%\.claude`. Absolute Windows paths, including spaces and Unicode, are supported. Codex detects native executables on PATH, common npm installations, and per-user locations; set the native `codex.exe` explicitly for another installation, including a packaged app. No Claude executable is needed to read existing local history.

- **Codex capacity:** an isolated, hidden, short-lived installed `codex app-server` process performs `initialize`, `initialized`, and `account/rateLimits/read`. It never creates a thread or turn. Sign in using Codex itself. Missing executables, timeouts, unsupported versions, API-key accounts, and unavailable quota windows show an explanatory unavailable state. Only the `codex` bucket and explicitly reported 300-minute/10080-minute windows are used. See the [official app-server protocol](https://developers.openai.com/codex/app-server).
- **Claude capacity:** select **Enable capture (opt in)** in Configure, then use Claude Code until it produces a response. This explicitly updates the user `settings.json` status line, retains its other options and the existing command, and forwards that command's stdin/output through Git Bash. A backup is kept alongside ProRun's usage settings. **Disable capture & restore** restores the original status-line object while retaining other settings; subsequent user changes to the command are preserved and require manual restoration. Save custom paths before enabling capture. Project/managed status-line settings may override user settings; integrate the collector into that effective script yourself or select a custom snapshot instead. No Claude configuration is changed without opting in. See [documented status-line fields](https://code.claude.com/docs/en/statusline).
- **Custom Claude snapshot:** point Configure at a JSON file containing documented `rate_limits.five_hour` / `rate_limits.seven_day` objects with `used_percentage` and `resets_at` (epoch seconds). Optional `capturedAt` is epoch milliseconds; otherwise file modification time is used. Each window can be absent. Context-window percentages are never used as subscription limits. Snapshots older than five minutes, future-dated snapshots, and passed resets are expired; refresh cannot force an inactive Claude session to emit new data.
- **Local history:** incrementally reads JSONL under Codex `sessions/` and `archived_sessions/`, and Claude `projects/`, including subagent records and sessions launched outside ProRun. Matches registered projects by the deepest working-directory root; other projects retain their local paths. Deduplicates Codex cumulative counters by session and Claude streaming/copied messages by message identity. Inherited fork counters and reasoning/cache tokens are not added twice. Incomplete final lines are retried. Missing, malformed, oversized, or unsupported records can leave history partial; deleted logs and other machines/accounts are outside coverage. Indexing prioritizes recent files and is bounded at 64 MiB per scan, 8 MiB per file per scan, 2 MiB per line, 10,000 files, 12 directory levels, and approximately 500,000 metadata records. Source notes explain partial scans; subsequent refreshes continue indexing. History metadata is cached in memory and rebuilt on restart.
- **Cost estimates:** hypothetical USD costs at standard text API list rates, **not actual subscription charges**. Exact model IDs only; unsupported models remain unpriced and are excluded from the partial estimate. Rates were checked November 20, 2026 against [OpenAI](https://developers.openai.com/api/docs/pricing) and [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing); Configure lists and accepts per-model overrides. Reasoning is billed once as output; cache writes with unspecified TTL use the 5-minute equivalent. Estimates exclude tools, long-context surcharges, regional premiums, and fast-mode pricing.

`usage-settings.json`, the optional sanitized `claude-usage.json`, collector script, and capture backup live beside ProRun's `config.json` in its app configuration directory. Price overrides use the app's local webview storage. Only timestamps, paths, model/session identities, and token counts are retained for history; prompts, assistant content, credentials, and raw logs are never returned to the UI or persisted by the monitor. The collector saves only subscription limit fields and a timestamp. Authentication remains owned by the installed Codex CLI; ProRun does not extract credentials or call unofficial authenticated endpoints.

Focused validation:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml usage::tests
# Optional live read using your installed, signed-in Codex:
cargo test --manifest-path src-tauri/Cargo.toml usage::tests::installed_codex_interface -- --ignored --nocapture
```

## Development

Install Node.js 22 LTS, Visual Studio Build Tools with **Desktop development with C++**, **MSVC x64/x86 tools**, and a Windows 10/11 SDK, Git for Windows, and WebView2. Install the MSVC **host toolchain** using rustup. Adding an MSVC target to the GNU toolchain alone does not switch the compiler used for dependency build scripts. See the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

In Git Bash at the repository root:

```bash
rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
npm install
npm run desktop
```

`rust-toolchain.toml` selects MSVC for this repository without changing your global Rust default. The packaging script also explicitly selects the MSVC host and target and checks the linker/SDK before starting the build. Reopen Git Bash after installing Visual Studio Build Tools.

Development uses Vite internally. Production embeds the compiled interface into the Windows executable.

```bash
npm test                              # frontend logic checks
npm run build                         # TypeScript + production frontend
cargo test --manifest-path src-tauri/Cargo.toml
```

The Rust tests use real Git Bash processes and ConPTY. They cover stdout/stderr, duplicate starts, restarts, Job Object tree termination, persistence, terminal input/Unicode/resize, and buffer limits. Run them on Windows with Git for Windows installed.

## Build executables

```bash
node scripts/build-windows.mjs
```

This entry point selects Git for Windows' actual Bash executable by its full path and puts Git's utilities first on the child process PATH. It does not depend on what a bare `bash` command resolves to. Prepending Windows System32 to PATH can make `bash` select the WSL launcher, causing `OSTYPE=linux-gnu` and stopping the Windows build. The new entry point avoids that collision without changing your shell configuration.

Use Windows Node directly to bypass npm's shell wrapper. If that wrapper reports `/bin/bash: C:/Program Files/nodejs/npm: No such file or directory`, a standard Node installation can be launched from Git Bash with `"/c/Program Files/nodejs/node.exe" scripts/build-windows.mjs`. `npm run package:windows` is also available when npm's wrapper works normally. The child build environment puts Git Bash and the selected Node installation ahead of the inherited PATH.

After a successful build, double-click `artifacts/ProRun.exe`, or launch it from Git Bash with `./artifacts/ProRun.exe`.

This installs dependencies, runs checks, builds the native application and NSIS installer, then copies the deliverables and SHA-256 checksums into `artifacts/`:

- `artifacts/ProRun.exe` — standalone application (requires WebView2).
- `artifacts/*-setup.exe` — per-user installer; installs WebView2 when needed (network access required if absent).
- `artifacts/SHA256SUMS.txt` — executable checksums.

Original packaging-script output: `src-tauri/target/x86_64-pc-windows-msvc/release/prorun.exe` and `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. For packaging alone, use `npm run package -- --target x86_64-pc-windows-msvc`. Builds are unsigned until a release signing certificate is configured.

The **Windows desktop build** GitHub Actions workflow performs the same checks and uploads `ProRun-Windows-x64` as a downloadable artifact. It can be run manually after the repository is hosted on GitHub; this task has not published or triggered it. Commit the generated npm and Cargo lockfiles after the first successful dependency installation to make subsequent builds reproducible.

## Persistence and architecture

- Configuration: `%APPDATA%\dev.prorun.desktop\config.json`, with atomic replacement and write-through. Editing a running service requires stopping it first; changing a project's root requires stopping its services and actions and closing its terminals. Removing a project stops it without deleting project files.
- Service supervision: Rust launches each bash process suspended, assigns it to an independent kill-on-close Windows Job Object, then resumes it. Only designated stdin/stdout/stderr handles are inherited. A parent exit also terminates remaining descendants. Duplicate starts are idempotent, and a single-instance guard prevents separate ProRun windows from supervising duplicate copies.
- Terminals: `portable-pty` uses Windows ConPTY, with independent Job Objects and xterm.js views. Reads run independently of the interface. Terminal tabs retain their emulator instances across navigation.
- Terminal startup: the backend answers ConPTY's initial cursor-position request before returning the session. It consumes that initial query so xterm does not answer it twice; later application queries are passed through to xterm. Sessions can initialize and close without an attached frontend.
- Memory: each service and action retains at most 512 KB of output and 4,000 chunks; each terminal retains a 256 KB native replay buffer and 5,000 xterm scrollback lines. Older output is discarded. Logs and terminal sessions are intentionally not restored after application restart.
- Security: bundled local UI, restricted Tauri capabilities, production content security policy, no remote content, no generic filesystem or shell plugin exposed to the interface. Startup commands are user-authored Bash programs, passed as a single argument without another execution shell.

`src/` contains the interface, `src-tauri/src/engine.rs` supervises runtime state, `windows.rs` owns process and Job Object handles, and `model.rs` validates configuration and detects Git Bash.

## Troubleshooting

- **Git Bash missing:** install Git for Windows or select its bash executable in Settings. An invalid override is not replaced silently with another shell.
- **Service fails:** verify its working directory, command, and installed project runtime. Exit code and stderr appear in service logs. Prefer foreground server commands; background-only launchers are cleaned up when their parent exits.
- **Delayed logs:** some runtimes buffer output when attached to pipes. For Python use `python -u`; configure other runtimes for unbuffered output when necessary.
- **Configuration damage:** ProRun displays a native error and preserves the file. Restore a backup, or rename `config.json` while ProRun is closed to start with a fresh workspace.
- **Build errors:** ensure Rust, MSVC, the Windows SDK, and internet access are available. Tauri downloads packaging tools on its first NSIS build. See [Tauri's Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/).
- **`cannot find -lgcc_eh` / TDM-GCC:** the build used a GNU Rust host. Install `stable-x86_64-pc-windows-msvc` with the command above, install the Visual Studio C++ workload and SDK, then rerun `node scripts/build-windows.mjs`. The script selects MSVC even if your global default is GNU. No GCC repair or `cargo clean` is necessary.
- **`OSTYPE=linux-gnu` despite a MINGW64 prompt:** the nested `bash` command selected WSL, often because System32 is first on PATH. Run `node scripts/build-windows.mjs` from the Windows Git Bash project folder. To select a standard Git installation explicitly, use `"/c/Program Files/Git/bin/bash.exe" --noprofile --norc scripts/build-windows.sh`.
