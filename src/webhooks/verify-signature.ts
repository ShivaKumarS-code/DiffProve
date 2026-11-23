/**
 * Verifies GitHub's X-Hub-Signature-256 header against the raw request body.
 * Constant-time comparison; never throws; malformed input returns false.
 *
 * GitHub signs the raw request body bytes with HMAC-SHA256 using the App's
 * webhook secret and sends `sha256=<64 lowercase hex>` in the
 * `X-Hub-Signature-256` header. The body must therefore be hashed *before*
 * JSON parsing: re-serializing a parsed payload changes the bytes and breaks
 * the signature.
 *
 * The comparison runs the whole function inside a `try` so that no input —
 * including one that violates the TypeScript types at runtime — can throw to
 * the caller. Length mismatches are rejected with a plain `false` rather than
 * letting `crypto.timingSafeEqual` throw.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signature scheme prefix GitHub uses for SHA-256 digests. */
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verifies GitHub's X-Hub-Signature-256 header against the raw request body.
 * Constant-time comparison; never throws; malformed input returns false.
 *
 * @param rawBody Raw request bytes exactly as GitHub sent them. Strings are
 *   hashed as UTF-8, so `'a'` and `Buffer.from('a', 'utf8')` are equivalent.
 * @param signatureHeader Value of `X-Hub-Signature-256`, e.g.
 *   `sha256=ab12...`. The scheme name and hex digest are both matched
 *   case-insensitively.
 * @param secret The App's webhook secret.
 * @returns `true` only when the header carries a well-formed SHA-256 digest
 *   that matches the body; `false` for every other input.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  try {
    if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
      return false;
    }

    // Reject other schemes (`sha1=`, `sha512=`, ...): only HMAC-SHA256 is valid
    // for this header. The scheme name itself is case-insensitive.
    if (!signatureHeader.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
      return false;
    }

    // Lowercasing the hex part lets uppercase digests compare equal to the
    // lowercase digest we compute.
    const providedHex = signatureHeader
      .slice(SIGNATURE_PREFIX.length)
      .toLowerCase();

    // A SHA-256 digest is exactly 64 hex characters. This rejects truncated
    // digests, non-hex characters, and stray whitespace in one place.
    if (!/^[0-9a-f]{64}$/.test(providedHex)) {
      return false;
    }

    // Defensive runtime check: the signature admits only Buffer | string, but
    // untyped callers (e.g. Fastify with a custom body parser) could pass junk.
    if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
      return false;
    }

    const body =
      typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const expectedDigest = createHmac('sha256', secret).update(body).digest();
    const providedDigest = Buffer.from(providedHex, 'hex');

    // Unreachable after the 64-hex-character check above, but timingSafeEqual
    // throws on unequal lengths, so guard it explicitly instead of trusting
    // the earlier validation to stay in sync.
    if (providedDigest.length !== expectedDigest.length) {
      return false;
    }

    return timingSafeEqual(providedDigest, expectedDigest);
  } catch {
    // Never let malformed input (bad header, non-string secret, exotic body)
    // surface as an exception to the HTTP layer.
    return false;
  }
}
