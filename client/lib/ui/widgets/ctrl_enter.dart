/// `CtrlEnterSubmit`: a thin wrapper around any child (typically a
/// `TextField`) that turns Ctrl+Enter into a submit callback.
///
/// Why a widget rather than per-call-site `Shortcuts(...)`? We invoke the
/// pattern in five places (project + task new-card dialogs, plus task
/// detail's title/description/comment) and the boilerplate to spell out
/// `SingleActivator(LogicalKeyboardKey.enter, control: true)` plus a
/// `CallbackShortcuts` wrapper would be repeated five times. One widget
/// keeps the shortcut definition in one place.
///
/// Plain Enter is intentionally NOT intercepted here: the title field's
/// `onSubmitted` already handles plain Enter for submission, and the
/// description field accepts plain Enter as a newline (multi-line). This
/// only adds Ctrl+Enter on top.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class CtrlEnterSubmit extends StatelessWidget {
  /// Invoked when the user presses Ctrl+Enter while focus is in [child].
  final VoidCallback onSubmit;
  final Widget child;
  const CtrlEnterSubmit({
    super.key,
    required this.onSubmit,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter, control: true): onSubmit,
        // Mac users press Cmd+Enter for the same intent; map it too so the
        // shortcut feels native on either platform.
        const SingleActivator(LogicalKeyboardKey.enter, meta: true): onSubmit,
      },
      child: child,
    );
  }
}
