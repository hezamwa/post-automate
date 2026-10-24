// Node-pool stand-in for `cloudflare:workflows`: same name and shape as the real class,
// so `instanceof NonRetryableError` in the FakeStep matches what runStep throws.
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") {
    super(message);
    this.name = name;
  }
}
