/**
 * Wire-shape value types for one sub-request and one sub-response.
 *
 * Mirrors REQUIREMENTS.md §4.1 N-API-2/3. The `data` field is intentionally
 * untyped at this layer — the {@link Dispatcher} handles encode/decode of the
 * typed payloads via the handler registry.
 */

/** One element in the batched request body sent to `POST /api/v1/batch`. */
export interface SubRequest {
  /** Client-supplied correlation id (UUID v4). */
  id: string;
  /** `data | action | query` per the requirements. */
  type: string;
  endpoint: string;
  action: string;
  ref: Record<string, unknown>;
  key: Record<string, unknown>;
  /** JSON-encodable payload, or `null` for handlers that take no input. */
  data: unknown;
}

/** Per-subresponse error envelope. */
export interface SubError {
  code: string;
  message: string;
  /**
   * Optional structured payload the server carries over from
   * `reg.HandlerError.Detail`. Gate 5 (FLOW_AND_SCREEN_KERNEL §V13) uses
   * this for the positive-feedback rejection envelope on
   * `flow_disallowed` / `flow_role_required` — see
   * `client/src/ui/widgets/TransitionBar.svelte`. Other handlers may
   * leave it absent.
   */
  detail?: unknown;
}

/** One element in the batched response body. */
export interface SubResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: SubError;
}

/**
 * Encode a {@link SubRequest} for the wire. Mirrors the Dart `toJson` —
 * empty `ref`/`key` are omitted, and `data: null` is omitted.
 */
export function subRequestToJson(s: SubRequest): Record<string, unknown> {
  const m: Record<string, unknown> = {
    id: s.id,
    type: s.type,
    endpoint: s.endpoint,
    action: s.action,
  };
  if (Object.keys(s.ref).length > 0) m.ref = s.ref;
  if (Object.keys(s.key).length > 0) m.key = s.key;
  if (s.data !== null && s.data !== undefined) m.data = s.data;
  return m;
}

/** Permissive parser for a single sub-response from the server. */
export function subResponseFromJson(raw: Record<string, unknown>): SubResponse {
  let error: SubError | undefined;
  const e = raw['error'];
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    error = {
      code: typeof obj['code'] === 'string' ? (obj['code'] as string) : '',
      message: typeof obj['message'] === 'string' ? (obj['message'] as string) : '',
    };
    if (obj['detail'] !== undefined && obj['detail'] !== null) {
      error.detail = obj['detail'];
    }
  }
  const out: SubResponse = {
    id: typeof raw['id'] === 'string' ? (raw['id'] as string) : '',
    ok: raw['ok'] === true,
    data: raw['data'],
  };
  if (error !== undefined) out.error = error;
  return out;
}
