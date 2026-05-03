/// Web implementation of the session-storage shim. Backed by
/// window.sessionStorage so the verifier survives the OP redirect inside
/// the same tab.
library;

// ignore: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

void setItem(String k, String v) => html.window.sessionStorage[k] = v;
String? getItem(String k) => html.window.sessionStorage[k];
void removeItem(String k) => html.window.sessionStorage.remove(k);

void assignLocation(String url) => html.window.location.assign(url);
