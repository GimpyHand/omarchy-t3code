const SENSITIVE_KEY = /(?:access|refresh|identity|subject|bearer|authorization|credential|secret|token|proof|verifier|private.?key|code)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// Real bearer/DPoP credentials are long opaque values or JWTs. Requiring a
// credential-sized value avoids redacting harmless prose. The negative
// lookahead also preserves security terminology that can legitimately follow
// "Bearer" or "DPoP" in user-facing diagnostics.
const AUTH_HEADER =
  /\b(?:Bearer|DPoP)\s+(?!(?:token|access-credential|authorization|credential|proof)\b)[A-Za-z0-9._~+\/-]{16,}={0,2}/gi;

export function redactText(input: unknown): string {
  const text = input instanceof Error ? input.message : String(input);
  return text.replace(AUTH_HEADER, "[REDACTED]").replace(JWT, "[REDACTED]");
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry);
    }
    return output;
  }
  return typeof value === "string" ? redactText(value) : value;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(redactText(message));
    this.name = "BridgeError";
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  return new BridgeError("INTERNAL_ERROR", redactText(error), false);
}
