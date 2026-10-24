import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// FR-2.2 / NFR-11.x. PBKDF2 via WebCrypto — these tests run on the Workers pool so
// they exercise the same crypto implementation production uses.
describe("password hashing (FR-2.2)", () => {
  it("verifies a correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password, including a case difference", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("stores the documented pbkdf2$iterations$salt$hash format", async () => {
    const [scheme, iterations, salt, hash] = (await hashPassword("pw")).split("$");
    expect(scheme).toBe("pbkdf2");
    expect(Number(iterations)).toBe(100_000);
    expect(atob(salt!)).toHaveLength(16);
    expect(atob(hash!)).toHaveLength(32);
  });

  it("salts each hash, so identical passwords never collide", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("returns false rather than throwing on a malformed stored value", async () => {
    for (const bad of ["", "not-a-hash", "pbkdf2$100000", "bcrypt$1$2$3", "pbkdf2$100000$$"]) {
      expect(await verifyPassword("pw", bad)).toBe(false);
    }
  });

  it("rejects a tampered hash segment", async () => {
    const stored = await hashPassword("pw");
    const parts = stored.split("$");
    parts[3] = btoa("x".repeat(32));
    expect(await verifyPassword("pw", parts.join("$"))).toBe(false);
  });

  it("handles unicode and long passwords", async () => {
    const pw = "كلمة السر طويلة جدا " + "x".repeat(500);
    const stored = await hashPassword(pw);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword(pw + "y", stored)).toBe(false);
  });
});
