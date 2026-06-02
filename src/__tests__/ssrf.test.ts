import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as dnsPromises from "node:dns/promises";
import {
  isBlockedHostname,
  validateUrlForSsrf,
  isBlockedByDns,
  validateRedirectForSsrf,
} from "../ssrf.js";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

const mockedResolve4 = vi.mocked(dnsPromises.resolve4);
const mockedResolve6 = vi.mocked(dnsPromises.resolve6);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── isBlockedHostname ────────────────────────────────────────────────────────

describe("isBlockedHostname", () => {
  describe("exact matches", () => {
    it.each(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])(
      'blocks exact match: "%s"',
      (hostname) => {
        expect(isBlockedHostname(hostname)).toBe(true);
      },
    );
  });

  describe("prefix matches", () => {
    it("blocks 10.x.x.x addresses", () => {
      expect(isBlockedHostname("10.0.0.1")).toBe(true);
      expect(isBlockedHostname("10.255.255.255")).toBe(true);
      expect(isBlockedHostname("10.1.2.3")).toBe(true);
    });

    it("blocks 172.16-31.x.x addresses", () => {
      expect(isBlockedHostname("172.16.0.1")).toBe(true);
      expect(isBlockedHostname("172.31.255.255")).toBe(true);
      expect(isBlockedHostname("172.20.0.1")).toBe(true);
    });

    it("does not block 172.15.x.x or 172.32.x.x", () => {
      expect(isBlockedHostname("172.15.0.1")).toBe(false);
      expect(isBlockedHostname("172.32.0.1")).toBe(false);
    });

    it("blocks 192.168.x.x addresses", () => {
      expect(isBlockedHostname("192.168.0.1")).toBe(true);
      expect(isBlockedHostname("192.168.1.1")).toBe(true);
      expect(isBlockedHostname("192.168.255.255")).toBe(true);
    });

    it("blocks 169.254.x.x addresses", () => {
      expect(isBlockedHostname("169.254.0.1")).toBe(true);
      expect(isBlockedHostname("169.254.169.254")).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it.each(["LOCALHOST", "LocalHost", "LoCaLhOsT", "LOCALHOST"])(
      'blocks case-insensitive hostname: "%s"',
      (hostname) => {
        expect(isBlockedHostname(hostname)).toBe(true);
      },
    );

    it.each(["127.0.0.1"])('handles case-insensitive IP: "%s"', (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    });
  });

  describe("non-blocked hostnames", () => {
    it.each(["example.com", "google.com", "github.com", "1.1.1.1", "8.8.8.8"])(
      'allows public hostname: "%s"',
      (hostname) => {
        expect(isBlockedHostname(hostname)).toBe(false);
      },
    );
  });

  describe("edge cases", () => {
    it("handles IPv6 without brackets", () => {
      // ::1 without brackets is not in the exact blocklist
      expect(isBlockedHostname("::1")).toBe(false);
    });

    it("handles empty string", () => {
      expect(isBlockedHostname("")).toBe(false);
    });

    it("handles hostnames that start with blocked prefix but are different", () => {
      expect(isBlockedHostname("10example.com")).toBe(false);
      expect(isBlockedHostname("192.168example.com")).toBe(false);
    });
  });
});

// ─── validateUrlForSsrf ───────────────────────────────────────────────────────

describe("validateUrlForSsrf", () => {
  describe("valid public URLs", () => {
    it("accepts a valid http URL", async () => {
      mockedResolve4.mockResolvedValue(["93.184.216.34"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      const result = await validateUrlForSsrf("http://example.com/path");
      expect(result.hostname).toBe("example.com");
    });

    it("accepts a valid https URL", async () => {
      mockedResolve4.mockResolvedValue(["93.184.216.34"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      const result = await validateUrlForSsrf("https://example.com/path");
      expect(result.hostname).toBe("example.com");
    });

    it("accepts URLs with ports", async () => {
      mockedResolve4.mockResolvedValue(["93.184.216.34"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      const result = await validateUrlForSsrf("https://example.com:8080/path");
      expect(result.hostname).toBe("example.com");
    });

    it("accepts URLs with query strings", async () => {
      mockedResolve4.mockResolvedValue(["93.184.216.34"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      const result = await validateUrlForSsrf("https://example.com/path?q=1");
      expect(result.hostname).toBe("example.com");
    });
  });

  describe("blocked hostnames throw", () => {
    it.each(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])(
      'throws for blocked hostname: "%s"',
      async (hostname) => {
        await expect(validateUrlForSsrf(`http://${hostname}/path`)).rejects.toThrow(/Blocked/);
      },
    );

    it("throws for 10.x.x.x addresses", async () => {
      await expect(validateUrlForSsrf("http://10.0.0.1/path")).rejects.toThrow(/Blocked/);
    });

    it("throws for 192.168.x.x addresses", async () => {
      await expect(validateUrlForSsrf("http://192.168.1.1/path")).rejects.toThrow(/Blocked/);
    });
  });

  describe("IPv6 address literals throw", () => {
    it("throws for IPv6 loopback [::1]", async () => {
      await expect(validateUrlForSsrf("http://[::1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv4-mapped IPv6 in hex format [::ffff:7f00:1] (127.0.0.1)", async () => {
      await expect(validateUrlForSsrf("http://[::ffff:7f00:1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv4-mapped IPv6 in dotted-decimal [::ffff:127.0.0.1]", async () => {
      await expect(validateUrlForSsrf("http://[::ffff:127.0.0.1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv4-mapped IPv6 hex format [::ffff:a00:1] (10.0.0.1)", async () => {
      await expect(validateUrlForSsrf("http://[::ffff:a00:1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv4-mapped IPv6 hex format [::ffff:c0a8:1] (192.168.0.1)", async () => {
      await expect(validateUrlForSsrf("http://[::ffff:c0a8:1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv6 link-local [fe80::1]", async () => {
      await expect(validateUrlForSsrf("http://[fe80::1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    describe("fe80::/10 link-local range detection", () => {
      it("detects fe80::1 as private (base of range)", async () => {
        await expect(validateUrlForSsrf("http://[fe80::1]/path")).rejects.toThrow(
          /Blocked.*IPv6.*internal/,
        );
      });

      it("detects fe8f::1 as private (mid-range)", async () => {
        await expect(validateUrlForSsrf("http://[fe8f::1]/path")).rejects.toThrow(
          /Blocked.*IPv6.*internal/,
        );
      });

      it("detects fe90::1 as private", async () => {
        await expect(validateUrlForSsrf("http://[fe90::1]/path")).rejects.toThrow(
          /Blocked.*IPv6.*internal/,
        );
      });

      it("detects fea0::1 as private", async () => {
        await expect(validateUrlForSsrf("http://[fea0::1]/path")).rejects.toThrow(
          /Blocked.*IPv6.*internal/,
        );
      });

      it("detects febf::1 as private (upper bound)", async () => {
        await expect(validateUrlForSsrf("http://[febf::1]/path")).rejects.toThrow(
          /Blocked.*IPv6.*internal/,
        );
      });

      it("does NOT detect fec0::1 as private (just above range)", async () => {
        mockedResolve4.mockRejectedValue(new Error("No records"));
        mockedResolve6.mockResolvedValue(["2001:db8::1"]);
        // fec0::1 is NOT link-local; it should not be blocked by the literal check
        // but DNS will resolve so we just verify it doesn't throw for the literal
        // Since fec0::1 is passed as a literal IP, no DNS lookup — it should be allowed
        const result = await validateUrlForSsrf("http://[fec0::1]/path");
        expect(result.hostname).toBe("[fec0::1]");
      });

      it("does NOT detect fed0::1 as private", async () => {
        mockedResolve4.mockRejectedValue(new Error("No records"));
        mockedResolve6.mockResolvedValue(["2001:db8::1"]);
        const result = await validateUrlForSsrf("http://[fed0::1]/path");
        expect(result.hostname).toBe("[fed0::1]");
      });

      it("does NOT detect feff::1 as private", async () => {
        mockedResolve4.mockRejectedValue(new Error("No records"));
        mockedResolve6.mockResolvedValue(["2001:db8::1"]);
        const result = await validateUrlForSsrf("http://[feff::1]/path");
        expect(result.hostname).toBe("[feff::1]");
      });
    });

    it("throws for IPv6 unique local [fd00::1]", async () => {
      await expect(validateUrlForSsrf("http://[fd00::1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("throws for IPv6 unique local [fc00::1]", async () => {
      await expect(validateUrlForSsrf("http://[fc00::1]/path")).rejects.toThrow(
        /Blocked.*IPv6.*internal/,
      );
    });

    it("allows public IPv6 address literal", async () => {
      // 2606:2800:220:1:248:1893:25c8:1946 is example.com's IPv6
      mockedResolve4.mockRejectedValue(new Error("No records"));
      mockedResolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

      const result = await validateUrlForSsrf("http://[2606:2800:220:1:248:1893:25c8:1946]/path");
      expect(result.hostname).toBe("[2606:2800:220:1:248:1893:25c8:1946]");
    });
  });

  describe("malformed URLs throw", () => {
    it.each(["not-a-url", "", "://missing-scheme", "http://"])(
      'throws for malformed URL: "%s"',
      async (url) => {
        await expect(validateUrlForSsrf(url)).rejects.toThrow(/Invalid URL/);
      },
    );
  });

  describe("non-HTTP schemes rejected", () => {
    it.each(["ftp://example.com/file", "file:///etc/passwd", "data:text/html,<h1>hi"])(
      'rejects non-HTTP scheme: "%s"',
      async (url) => {
        await expect(validateUrlForSsrf(url)).rejects.toThrow(/scheme must be http or https/);
      },
    );
  });

  describe("DNS rebinding protection", () => {
    it("throws when DNS resolves to a private IP", async () => {
      mockedResolve4.mockResolvedValue(["10.0.0.1"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      await expect(validateUrlForSsrf("http://dns-rebind.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });

    it("throws when DNS resolves to a 127.x.x.x IP", async () => {
      mockedResolve4.mockResolvedValue(["127.0.0.1"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      await expect(validateUrlForSsrf("http://loopback-dns.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });

    it("throws when DNS resolves to a 192.168.x.x IP", async () => {
      mockedResolve4.mockResolvedValue(["192.168.1.100"]);
      mockedResolve6.mockRejectedValue(new Error("No records"));

      await expect(validateUrlForSsrf("http://private-dns.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });

    it("throws when IPv6 DNS resolves to ::1", async () => {
      mockedResolve4.mockRejectedValue(new Error("No records"));
      mockedResolve6.mockResolvedValue(["::1"]);

      await expect(validateUrlForSsrf("http://ipv6-loopback.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });

    it("throws when IPv6 DNS resolves to fe80:: link-local", async () => {
      mockedResolve4.mockRejectedValue(new Error("No records"));
      mockedResolve6.mockResolvedValue(["fe80::1"]);

      await expect(validateUrlForSsrf("http://linklocal-ipv6.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });

    it("throws when IPv6 DNS resolves to IPv4-mapped private address", async () => {
      mockedResolve4.mockRejectedValue(new Error("No records"));
      mockedResolve6.mockResolvedValue(["::ffff:10.0.0.1"]);

      await expect(validateUrlForSsrf("http://mapped-ipv6.example.com/")).rejects.toThrow(
        /resolved IP.*internal/,
      );
    });
  });
});

// ─── isBlockedByDns ───────────────────────────────────────────────────────────

describe("isBlockedByDns", () => {
  it("returns false when DNS resolves to public IPs", async () => {
    mockedResolve4.mockResolvedValue(["93.184.216.34"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    expect(await isBlockedByDns("example.com")).toBe(false);
  });

  it("returns true when DNS resolves to a private IPv4", async () => {
    mockedResolve4.mockResolvedValue(["10.0.0.1"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    expect(await isBlockedByDns("internal.example.com")).toBe(true);
  });

  it("returns true when DNS resolves to a private IPv6", async () => {
    mockedResolve4.mockRejectedValue(new Error("No records"));
    mockedResolve6.mockResolvedValue(["fd00::1"]);

    expect(await isBlockedByDns("internal-ipv6.example.com")).toBe(true);
  });

  it("throws when all DNS queries fail", async () => {
    mockedResolve4.mockRejectedValue(new Error("SERVFAIL"));
    mockedResolve6.mockRejectedValue(new Error("SERVFAIL"));

    await expect(isBlockedByDns("unresolvable.example.com")).rejects.toThrow(
      "could not resolve hostname",
    );
  });

  it("checks both IPv4 and IPv6 results", async () => {
    mockedResolve4.mockResolvedValue(["93.184.216.34"]);
    mockedResolve6.mockResolvedValue(["::1"]);

    expect(await isBlockedByDns("dual-stack.example.com")).toBe(true);
  });

  it("returns true when IPv4 resolves to 169.254.x.x", async () => {
    mockedResolve4.mockResolvedValue(["169.254.169.254"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    expect(await isBlockedByDns("linklocal.example.com")).toBe(true);
  });

  it("returns true when IPv4 resolves to 0.x.x.x", async () => {
    mockedResolve4.mockResolvedValue(["0.0.0.0"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    expect(await isBlockedByDns("zero.example.com")).toBe(true);
  });

  it("returns false when IPv4 fails but IPv6 succeeds with public IP", async () => {
    mockedResolve4.mockRejectedValue(new Error("No records"));
    mockedResolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

    expect(await isBlockedByDns("ipv6-only.example.com")).toBe(false);
  });

  it("returns true when IPv4 fails but IPv6 resolves to private IP", async () => {
    mockedResolve4.mockRejectedValue(new Error("No records"));
    mockedResolve6.mockResolvedValue(["fd00::1"]);

    expect(await isBlockedByDns("ipv6-private.example.com")).toBe(true);
  });

  it("returns false when IPv4 has invalid hex segment", async () => {
    // 0xZZ is not a valid hex IP segment — parseIPSegment returns null,
    // making isPrivateIPv4 return false for the entire IP
    mockedResolve4.mockResolvedValue(["0xZZ.0.0.1"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    expect(await isBlockedByDns("invalid-hex.example.com")).toBe(false);
  });
});

// ─── validateRedirectForSsrf ──────────────────────────────────────────────────

describe("validateRedirectForSsrf", () => {
  const fromUrl = new URL("https://example.com/page");

  it("allows redirect to a public URL", async () => {
    mockedResolve4.mockResolvedValue(["93.184.216.34"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    const toUrl = new URL("https://public-site.com/redirect");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).resolves.toBeUndefined();
  });

  it("rejects redirect to http://127.0.0.1", async () => {
    const toUrl = new URL("http://127.0.0.1/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(/Blocked.*internal/);
  });

  it("rejects redirect to http://localhost", async () => {
    const toUrl = new URL("http://localhost/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(/Blocked.*internal/);
  });

  it("rejects redirect to ftp:// scheme", async () => {
    const toUrl = new URL("ftp://example.com/file");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(
      /scheme must be http or https/,
    );
  });

  it("rejects redirect to http://10.0.0.1", async () => {
    const toUrl = new URL("http://10.0.0.1/internal");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(/Blocked.*internal/);
  });

  it("rejects redirect to http://192.168.1.1", async () => {
    const toUrl = new URL("http://192.168.1.1/internal");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(/Blocked.*internal/);
  });

  it("rejects redirect when DNS resolves to private IP", async () => {
    mockedResolve4.mockResolvedValue(["10.0.0.5"]);
    mockedResolve6.mockRejectedValue(new Error("No records"));

    const toUrl = new URL("http://redirect.example.com/target");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(/Blocked.*internal/);
  });

  it("rejects redirect to IPv6 loopback [::1]", async () => {
    const toUrl = new URL("http://[::1]/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(
      /Blocked.*IPv6.*internal/,
    );
  });

  it("rejects redirect to IPv4-mapped IPv6 hex format [::ffff:7f00:1]", async () => {
    const toUrl = new URL("http://[::ffff:7f00:1]/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(
      /Blocked.*IPv6.*internal/,
    );
  });

  it("rejects redirect to IPv6 link-local [fe80::1]", async () => {
    const toUrl = new URL("http://[fe80::1]/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(
      /Blocked.*IPv6.*internal/,
    );
  });

  it("rejects redirect to IPv6 unique local [fd00::1]", async () => {
    const toUrl = new URL("http://[fd00::1]/secret");
    await expect(validateRedirectForSsrf(fromUrl, toUrl)).rejects.toThrow(
      /Blocked.*IPv6.*internal/,
    );
  });
});
