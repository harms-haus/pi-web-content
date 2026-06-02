import { describe, expect, it } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  GIT_CLONE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
  BINARY_TYPES,
  ACCEPT_HEADER,
  ACCEPT_LANGUAGE,
} from "../fetch-constants.js";

describe("fetch-constants", () => {
  it("FETCH_TIMEOUT_MS is 30 seconds", () => {
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("GIT_CLONE_TIMEOUT_MS is 120 seconds", () => {
    expect(GIT_CLONE_TIMEOUT_MS).toBe(120_000);
  });

  it("MAX_RESPONSE_BYTES is 10 MB", () => {
    expect(MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("MAX_REDIRECTS is 10", () => {
    expect(MAX_REDIRECTS).toBe(10);
  });

  it("USER_AGENT does not contain platform-specific identifiers", () => {
    expect(USER_AGENT).not.toContain("Linux");
    expect(USER_AGENT).not.toContain("X11");
    expect(USER_AGENT).not.toContain("Macintosh");
    expect(USER_AGENT).not.toContain("Windows");
    expect(USER_AGENT).toContain("Mozilla/5.0");
    expect(USER_AGENT).toContain("AppleWebKit");
  });

  it("BINARY_TYPES includes expected content types", () => {
    expect(BINARY_TYPES).toContain("image/");
    expect(BINARY_TYPES).toContain("video/");
    expect(BINARY_TYPES).toContain("application/pdf");
    expect(BINARY_TYPES).toContain("application/zip");
  });

  it("ACCEPT_HEADER includes text/html", () => {
    expect(ACCEPT_HEADER).toContain("text/html");
  });

  it("ACCEPT_LANGUAGE includes en-US", () => {
    expect(ACCEPT_LANGUAGE).toContain("en-US");
  });
});
