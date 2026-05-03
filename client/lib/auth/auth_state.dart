/// `AuthState` is a `ChangeNotifier` holding tokens + parsed claims in
/// memory only (never localStorage). Any UI bit that wants to react to
/// sign-in / sign-out (Admin nav link, top-nav user chip) listens to it.
///
/// On sign-in, dispatcher widgets attach `Authorization: Bearer <access>`
/// to every `POST /api/v1/batch`. On 401 the dispatcher forces a token
/// refresh; on a second 401 we clear the state and route to login.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

class AuthState extends ChangeNotifier {
  String? _accessToken;
  String? _refreshToken;
  String? _idToken;
  Map<String, dynamic> _claims = const {};
  DateTime? _expiresAt;

  String? get accessToken => _accessToken;
  String? get refreshToken => _refreshToken;
  String? get idToken => _idToken;
  Map<String, dynamic> get claims => _claims;
  DateTime? get expiresAt => _expiresAt;

  bool get isSignedIn => _accessToken != null;

  /// The display name we show in the nav. Falls back to the sub if the
  /// preferred_username / name / email claims are all missing.
  String? get displayName {
    final name = _claims['name'] as String?;
    if (name != null && name.isNotEmpty) return name;
    final preferred = _claims['preferred_username'] as String?;
    if (preferred != null && preferred.isNotEmpty) return preferred;
    final email = _claims['email'] as String?;
    if (email != null && email.isNotEmpty) return email;
    return _claims['sub'] as String?;
  }

  /// Group claim values (typically "kitp.admin", "kitp.manager", …). Used
  /// by the admin nav gate. Returns an empty list when the claim is
  /// missing or non-list.
  List<String> get groups {
    final raw = _claims['groups'];
    if (raw is List) {
      return [for (final r in raw) if (r is String) r];
    }
    return const [];
  }

  /// True when the signed-in user looks like an admin via their group
  /// claim (the conventional `kitp.admin` mapping). Server-side admin
  /// gating still applies — this is only a UI affordance gate.
  bool get isAdmin => groups.contains('kitp.admin');

  /// Update tokens after a successful token-endpoint exchange.
  void setTokens({
    required String accessToken,
    String? refreshToken,
    String? idToken,
    required DateTime expiresAt,
  }) {
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    _idToken = idToken;
    _expiresAt = expiresAt;
    _claims = idToken != null ? _decodeClaims(idToken) : const {};
    notifyListeners();
  }

  /// Wipe state — logout or rotation failure.
  void signOut() {
    _accessToken = null;
    _refreshToken = null;
    _idToken = null;
    _claims = const {};
    _expiresAt = null;
    notifyListeners();
  }
}

/// Decode a JWT's payload section into a map. JWT format is
/// `header.payload.signature` — base64url-encoded. We only read the
/// payload; signature verification happens server-side.
Map<String, dynamic> _decodeClaims(String jwt) {
  final parts = jwt.split('.');
  if (parts.length < 2) return const {};
  var payload = parts[1];
  // base64Url.decode requires padding to a multiple of 4.
  final mod = payload.length % 4;
  if (mod != 0) {
    payload = payload + ('=' * (4 - mod));
  }
  try {
    final raw = utf8.decode(base64Url.decode(payload));
    final m = jsonDecode(raw);
    if (m is Map<String, dynamic>) return m;
  } catch (_) {
    // Malformed token; fall through.
  }
  return const {};
}
