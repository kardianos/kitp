/// Non-web implementation of the session-storage shim. The browser code
/// path is in `_session_storage_html.dart`; conditional imports pick which
/// file to use at compile time. The IO version exists so the codebase can
/// run under `flutter test` (VM target) without dragging in dart:html.
library;

final Map<String, String> _store = {};

void setItem(String k, String v) => _store[k] = v;
String? getItem(String k) => _store[k];
void removeItem(String k) => _store.remove(k);

void assignLocation(String url) {
  // Test target — no actual navigation. The OIDC redirect is invoked from
  // the browser only; in tests we never reach this code path because the
  // login screen is never built without an OidcSession that wraps a
  // mocked http client.
}
