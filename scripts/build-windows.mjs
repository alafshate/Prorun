import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve Git's actual MSYS bash, never System32's WSL bash.exe. Keeping this
// launcher native also avoids loading ~/.bashrc before fixing shell selection.
export function findGitBash(env, exists = existsSync) {
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ]
    .filter(Boolean)
    .map((base) => path.win32.join(base, "Git"));
  if (env.LOCALAPPDATA)
    roots.push(path.win32.join(env.LOCALAPPDATA, "Programs", "Git"));
  const searchPath = env.Path ?? env.PATH ?? "";
  for (const entry of searchPath.split(";").filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, "");
    roots.push(
      directory,
      path.win32.resolve(directory, ".."),
      path.win32.resolve(directory, "../.."),
    );
  }
  for (const root of new Set(roots)) {
    const bash = path.win32.join(root, "usr", "bin", "bash.exe");
    if (
      exists(bash) &&
      exists(path.win32.join(root, "usr", "bin", "msys-2.0.dll")) &&
      (exists(path.win32.join(root, "cmd", "git.exe")) ||
        exists(path.win32.join(root, "mingw64", "bin", "git.exe")))
    )
      return bash;
  }
  return null;
}

function main() {
  if (process.platform !== "win32") {
    console.error(
      "Run this command with Windows Node.js from Git Bash, outside WSL.",
    );
    process.exitCode = 1;
    return;
  }
  const bash = findGitBash(process.env);
  if (!bash) {
    console.error(
      "Git Bash was not found. Install Git for Windows, then retry.",
    );
    process.exitCode = 1;
    return;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const gitRoot = path.win32.resolve(path.win32.dirname(bash), "../..");
  // Avoid duplicate case variants of Windows' case-insensitive PATH variable.
  const env = { ...process.env };
  const inheritedPath = env.Path ?? env.PATH ?? "";
  for (const key of Object.keys(env)) {
    if (
      ["PATH", "BASH_ENV", "ENV", "NPM_CONFIG_SCRIPT_SHELL"].includes(
        key.toUpperCase(),
      )
    )
      delete env[key];
  }
  env.PATH = [
    path.win32.join(gitRoot, "mingw64", "bin"),
    path.win32.join(gitRoot, "usr", "bin"),
    path.win32.join(gitRoot, "bin"),
    path.win32.dirname(process.execPath),
    process.env.USERPROFILE &&
      path.win32.join(process.env.USERPROFILE, ".cargo", "bin"),
    inheritedPath,
  ]
    .filter(Boolean)
    .join(";");
  env.MSYSTEM = "MINGW64";
  env.CHERE_INVOKING = "1";
  env.npm_config_script_shell = bash;
  console.log(`Building with Git Bash: ${bash}`);
  const child = spawn(
    bash,
    ["--noprofile", "--norc", "scripts/build-windows.sh"],
    {
      cwd: root,
      env,
      shell: false,
      stdio: "inherit",
    },
  );
  child.on("error", (error) => {
    console.error(`Could not start Git Bash: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (
  invokedPath &&
  (process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath)
)
  main();
