/**
 * Error thrown when WHOOP's token endpoint answers a refresh with a non-2xx
 * status. Kept in its own module so callers can classify it without importing
 * the whole OAuth flow.
 */

/**
 * Shape of an OAuth 2.0 error code (RFC 6749 §5.2), e.g. "invalid_grant".
 * Anything else in the response's `error` field is ignored, so the error never
 * carries free text from the response body.
 */
const OAUTH_ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

/** The OAuth error code in `value`, or undefined when it is not one. */
export function parseOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && OAUTH_ERROR_CODE_PATTERN.test(value) ? value : undefined;
}

/** WHOOP's token endpoint refused a refresh request */
export class TokenRefreshError extends Error {
  public override readonly name = "TokenRefreshError";

  /**
   * The OAuth `error` code from the token response (e.g. "invalid_grant",
   * "invalid_client"), or undefined when the response had none.
   */
  public readonly oauthError: string | undefined;

  constructor(
    public readonly statusCode: number,
    description: string,
    oauthError?: string
  ) {
    super(`Token refresh failed (${statusCode}): ${description}`);
    this.oauthError = parseOAuthErrorCode(oauthError);
  }

  /**
   * WHOOP rejected the refresh token itself (invalid_grant and friends), as
   * opposed to a transient 429/5xx after which the same token still works.
   * An invalid_client answer rejects this app's client credentials instead:
   * the refresh token (and so the user's sign-in) is still valid.
   */
  get rejected(): boolean {
    return (this.statusCode === 400 || this.statusCode === 401) && !this.clientRejected;
  }

  /**
   * WHOOP rejected this app's client credentials (WHOOP_CLIENT_ID and
   * WHOOP_CLIENT_SECRET), not the user's refresh token.
   */
  get clientRejected(): boolean {
    return this.oauthError === "invalid_client";
  }
}
