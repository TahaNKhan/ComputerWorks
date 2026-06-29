// packages/ui/src/lib/allowlist-derive.test.ts
// T18.3 — Unit tests for the helpers used to render the derived
// "Always allow `<token>` …" button on the approval card.

import { describe, expect, it } from "bun:test";
import {
  deriveRunShellToken,
  firstToken,
  isSafeToken,
} from "./allowlist-derive.js";

describe("firstToken", () => {
  it("returns the first whitespace-delimited token", () => {
    expect(firstToken("curl -s X")).toBe("curl");
    expect(firstToken("git status")).toBe("git");
  });

  it("returns the whole string if there is no whitespace", () => {
    expect(firstToken("ls")).toBe("ls");
    expect(firstToken("node")).toBe("node");
  });

  it("trims leading whitespace", () => {
    expect(firstToken("   ls -la")).toBe("ls");
    expect(firstToken("\tcurl https://example.com")).toBe("curl");
  });

  it("treats tabs as separators", () => {
    expect(firstToken("git\tstatus")).toBe("git");
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(firstToken("")).toBeNull();
    expect(firstToken("   ")).toBeNull();
    expect(firstToken("\t")).toBeNull();
  });
});

describe("isSafeToken", () => {
  it("accepts plain command names", () => {
    expect(isSafeToken("curl")).toBe(true);
    expect(isSafeToken("git")).toBe(true);
    expect(isSafeToken("node")).toBe(true);
    expect(isSafeToken("python3")).toBe(true);
    expect(isSafeToken("ls")).toBe(true);
  });

  it("accepts names with dots, dashes, underscores", () => {
    expect(isSafeToken("node-server")).toBe(true);
    expect(isSafeToken("python3.11")).toBe(true);
    expect(isSafeToken("foo_bar")).toBe(true);
    expect(isSafeToken("a")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(isSafeToken("rm;echo")).toBe(false);
    expect(isSafeToken("a&&b")).toBe(false);
    expect(isSafeToken("a|b")).toBe(false);
    expect(isSafeToken("a$b")).toBe(false);
  });

  it("rejects tokens starting with a digit", () => {
    expect(isSafeToken("3rd-tool")).toBe(false);
    expect(isSafeToken("1")).toBe(false);
  });

  it("rejects empty / whitespace / path-like tokens", () => {
    expect(isSafeToken("")).toBe(false);
    expect(isSafeToken(" ")).toBe(false);
    expect(isSafeToken("/usr/bin/ls")).toBe(false);
    expect(isSafeToken("../etc/passwd")).toBe(false);
  });
});

describe("deriveRunShellToken", () => {
  it("returns the first token for a run_shell call with a safe cmd", () => {
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "curl -s X" } }),
    ).toEqual({ token: "curl" });
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "ls -la /tmp" } }),
    ).toEqual({ token: "ls" });
  });

  it("returns null for non-run_shell tools", () => {
    expect(
      deriveRunShellToken({ name: "read_file", input: { path: "/x" } }),
    ).toBeNull();
    expect(
      deriveRunShellToken({ name: "write_file", input: { path: "/x" } }),
    ).toBeNull();
  });

  it("returns null when input is missing or not an object", () => {
    expect(deriveRunShellToken({ name: "run_shell", input: undefined })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: null })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: "echo hi" })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: 42 })).toBeNull();
  });

  it("returns null when cmd is missing or non-string", () => {
    expect(deriveRunShellToken({ name: "run_shell", input: {} })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: { cmd: 42 } })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: { cmd: null } })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: { cmd: ["ls"] } })).toBeNull();
  });

  it("returns null when cmd is empty / whitespace-only", () => {
    expect(deriveRunShellToken({ name: "run_shell", input: { cmd: "" } })).toBeNull();
    expect(deriveRunShellToken({ name: "run_shell", input: { cmd: "   " } })).toBeNull();
  });

  it("returns null when the first token fails the safety check", () => {
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "rm; echo x" } }),
    ).toBeNull();
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "/usr/bin/ls" } }),
    ).toBeNull();
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "1something" } }),
    ).toBeNull();
  });

  it("keeps the full first token (no escape, no regex)", () => {
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "python3.11 -V" } }),
    ).toEqual({ token: "python3.11" });
    expect(
      deriveRunShellToken({ name: "run_shell", input: { cmd: "node-server --port=4747" } }),
    ).toEqual({ token: "node-server" });
  });
});