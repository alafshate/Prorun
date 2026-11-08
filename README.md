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

The sidebar's **Settings** page detects Git Bash or accepts a custom `bin/bash.exe` or `usr/bin/bash.exe` path. WSL's `bash.exe` is rejected. ProRun resolves Git's launcher to the actual MSYS bash executable.

All application service commands and terminal sessions start through Git Bash. They use a clean shell to preserve the chosen working directory. Git's tools and the Windows user PATH are available; user shell startup files are not automatically sourced. Use `source ~/.bashrc` in a terminal or explicitly in a service command if needed. `npm_config_script_shell` is set to Git Bash so npm package scripts use it as well. Tools may launch their own native subprocesses.

Terminals support ANSI colors, interactive input, full-screen applications, selection, mouse wheel scrolling, resize, and **Ctrl+Shift+C / Ctrl+Shift+V** copy/paste. **Ctrl+C** interrupts a foreground command. Output and screen state are retained when switching projects or tabs. Closing the application stops every owned service and terminal tree. Stop is a forceful Windows Job Object termination; applications should not rely on receiving a shell exit trap.

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

- Configuration: `%APPDATA%\dev.prorun.desktop\config.json`, with atomic replacement and write-through. Editing a running service requires stopping it first; changing a project's root requires stopping its services and closing its terminals. Removing a project stops it without deleting project files.
- Service supervision: Rust launches each bash process suspended, assigns it to an independent kill-on-close Windows Job Object, then resumes it. Only designated stdin/stdout/stderr handles are inherited. A parent exit also terminates remaining descendants. Duplicate starts are idempotent, and a single-instance guard prevents separate ProRun windows from supervising duplicate copies.
- Terminals: `portable-pty` uses Windows ConPTY, with independent Job Objects and xterm.js views. Reads run independently of the interface. Terminal tabs retain their emulator instances across navigation.
- Terminal startup: the backend answers ConPTY's initial cursor-position request before returning the session. It consumes that initial query so xterm does not answer it twice; later application queries are passed through to xterm. Sessions can initialize and close without an attached frontend.
- Memory: each service retains at most 512 KB of output and 4,000 chunks; each terminal retains a 256 KB native replay buffer and 5,000 xterm scrollback lines. Older output is discarded. Logs and terminal sessions are intentionally not restored after application restart.
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
