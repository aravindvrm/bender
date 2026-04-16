import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API_PORT, isPortExplicitlyConfigured, resolveServerPort } from "../../src/cli/server-config.js";

const originalBenderPort = process.env.BENDER_PORT;
const originalPort = process.env.PORT;

afterEach(() => {
  if (originalBenderPort === undefined) {
    delete process.env.BENDER_PORT;
  } else {
    process.env.BENDER_PORT = originalBenderPort;
  }

  if (originalPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = originalPort;
  }
});

describe("cli/server-config", () => {
  it("returns explicit function argument when valid", () => {
    process.env.BENDER_PORT = "4510";
    process.env.PORT = "4520";
    expect(resolveServerPort(4600)).toBe(4600);
  });

  it("prefers BENDER_PORT over PORT", () => {
    process.env.BENDER_PORT = "4510";
    process.env.PORT = "4520";
    expect(resolveServerPort()).toBe(4510);
  });

  it("uses PORT when BENDER_PORT is not set", () => {
    delete process.env.BENDER_PORT;
    process.env.PORT = "4520";
    expect(resolveServerPort()).toBe(4520);
  });

  it("falls back to default when env ports are missing/invalid", () => {
    process.env.BENDER_PORT = "not-a-port";
    process.env.PORT = "70000";
    expect(resolveServerPort()).toBe(DEFAULT_API_PORT);
  });

  it("tracks whether a port was explicitly configured", () => {
    delete process.env.BENDER_PORT;
    delete process.env.PORT;
    expect(isPortExplicitlyConfigured()).toBe(false);

    process.env.PORT = "5555";
    expect(isPortExplicitlyConfigured()).toBe(true);
  });
});
