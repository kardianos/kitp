/// `OidcSession` orchestrates the authorization-code-with-PKCE flow:
/// build the authorize URL, store the verifier in sessionStorage, and
/// (after redirect) exchange the code for tokens.
///
/// We dynamically discover the OP's authorization_endpoint and
/// token_endpoint via /.well-known/openid-configuration so dex / Auth0 /
/// Okta all work without per-OP code.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '_session_storage_io.dart' if (dart.library.html) '_session_storage_html.dart' as ss;

import 'auth_state.dart';
import 'oidc_client.dart';

class OidcSession {
  final OidcConfig config;
  final AuthState authState;
  final http.Client httpClient;

  Map<String, dynamic>? _disco;
  Timer? _refreshTimer;

  OidcSession({
    required this.config,
    required this.authState,
    http.Client? httpClient,
  }) : httpClient = httpClient ?? http.Client();

  /// Discover (or return cached) OP metadata. Fetched once per session.
  Future<Map<String, dynamic>> discover() async {
    if (_disco != null) return _disco!;
    final url = '${config.issuer.replaceAll(RegExp(r"/$"), "")}/.well-known/openid-configuration';
    final resp = await httpClient.get(Uri.parse(url));
    if (resp.statusCode != 200) {
      throw StateError('oidc discovery failed: ${resp.statusCode}');
    }
    _disco = jsonDecode(resp.body) as Map<String, dynamic>;
    return _disco!;
  }

  /// Begin the login flow: stash a verifier in sessionStorage, then
  /// redirect the browser to the authorize URL. Never returns (on web).
  Future<void> beginLogin() async {
    final disco = await discover();
    final verifier = generateCodeVerifier();
    final challenge = codeChallengeS256(verifier);
    final state = generateState();

    ss.setItem('kitp_oidc_verifier', verifier);
    ss.setItem('kitp_oidc_state', state);

    final authEndpoint = disco['authorization_endpoint'] as String;
    final url = buildAuthorizeUri(
      authorizationEndpoint: authEndpoint,
      config: config,
      state: state,
      codeChallenge: challenge,
    );
    ss.assignLocation(url.toString());
  }

  /// Exchange the authorization code for tokens. Reads the verifier back
  /// out of sessionStorage; clears it on success.
  Future<void> handleCallback({required String code, required String state}) async {
    final storedState = ss.getItem('kitp_oidc_state');
    if (storedState == null || storedState != state) {
      throw StateError('oidc state mismatch');
    }
    final verifier = ss.getItem('kitp_oidc_verifier');
    if (verifier == null) {
      throw StateError('oidc verifier missing from sessionStorage');
    }
    final disco = await discover();
    final tokenEndpoint = disco['token_endpoint'] as String;
    final resp = await httpClient.post(
      Uri.parse(tokenEndpoint),
      headers: const {'Content-Type': 'application/x-www-form-urlencoded'},
      body: {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': config.redirectUri,
        'client_id': config.clientId,
        'code_verifier': verifier,
      },
    );
    if (resp.statusCode != 200) {
      throw StateError('token exchange failed: ${resp.statusCode} ${resp.body}');
    }
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    _applyTokenResponse(body);
    // Cleanup the verifier — it's a one-shot value.
    ss.removeItem('kitp_oidc_verifier');
    ss.removeItem('kitp_oidc_state');
  }

  /// Use the refresh_token to rotate. Returns true on success.
  Future<bool> refresh() async {
    final rt = authState.refreshToken;
    if (rt == null || rt.isEmpty) return false;
    final disco = await discover();
    final tokenEndpoint = disco['token_endpoint'] as String;
    try {
      final resp = await httpClient.post(
        Uri.parse(tokenEndpoint),
        headers: const {'Content-Type': 'application/x-www-form-urlencoded'},
        body: {
          'grant_type': 'refresh_token',
          'refresh_token': rt,
          'client_id': config.clientId,
        },
      );
      if (resp.statusCode != 200) return false;
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      _applyTokenResponse(body);
      return true;
    } catch (_) {
      return false;
    }
  }

  void _applyTokenResponse(Map<String, dynamic> body) {
    final access = body['access_token'] as String?;
    final refresh = body['refresh_token'] as String?;
    final id = body['id_token'] as String?;
    final expiresIn = (body['expires_in'] as num?)?.toInt() ?? 600;
    final expiresAt = DateTime.now().add(Duration(seconds: expiresIn));
    if (access == null) {
      throw StateError('token response missing access_token');
    }
    authState.setTokens(
      accessToken: access,
      refreshToken: refresh,
      idToken: id,
      expiresAt: expiresAt,
    );
    _scheduleRefresh(expiresAt);
  }

  /// Schedule a refresh ~30 seconds before expiry. Cancels any prior timer.
  void _scheduleRefresh(DateTime expiresAt) {
    _refreshTimer?.cancel();
    final until = expiresAt.difference(DateTime.now()) - const Duration(seconds: 30);
    if (until.isNegative) return;
    _refreshTimer = Timer(until, () async {
      final ok = await refresh();
      if (!ok) authState.signOut();
    });
  }

  /// Cancel timers; call from app dispose.
  void dispose() {
    _refreshTimer?.cancel();
  }
}
