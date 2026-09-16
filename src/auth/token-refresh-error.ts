/**
 * Error thrown when WHOOP's token endpoint answers a refresh with a non-2xx
 * status. Kept in its own module so callers can classify it without importing
 * the whole OAuth flow.
 */

/** WHOOP's token endpoint refused a refresh request */
export class TokenRefreshError extends Error {
  public override readonly name = "TokenRefreshError";

  constructor(
    public readonly statusCode: number,
    description: string
  ) {
    super(`Token refresh failed (${statusCode}): ${description}`);
  }

  /**
   * WHOOP rejected the refresh token itself (invalid_grant and friends), as
   * opposed to a transient 429/5xx after which the same token still works.
   */
  get rejected(): boolean {
    return this.statusCode === 400 || this.statusCode === 401;
  }
}
