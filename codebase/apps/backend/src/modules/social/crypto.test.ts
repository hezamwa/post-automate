import { describe, expect, it } from "vitest";
import { open, seal } from "./crypto";

// NFR-11.8: tokens are sealed at rest; only the right key opens them.
const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("social token sealing", () => {
  it("round-trips, and never stores the plaintext", async () => {
    const k = key();
    const sealed = await seal(k, "secret-access-token");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("secret-access-token");
    expect(await seal(k, "secret-access-token")).not.toBe(sealed); // fresh IV every time
    expect(await open(k, sealed)).toBe("secret-access-token");
  });

  it("refuses the wrong key, a missing key and a short key", async () => {
    const sealed = await seal(key(), "t");
    await expect(open(key(), sealed)).rejects.toThrow();
    await expect(seal(undefined, "t")).rejects.toThrow(/SOCIAL_TOKEN_KEY is not set/);
    await expect(seal(btoa("short"), "t")).rejects.toThrow(/32 random bytes/);
  });
});
