/**
 * Typed errors surfaced by the dispatcher.
 *
 * Callers should pattern-match on the class instead of inspecting message
 * strings. `SubRequestError` means *this* sub-request failed; `BatchAbortedError`
 * means the whole batch never produced a usable result for this caller (HTTP
 * 4xx/5xx, network failure, malformed response, server-side `aborted`, or a
 * decode_error in this caller's own response).
 */

/**
 * Thrown when a per-sub-response `{ok:false, error:{code,message}}` envelope
 * arrives from the server. `aborted`-coded errors are mapped to
 * {@link BatchAbortedError} before this is thrown.
 */
export class SubRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SubRequestError';
    this.code = code;
    // Preserve the prototype chain across down-level transpilation.
    Object.setPrototypeOf(this, SubRequestError.prototype);
  }

  override toString(): string {
    return `SubRequestError(${this.code}, ${this.message})`;
  }
}

/**
 * Thrown when a sub-request's future is killed because the batch as a whole
 * never reached a usable state — HTTP 4xx/5xx, network failure, malformed
 * response, missing slot, server-side abort, or a decode_error.
 */
export class BatchAbortedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'BatchAbortedError';
    this.reason = reason;
    Object.setPrototypeOf(this, BatchAbortedError.prototype);
  }

  override toString(): string {
    return `BatchAbortedError(${this.reason})`;
  }
}
