import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from './verify-signature.js';

const SECRET = 'test-webhook-secret';
const OTHER_SECRET = 'a-different-webhook-secret';

/** A realistic GitHub `pull_request` webhook payload, kept as raw JSON text. */
const BODY = '{"action":"opened","pull_request":{"number":42}}';

/** Computes the hex HMAC-SHA256 GitHub would send for these exact bytes. */
function sign(body: Buffer | string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Builds a well-formed `sha256=<hex>` header for the given body. */
function signatureHeader(
  body: Buffer | string,
  secret: string = SECRET,
): string {
  return `sha256=${sign(body, secret)}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts the correct signature over a string body', () => {
    expect(verifyWebhookSignature(BODY, signatureHeader(BODY), SECRET)).toBe(
      true,
    );
  });

  it('accepts the correct signature when the same bytes arrive as a Buffer', () => {
    const buffer = Buffer.from(BODY, 'utf8');

    // Header signed over the string, body supplied as a Buffer.
    expect(verifyWebhookSignature(buffer, signatureHeader(BODY), SECRET)).toBe(
      true,
    );
    // Header signed over the Buffer, body supplied as a Buffer.
    expect(verifyWebhookSignature(buffer, signatureHeader(buffer), SECRET)).toBe(
      true,
    );
  });

  it('accepts a correctly signed empty body (exact boundary)', () => {
    const emptyBuffer = Buffer.alloc(0);

    expect(verifyWebhookSignature('', `sha256=${sign('')}`, SECRET)).toBe(true);
    expect(
      verifyWebhookSignature(emptyBuffer, `sha256=${sign(emptyBuffer)}`, SECRET),
    ).toBe(true);
  });

  it('rejects a body with one character changed', () => {
    // Exactly one byte differs from what was signed.
    const tampered = BODY.replace('"opened"', '"openeD"');
    expect(tampered).not.toBe(BODY);
    expect(tampered).toHaveLength(BODY.length);

    expect(verifyWebhookSignature(tampered, signatureHeader(BODY), SECRET)).toBe(
      false,
    );
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(
      verifyWebhookSignature(BODY, signatureHeader(BODY, OTHER_SECRET), SECRET),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
  });

  it('rejects a header with the wrong scheme prefix', () => {
    const digest = sign(BODY);

    expect(verifyWebhookSignature(BODY, `sha1=${digest}`, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, `sha512=${digest}`, SECRET)).toBe(false);
    // The same digest behind a missing prefix is also not acceptable.
    expect(verifyWebhookSignature(BODY, digest, SECRET)).toBe(false);
  });

  it('rejects a truncated digest', () => {
    const digest = sign(BODY);

    expect(
      verifyWebhookSignature(BODY, `sha256=${digest.slice(0, -1)}`, SECRET),
    ).toBe(false);
    expect(
      verifyWebhookSignature(BODY, `sha256=${digest.slice(0, 32)}`, SECRET),
    ).toBe(false);
    expect(verifyWebhookSignature(BODY, 'sha256=', SECRET)).toBe(false);
  });

  it('rejects a digest that is not valid hex', () => {
    const digest = sign(BODY);

    // 63 valid hex characters plus one non-hex character.
    expect(
      verifyWebhookSignature(BODY, `sha256=${digest.slice(0, -1)}z`, SECRET),
    ).toBe(false);
    // 64 characters, but a non-hex character in the middle.
    expect(
      verifyWebhookSignature(
        BODY,
        `sha256=${digest.slice(0, 10)}g${digest.slice(11)}`,
        SECRET,
      ),
    ).toBe(false);
    // Signing the digest itself does not make it a valid signature.
    expect(
      verifyWebhookSignature(BODY, `sha256=${digest.slice(0, 63)} `, SECRET),
    ).toBe(false);
  });

  it('rejects a well-formed digest that does not match the body', () => {
    expect(
      verifyWebhookSignature(BODY, `sha256=${'0'.repeat(64)}`, SECRET),
    ).toBe(false);
  });

  it('accepts an uppercase hex digest and uppercase scheme', () => {
    const digest = sign(BODY);

    expect(
      verifyWebhookSignature(BODY, `SHA256=${digest.toUpperCase()}`, SECRET),
    ).toBe(true);
    expect(
      verifyWebhookSignature(BODY, `Sha256=${digest.toUpperCase()}`, SECRET),
    ).toBe(true);
  });

  it('rejects a header with extra internal whitespace', () => {
    const digest = sign(BODY);

    // Whitespace splitting the hex digest in half.
    expect(
      verifyWebhookSignature(
        BODY,
        `sha256=${digest.slice(0, 32)} ${digest.slice(32)}`,
        SECRET,
      ),
    ).toBe(false);
    // Whitespace between the scheme and the digest.
    expect(verifyWebhookSignature(BODY, `sha256= ${digest}`, SECRET)).toBe(false);
  });

  it('matches multi-byte UTF-8 bodies byte for byte', () => {
    const unicodeBody = '{"note":"héllo – wörld 🚀"}';

    expect(
      verifyWebhookSignature(unicodeBody, signatureHeader(unicodeBody), SECRET),
    ).toBe(true);
    // The same text as UTF-8 bytes is the same body.
    expect(
      verifyWebhookSignature(
        Buffer.from(unicodeBody, 'utf8'),
        signatureHeader(unicodeBody),
        SECRET,
      ),
    ).toBe(true);
  });

  it('never throws for malformed or type-violating input', () => {
    const hostileInputs: Array<[Buffer | string, string | undefined, string]> = [
      [null as unknown as Buffer, signatureHeader(BODY), SECRET],
      [undefined as unknown as string, signatureHeader(BODY), SECRET],
      [BODY, null as unknown as string, SECRET],
      [BODY, signatureHeader(BODY), null as unknown as string],
      [BODY, '', ''],
      [BODY, 'sha256=', SECRET],
      [BODY, 'sha256=not-hex', SECRET],
      [BODY, ' ', SECRET],
      [BODY, 'sha256=é', SECRET],
    ];

    for (const [body, header, secret] of hostileInputs) {
      expect(() => verifyWebhookSignature(body, header, secret)).not.toThrow();
      expect(verifyWebhookSignature(body, header, secret)).toBe(false);
    }
  });
});
