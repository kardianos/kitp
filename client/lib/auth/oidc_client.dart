/// OIDC PKCE helpers.
///
/// Authorization Code + PKCE flow:
///   1. Client generates a 256-bit `code_verifier` (base64url-without-padding,
///      43..128 chars).
///   2. Client derives `code_challenge = base64url(sha256(verifier))`,
///      `code_challenge_method = S256`.
///   3. Verifier is stored in `sessionStorage` (NOT localStorage — refresh
///      kills the active session by design; we only want it to survive a
///      same-tab redirect).
///   4. On callback the client posts `code` + `verifier` to the OP's token
///      endpoint, gets back `id_token` / `access_token` / `refresh_token`,
///      and holds them in memory only.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;

/// Build-time configuration injected via `--dart-define`. When `issuer` is
/// empty the client falls back to dev-mode behavior (no login UI, no auth
/// header, dispatcher hits the API directly).
class OidcConfig {
  final String issuer;
  final String clientId;
  final String redirectUri;
  final String scopes;

  const OidcConfig({
    required this.issuer,
    required this.clientId,
    required this.redirectUri,
    required this.scopes,
  });

  /// Construct from `--dart-define` values. `KITP_OIDC_REDIRECT_URI` defaults
  /// to the app's own origin + `/auth/callback`; the caller passes
  /// `originFallback` (typically `Uri.base.origin`).
  factory OidcConfig.fromEnv({String? originFallback}) {
    const issuer = String.fromEnvironment('KITP_OIDC_ISSUER', defaultValue: '');
    const clientId = String.fromEnvironment('KITP_OIDC_CLIENT_ID', defaultValue: '');
    const redirect = String.fromEnvironment('KITP_OIDC_REDIRECT_URI', defaultValue: '');
    const scopes = String.fromEnvironment(
      'KITP_OIDC_SCOPES',
      defaultValue: 'openid profile email',
    );
    final r = redirect.isNotEmpty
        ? redirect
        : '${originFallback ?? ''}/auth/callback';
    return OidcConfig(
      issuer: issuer,
      clientId: clientId,
      redirectUri: r,
      scopes: scopes,
    );
  }

  /// True when the build was made without OIDC settings; the client should
  /// run in dev mode (no auth UI).
  bool get enabled => issuer.isNotEmpty && clientId.isNotEmpty;
}

/// Generate a PKCE code_verifier (43..128 chars of base64url-without-padding).
/// We use 32 random bytes -> 43-char base64url.
String generateCodeVerifier({Random? rng}) {
  final r = rng ?? Random.secure();
  final bytes = Uint8List(32);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = r.nextInt(256);
  }
  return base64UrlEncode(bytes).replaceAll('=', '');
}

/// Derive the S256 code_challenge for a verifier.
String codeChallengeS256(String verifier) {
  final hash = sha256.convert(utf8.encode(verifier)).bytes;
  return base64UrlEncode(hash).replaceAll('=', '');
}

/// Generate a random `state` value to bind the redirect to its initiator.
String generateState({Random? rng}) {
  final r = rng ?? Random.secure();
  final bytes = Uint8List(16);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = r.nextInt(256);
  }
  return base64UrlEncode(bytes).replaceAll('=', '');
}

/// Build the authorize URL given a config + verifier + state. The OP's
/// authorization_endpoint is the issuer + `/auth` for dex; we expect callers
/// to have discovered this. To keep the test-side helper synchronous we
/// accept the endpoint directly.
Uri buildAuthorizeUri({
  required String authorizationEndpoint,
  required OidcConfig config,
  required String state,
  required String codeChallenge,
}) {
  return Uri.parse(authorizationEndpoint).replace(queryParameters: {
    'response_type': 'code',
    'client_id': config.clientId,
    'redirect_uri': config.redirectUri,
    'scope': config.scopes,
    'state': state,
    'code_challenge': codeChallenge,
    'code_challenge_method': 'S256',
  });
}
