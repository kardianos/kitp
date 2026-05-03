/// LoginScreen: a minimal "Sign in with <issuer-host>" splash. Tapping
/// the button redirects the browser to the OP's authorize URL via
/// [OidcSession.beginLogin].
library;

import 'package:flutter/material.dart';

import '../../auth/oidc_client.dart';
import '../../auth/oidc_session.dart';

class LoginScreen extends StatelessWidget {
  final OidcConfig config;
  final OidcSession session;

  const LoginScreen({
    super.key,
    required this.config,
    required this.session,
  });

  @override
  Widget build(BuildContext context) {
    final issuerHost = Uri.tryParse(config.issuer)?.host ?? config.issuer;
    return Scaffold(
      appBar: AppBar(title: const Text('kitp')),
      body: Center(
        child: Card(
          margin: const EdgeInsets.all(32),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Sign in to kitp', style: TextStyle(fontSize: 22)),
                const SizedBox(height: 16),
                Text(
                  'Authenticated by $issuerHost',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: () async {
                    await session.beginLogin();
                  },
                  child: Text('Sign in with $issuerHost'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// CallbackScreen: shown after the OP redirects back. It pulls `code` and
/// `state` out of the URL, calls [OidcSession.handleCallback], and routes
/// to `/projects` when done. On error it shows a small message + retry.
class CallbackScreen extends StatefulWidget {
  final OidcSession session;
  final String code;
  final String state;
  final void Function() onSuccess;

  const CallbackScreen({
    super.key,
    required this.session,
    required this.code,
    required this.state,
    required this.onSuccess,
  });

  @override
  State<CallbackScreen> createState() => _CallbackScreenState();
}

class _CallbackScreenState extends State<CallbackScreen> {
  bool _running = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _exchange();
  }

  Future<void> _exchange() async {
    try {
      await widget.session.handleCallback(code: widget.code, state: widget.state);
      if (!mounted) return;
      widget.onSuccess();
    } catch (e) {
      setState(() {
        _running = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_running) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Sign-in failed: $_error'),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () {
                Navigator.of(context).pushReplacementNamed('/login');
              },
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}
