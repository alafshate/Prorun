import { test } from "node:test";
import assert from "node:assert/strict";
import { findGitBash } from "../scripts/build-windows.mjs";

const gitFiles = (root) => [
  `${root}\\usr\\bin\\bash.exe`,
  `${root}\\usr\\bin\\msys-2.0.dll`,
  `${root}\\cmd\\git.exe`,
];
const contains = (paths) => (value) =>
  paths.some((entry) => entry.toLowerCase() === value.toLowerCase());

test("Git Bash selection ignores System32 WSL bash even when it is first on PATH", () => {
  const files = [
    "C:\\Windows\\System32\\bash.exe",
    ...gitFiles("C:\\Program Files\\Git"),
  ];
  assert.equal(
    findGitBash(
      { PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\bin" },
      contains(files),
    ),
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  );
});

test("Git Bash can be resolved from a custom Git directory on PATH", () => {
  assert.equal(
    findGitBash(
      { Path: "D:\\Tools\\PortableGit\\cmd" },
      contains(gitFiles("D:\\Tools\\PortableGit")),
    ),
    "D:\\Tools\\PortableGit\\usr\\bin\\bash.exe",
  );
});

test("a per-user Git install is supported and an isolated WSL bash is rejected", () => {
  assert.equal(
    findGitBash(
      { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      contains(gitFiles("C:\\Users\\dev\\AppData\\Local\\Programs\\Git")),
    ),
    "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
  );
  assert.equal(
    findGitBash(
      { PATH: "C:\\Windows\\System32" },
      contains(["C:\\Windows\\System32\\bash.exe"]),
    ),
    null,
  );
});
