let sequence = 0;

/**
 * Request identifiers must remain unique even in browsers without
 * crypto.randomUUID (older embedded WebViews and some test runners).
 */
export function createRequestId(prefix = "request"): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return `${prefix}-${cryptoObject.randomUUID()}`;
  }
  const values = typeof cryptoObject?.getRandomValues === "function"
    ? cryptoObject.getRandomValues(new Uint32Array(3))
    : null;
  sequence = (sequence + 1) % 0x1000000;
  const randomPart = values
    ? Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("")
    : `${Date.now().toString(16)}-${Math.random().toString(36).slice(2)}-${sequence.toString(16).padStart(6, "0")}`;
  return `${prefix}-${randomPart}`;
}
