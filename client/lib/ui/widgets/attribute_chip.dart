/// Tiny chip-shaped pill used by task list rows and the task detail panel
/// to render an attribute value (status, milestone, …) compactly.
///
/// Renders only the value (e.g. `"API"` rather than `"Component: API"`).
/// The label travels with the widget for tooltip / a11y purposes — the
/// disambiguating context (which column / row this chip belongs to) is
/// implicit from where the chip is rendered.
///
/// Stays a presentational widget — colour selection happens here, but
/// nothing data-fetching does.
library;

import 'package:flutter/material.dart';

class AttributeChip extends StatelessWidget {
  /// Attribute name (e.g. `status`, `milestone`). Kept for tooltip / a11y;
  /// not rendered as a visible prefix.
  final String label;
  final String? value;

  /// Optional override colour. If null we pick from the theme.
  final Color? colour;

  /// `true` to render with reduced contrast for "missing" values
  /// (status: open vs status: unset).
  final bool muted;

  const AttributeChip({
    super.key,
    required this.label,
    this.value,
    this.colour,
    this.muted = false,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final bg = colour ?? (muted ? cs.surfaceContainerHighest : cs.secondaryContainer);
    final fg = muted ? cs.onSurfaceVariant : cs.onSecondaryContainer;
    final empty = value == null || value!.isEmpty;
    final text = empty ? '—' : value!;
    return Tooltip(
      message: empty ? label : '$label: ${value!}',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          text,
          style: TextStyle(fontSize: 12, color: fg, fontWeight: FontWeight.w500),
        ),
      ),
    );
  }
}
