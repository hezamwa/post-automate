import 'package:flutter/material.dart';

import '../../models.dart';

class DerivativeTile extends StatelessWidget {
  const DerivativeTile({super.key, required this.derivative});
  final Derivative derivative;

  @override
  Widget build(BuildContext context) {
    // DR-9.14: skipped (capability off) and failed (asked for, didn't arrive) MUST render
    // differently — the reason is shown either way. Declined was the creator's choice.
    final (color, label, note) = switch (derivative.outcome) {
      'produced' => (Colors.green, 'produced', null),
      'declined' => (Colors.grey, 'not requested', null),
      'skipped' => (Colors.grey, 'skipped', derivative.reason ?? 'skipped'),
      _ => (Colors.red, derivative.outcome, derivative.reason ?? 'failed'),
    };
    final small = Theme.of(context).textTheme.bodySmall;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.circle, size: 10, color: color),
            const SizedBox(width: 6),
            Text(derivative.label, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text(label, style: TextStyle(color: color, fontSize: 12)),
          ]),
          if (note != null) Padding(padding: const EdgeInsets.only(left: 16, top: 2), child: Text(note, style: small)),
          if (derivative.content != null && derivative.kind != 'translation')
            Padding(
              padding: const EdgeInsets.only(left: 16, top: 2),
              child: Text(derivative.content!, maxLines: 4, overflow: TextOverflow.ellipsis, style: small),
            ),
        ],
      ),
    );
  }
}
