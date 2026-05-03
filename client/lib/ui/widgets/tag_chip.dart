/// Compact pill that renders a tag's path. Used by task rows and the tag
/// editor in TaskDetailScreen.
library;

import 'package:flutter/material.dart';

class TagChip extends StatelessWidget {
  /// The full tag path (e.g. `priority/high`).
  final String path;

  /// `true` when the tag is currently applied to the surrounding card.
  /// Used by the tag editor to show selection state with a checkmark.
  final bool selected;

  /// Optional callback when the chip is tapped (used by the editor).
  final VoidCallback? onTap;

  /// Optional callback for an explicit close-button (used to remove from a
  /// task row without opening the editor).
  final VoidCallback? onRemove;

  const TagChip({
    super.key,
    required this.path,
    this.selected = false,
    this.onTap,
    this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final bg = selected ? cs.primaryContainer : cs.surfaceContainerHighest;
    final fg = selected ? cs.onPrimaryContainer : cs.onSurfaceVariant;
    final child = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (selected)
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Icon(Icons.check, size: 14, color: fg),
          ),
        Text(
          path,
          style: TextStyle(fontSize: 12, color: fg, fontWeight: FontWeight.w500),
        ),
        if (onRemove != null)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: GestureDetector(
              onTap: onRemove,
              child: Icon(Icons.close, size: 14, color: fg),
            ),
          ),
      ],
    );
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: child,
    );
    if (onTap == null) return pill;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: pill,
    );
  }
}
