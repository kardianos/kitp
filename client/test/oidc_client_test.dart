/// Tests for the OIDC PKCE primitives and dispatcher header injection.
import 'dart:convert';

import 'package:client/auth/auth_state.dart';
import 'package:client/auth/oidc_client.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('PKCE', () {
    test('verifier is 43..128 base64url chars', () {
      for (var i = 0; i < 50; i++) {
        final v = generateCodeVerifier();
        expect(v.length, greaterThanOrEqualTo(43));
        expect(v.length, lessThanOrEqualTo(128));
        expect(v, matches(RegExp(r'^[A-Za-z0-9_-]+$')));
      }
    });

    test('S256 challenge is sha256(verifier) base64url', () {
      // Test vector from RFC 7636 §4.1: verifier
      //   "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" produces challenge
      //   "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
      final verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(codeChallengeS256(verifier),
          'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    test('state value is base64url', () {
      final s = generateState();
      expect(s, matches(RegExp(r'^[A-Za-z0-9_-]+$')));
    });

    test('authorize URL includes pkce + scope', () {
      final cfg = OidcConfig(
        issuer: 'https://op.example',
        clientId: 'kitp-web',
        redirectUri: 'https://app.example/auth/callback',
        scopes: 'openid profile',
      );
      final url = buildAuthorizeUri(
        authorizationEndpoint: 'https://op.example/auth',
        config: cfg,
        state: 's',
        codeChallenge: 'cc',
      );
      expect(url.queryParameters['response_type'], 'code');
      expect(url.queryParameters['client_id'], 'kitp-web');
      expect(url.queryParameters['redirect_uri'],
          'https://app.example/auth/callback');
      expect(url.queryParameters['scope'], 'openid profile');
      expect(url.queryParameters['state'], 's');
      expect(url.queryParameters['code_challenge'], 'cc');
      expect(url.queryParameters['code_challenge_method'], 'S256');
    });
  });

  group('AuthState', () {
    test('isSignedIn reflects token presence', () {
      final s = AuthState();
      expect(s.isSignedIn, isFalse);
      // jwt with payload {"sub":"x","name":"X","groups":["kitp.admin"]}
      const payload = '{"sub":"x","name":"X","groups":["kitp.admin"]}';
      final p64 =
          base64Url.encode(payload.codeUnits).replaceAll('=', '');
      final jwt = 'h.$p64.s';
      s.setTokens(
        accessToken: 'a',
        refreshToken: 'r',
        idToken: jwt,
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      expect(s.isSignedIn, isTrue);
      expect(s.displayName, 'X');
      expect(s.groups, contains('kitp.admin'));
      expect(s.isAdmin, isTrue);
      s.signOut();
      expect(s.isSignedIn, isFalse);
      expect(s.isAdmin, isFalse);
    });
  });

  group('Dispatcher auth header', () {
    Dispatcher build({
      required MockClient client,
      AuthState? auth,
      Future<bool> Function()? onUnauth,
    }) {
      final reg = HandlerRegistry();
      registerBuiltInHandlers(reg);
      return Dispatcher(
        httpClient: client,
        registry: reg,
        apiBase: 'http://test.invalid',
        scheduleFlush: (flush) => Future.microtask(flush),
        authState: auth,
        onUnauthorized: onUnauth,
      );
    }

    test('attaches Authorization header when signed in', () async {
      String? seenAuth;
      final mock = MockClient((req) async {
        seenAuth = req.headers['Authorization'];
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        final subs = body['subrequests'] as List;
        final id = (subs.first as Map)['id'] as String;
        return http.Response(jsonEncode({
          'subresponses': [
            {'id': id, 'ok': true, 'data': {'x': 1, 'message': 'ok'}}
          ]
        }), 200);
      });
      final auth = AuthState();
      auth.setTokens(
        accessToken: 'tok-abc',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      final d = build(client: mock, auth: auth);
      await d.request<EchoPingInput, EchoPingOutput>(
        endpoint: 'echo',
        action: 'ping',
        data: const EchoPingInput(x: 1, message: 'hi'),
      );
      expect(seenAuth, 'Bearer tok-abc');
    });

    test('no Authorization header when signed out', () async {
      String? seenAuth;
      final mock = MockClient((req) async {
        seenAuth = req.headers['Authorization'];
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        final id = ((body['subrequests'] as List).first as Map)['id'] as String;
        return http.Response(jsonEncode({
          'subresponses': [
            {'id': id, 'ok': true, 'data': {'x': 1, 'message': 'ok'}}
          ]
        }), 200);
      });
      final d = build(client: mock); // no auth state
      await d.request<EchoPingInput, EchoPingOutput>(
        endpoint: 'echo',
        action: 'ping',
        data: const EchoPingInput(x: 1, message: 'hi'),
      );
      expect(seenAuth, isNull);
    });

    test('401 triggers refresh + retry', () async {
      var calls = 0;
      final mock = MockClient((req) async {
        calls++;
        if (calls == 1) {
          return http.Response('', 401);
        }
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        final id = ((body['subrequests'] as List).first as Map)['id'] as String;
        return http.Response(jsonEncode({
          'subresponses': [
            {'id': id, 'ok': true, 'data': {'x': 9, 'message': 'ok'}}
          ]
        }), 200);
      });
      final auth = AuthState();
      auth.setTokens(
        accessToken: 'old',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      var refreshed = 0;
      final d = build(
        client: mock,
        auth: auth,
        onUnauth: () async {
          refreshed++;
          auth.setTokens(
            accessToken: 'new',
            expiresAt: DateTime.now().add(const Duration(hours: 1)),
          );
          return true;
        },
      );
      final out = await d.request<EchoPingInput, EchoPingOutput>(
        endpoint: 'echo',
        action: 'ping',
        data: const EchoPingInput(x: 9, message: 'hi'),
      );
      expect(out.x, 9);
      expect(calls, 2);
      expect(refreshed, 1);
    });
  });
}
