import 'package:flutter/material.dart';

import '../../models.dart';

/// The approve sheet (spec §4.1, §5): one dialog for everything approval carries —
/// the blog (Afnan's site), the derivatives gate's checkboxes when it is `ask`, and the
/// publish time when the publish gate is `auto` (with `ask` it is chosen after approval).
/// Returns the approve payload's extra fields, or null on cancel.
Future<Map<String, dynamic>?> approveDialog(BuildContext context, DraftDetail detail) {
  final gate = detail.derivativesGate;
  final ticked = {...?gate?.preselected};
  String? blogType = detail.supportsBlogType ? 'public' : null;
  var mode = 'now';

  return showDialog<Map<String, dynamic>>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: const Text('Approve'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (detail.supportsBlogType) ...[
              const Text('Which blog?'),
              RadioGroup<String>(
                groupValue: blogType,
                onChanged: (v) => setState(() => blogType = v),
                child: const Column(children: [
                  RadioListTile(value: 'public', title: Text('Public — general health education'), dense: true),
                  RadioListTile(value: 'em', title: Text('EM — emergency-medicine professionals'), dense: true),
                ]),
              ),
            ],
            if (gate != null && gate.ask && gate.options.isNotEmpty) ...[
              const Text('Also produce'),
              for (final o in gate.options)
                CheckboxListTile(
                  dense: true,
                  value: ticked.contains(o.id),
                  title: Text(o.title),
                  controlAffinity: ListTileControlAffinity.leading,
                  onChanged: (v) => setState(() => v == true ? ticked.add(o.id) : ticked.remove(o.id)),
                ),
              if (ticked.isEmpty) Text('Article only.', style: Theme.of(context).textTheme.bodySmall),
            ],
            if (!detail.publishAsk) ...[
              const Text('Publish when? (FR-7.5)'),
              RadioGroup<String>(
                groupValue: mode,
                onChanged: (v) => setState(() => mode = v ?? 'now'),
                child: const Column(children: [
                  RadioListTile(value: 'now', title: Text('Publish now'), dense: true),
                  RadioListTile(value: 'next_slot', title: Text('At my next preferred slot'), dense: true),
                ]),
              ),
            ] else
              Text('You will choose when to publish once the channel texts are ready.',
                  style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(context, {
              'blogType': ?blogType,
              if (gate != null && gate.ask) 'channels': ticked.toList(),
              if (!detail.publishAsk) 'publishMode': mode,
            }),
            child: const Text('Approve'),
          ),
        ],
      ),
    ),
  );
}
