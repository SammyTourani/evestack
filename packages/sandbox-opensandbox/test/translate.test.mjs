import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE, joinOutput, resolvePath } from "../dist/translate.js";

/**
 * These two functions are the only part of this adapter that runs without an
 * OpenSandbox server, and both shipped a bug while they were module-private and
 * therefore untestable. The cases below are the two regressions plus the edges
 * that would let a third one through.
 */

test("joinOutput restores the newlines OpenSandbox strips per message", () => {
  // The original join("") produced "abc" and every multi-line command the model
  // ran came back mashed together.
  assert.equal(joinOutput([{ text: "a" }, { text: "b" }, { text: "c" }]), "a\nb\nc");
});

test("joinOutput does NOT append a newline the command never wrote", () => {
  // `printf %s x` arrives as one message; eve's Docker backend returns "x", and
  // the over-correction for the bug above returned "x\n" — on almost every
  // command, because a one-line result is the common case for a tool call.
  assert.equal(joinOutput([{ text: "x" }]), "x");
});

test("joinOutput on no output is the empty string, not a bare newline", () => {
  assert.equal(joinOutput([]), "");
  assert.equal(joinOutput(undefined), "");
});

test("joinOutput reads the alternate message shapes, and skips non-strings", () => {
  assert.equal(joinOutput(["a", { content: "b" }, { line: "c" }, { data: "d" }]), "a\nb\nc\nd");
  // A message with no readable text contributes an empty line rather than
  // "undefined" or a dropped line, so line numbering survives.
  assert.equal(joinOutput([{ text: "a" }, { nothing: 1 }, { text: "c" }]), "a\n\nc");
});

test("joinOutput preserves interior blank lines", () => {
  assert.equal(joinOutput([{ text: "a" }, { text: "" }, { text: "b" }]), "a\n\nb");
});

test("resolvePath anchors a relative path to /workspace", () => {
  assert.equal(resolvePath("notes.md"), "/workspace/notes.md");
  assert.equal(resolvePath("a/b/c.txt"), "/workspace/a/b/c.txt");
  assert.equal(WORKSPACE, "/workspace");
});

test("resolvePath passes an absolute path through untouched", () => {
  assert.equal(resolvePath("/etc/hosts"), "/etc/hosts");
  assert.equal(resolvePath("/workspace/x"), "/workspace/x");
});

test("resolvePath expands $HOME/ to /root/", () => {
  assert.equal(resolvePath("$HOME/.bashrc"), "/root/.bashrc");
  // Only the prefix form. A bare "$HOME" is not a path and must not be rewritten
  // into "/root/" with the name eaten.
  assert.equal(resolvePath("$HOME"), "/workspace/$HOME");
  assert.equal(resolvePath("x/$HOME/y"), "/workspace/x/$HOME/y");
});

test("resolvePath is idempotent, because eve's own builder may call it twice", () => {
  for (const path of ["notes.md", "/etc/hosts", "$HOME/.bashrc"]) {
    assert.equal(resolvePath(resolvePath(path)), resolvePath(path), path);
  }
});
