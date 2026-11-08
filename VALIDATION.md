# Validation record

Environment: Windows, 2026-11-07. The repository initially contained no files or applicable AGENTS.md instructions.

## Current result

- **Standalone executable built:** `artifacts/ProRun.exe`, 4,964,864 bytes, Windows x64 GUI subsystem, product/file version 1.0.0. `artifacts/SHA256SUMS.txt` records its SHA-256 checksum.
- Release compilation succeeded using MSVC with `cargo build --release --locked --offline --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --features tauri/custom-protocol`. The custom-protocol feature embeds the existing production frontend; the executable does not use a development server.
- Reproduced the reported PTY failure: its entire output was `ESC[6n`, ConPTY's initial cursor-position request. Added a backend response at row 1, column 1, and wait for that response before returning the terminal session. Only the startup query is consumed; later queries reach the emulator unchanged.
- Both new protocol tests pass, including every possible read boundary and forwarding subsequent queries. The real ConPTY startup/close test without a frontend also passes.
- Latest full native suite in the managed agent session: **9 passed, 2 failed**. The Git Bash PTY test now passes the cursor handshake, then captures `CreateFileMapping ... Win32 error 5` from Git Bash. The service-stream integration test also fails in this session. These integration checks remain enabled and have not been replaced with mocks or skipped.
- The user's prior normal-shell run passed the service tree, stdout/stderr, persistence, and duplicate-start test, plus the six original unit tests; only the then-unanswered PTY query failed.
- A graphical smoke launch of the release executable in the managed session aborted during Tauri setup with `Access is denied (os error 5)`. Normal Explorer startup, full GUI workflows, and Git Bash interaction still require validation outside that managed session.
- No NSIS installer was built. A standalone executable satisfies the executable deliverable; installer packaging and Windows CI remain unverified.

## Earlier frontend checks

- Implemented frontend and native source, native command registration and capability configuration, icons, NSIS configuration, build script, and Windows CI workflow.
- Five frontend tests pass using `node tests/frontend.test.mjs`: Windows/Unix folder naming, ANSI/OSC sanitizing, Unicode preservation during large terminal pastes, bounded log retention, and uptime formatting.
- All eight tests pass via `npm test`: five frontend tests and three build-launcher regression tests. The launcher tests cover System32/WSL Bash shadowing, custom Git paths, per-user installations, and rejecting an isolated WSL Bash executable.
- A limited TypeScript check passed using the real React 19, React DOM, Lucide, TypeScript 5.7.3, and Vite packages extracted from the existing local npm cache. Tauri and xterm packages are absent from that cache; temporary declarations outside application source were used for their documented API signatures. This does **not** verify those packages' actual type compatibility or runtime behavior.
- Generated valid 256×256 PNG and Windows ICO assets without external image dependencies.

## Earlier setup history

- npm installation succeeded with no reported vulnerabilities, all five frontend tests passed, and the real TypeScript/Vite production build succeeded (1,722 transformed modules).
- Native compilation selected `stable-x86_64-pc-windows-gnu` and TDM-GCC 10.3.0. Dependency build-script linking failed with `cannot find -lgcc_eh`, before the application crate compiled.
- Added repository-local MSVC host selection and explicit host/target selection in the packaging script. A small link probe now checks MSVC and the SDK before dependency installation and compilation. Packaging output paths account for the explicit target.
- The old GNU default remains unchanged; no global toolchain settings or installed compilers were modified by this fix.
- The first direct rustup check found that MSVC Rust was missing. A later check confirms `stable-x86_64-pc-windows-msvc` is now installed (`rustc 1.99.1`). The updated script still cannot be executed in the managed agent environment: Git Bash initialization fails with `CreateFileMapping ... Win32 error 5` before it can parse or run the script.
- Replaced the script's external `uname` platform check with Bash's built-in `OSTYPE`, so PATH-resolved platform utilities cannot cause the false Windows/Git Bash rejection reported by the user.
- A direct MSVC link probe still fails: Rust selects `C:\Program Files\Git\usr\bin\link.exe`, and Visual Studio's C++ workload is not detected by `vswhere`. Microsoft's C++ linker and SDK must be available before native compilation can proceed.
- The latest reported shell values (`OSTYPE=linux-gnu`, `MSYSTEM=unset`) establish that a nested Linux Bash was selected. System32 was prepended to PATH and contains the WSL `bash.exe` launcher. Added a native Node entry point that locates Git's actual MSYS Bash, starts it by absolute path without loading user startup files, and sets the child PATH and npm script shell to Git Bash. `npm run package:windows` and Windows CI use that entry point. It does not modify the user's PATH or startup files.
- Running the new entry point confirms that it selects `C:\Program Files\Git\usr\bin\bash.exe`. The managed agent environment still denies MSYS shared-memory initialization (`CreateFileMapping ... Win32 error 5`), so a complete build cannot be claimed from that run.
- The latest npm bootstrap failure occurs before that entry point runs: the installed `C:\Program Files\nodejs\npm` wrapper exists and uses `#!/usr/bin/env bash`, which resolves to the WSL Bash with System32 first on PATH. Windows `node.exe` and npm's CLI are present. Documented launching the helper directly with Windows Node and added that Node installation to the child PATH; no user profile files were modified.

## Blocked / outstanding

- MSVC, the Windows C++ tools, and the SDK are now available; native test compilation and production release compilation both succeed. The earlier missing-toolchain/linker findings below the setup-history heading are historical.
- Full runtime validation remains blocked in this managed session by Windows access restrictions, as detailed in the current result. The two Git Bash integration tests and the desktop acceptance checks must pass in a normal Windows session before calling this a verified production release.
- The original managed-environment npm download and Vite `spawn EPERM` failures are historical limitations; the user's successful frontend build above supersedes them for that machine. npm and Cargo lockfiles now exist from the user's dependency installation.
- The standalone executable exists. A normal desktop launch, successful end-to-end Git Bash interaction, NSIS installer testing, and visual acceptance checks remain outstanding.
- Windows CI is configured but has not been executed or published by this task.

## Required acceptance checks on a build-capable Windows machine

1. Run `node scripts/build-windows.mjs` using Windows Node; resolve any dependency, compiler, test, or packaging failures. Keep the generated lockfiles.
2. Install with the generated NSIS setup executable. Launch from Start or the desktop with no development server running. Launch again and confirm the existing window gains focus.
3. Add two projects, including a root path with spaces and non-ASCII characters. Create frontend/backend services, using both relative and absolute directories.
4. Start both projects, switch between them, verify independent logs and uptime, and rapidly repeat Run/Restart to confirm only one tree exists per service.
5. Stop services that spawn child servers. Confirm all descendants exit and their ports are released. Repeat by removing a project and by closing ProRun.
6. Open several Git Bash terminals in each project. Verify `pwd`, ANSI color, a full-screen editor, Unicode input/output, resize, Ctrl+C, copy/paste, and independent closing. Switch tabs/projects and verify retained screen state.
7. Produce high-volume stdout/stderr; verify output stays bounded and the interface remains usable. Test clear/copy/follow and restarting while logs are displayed.
8. Test missing/invalid Git Bash overrides, missing directories, invalid commands, corrupted configuration, and restart persistence. Confirm no project files are removed.

The source should not be described as a verified production release until these checks pass.
