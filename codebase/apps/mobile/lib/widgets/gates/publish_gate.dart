import 'package:flutter/material.dart';

import '../../models.dart';

/// The publish gate (spec §4.3), on the approved draft: the produced channel texts —
/// editable — then now / next slot / hold. Sends `{optionId, edits?: {x?, linkedin?}}`.
class PublishGate extends StatefulWidget {
  const PublishGate({super.key, required this.derivatives, required this.onAnswer, required this.busy});
  final List<Derivative> derivatives;
  final Future<void> Function(Map<String, dynamic> body) onAnswer;
  final bool busy;

  @override
  State<PublishGate> createState() => _PublishGateState();
}

class _PublishGateState extends State<PublishGate> {
  late final Map<String, ({String original, TextEditingController controller})> _texts = {
    for (final d in widget.derivatives)
      if ((d.kind == 'x' || d.kind == 'linkedin') && d.outcome == 'produced' && d.content != null)
        d.kind: (original: d.content!, controller: TextEditingController(text: d.content)),
  };

  Map<String, String> get _edits => {
        for (final e in _texts.entries)
          if (e.value.controller.text.trim() != e.value.original.trim()) e.key: e.value.controller.text.trim(),
      };

  void _answer(String optionId) {
    final edits = _edits;
    widget.onAnswer({'optionId': optionId, if (edits.isNotEmpty && optionId != 'hold') 'edits': edits});
  }

  @override
  Widget build(BuildContext context) {
    final xTooLong = (_texts['x']?.controller.text.trim().length ?? 0) > 280;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Ready to publish', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(_texts.isEmpty ? 'Article only — no channel texts were requested.' : 'Check the channel texts, then choose when.',
                style: Theme.of(context).textTheme.bodySmall),
            for (final e in _texts.entries)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: TextField(
                  controller: e.value.controller,
                  maxLines: null,
                  maxLength: e.key == 'x' ? 280 : 3000,
                  decoration: InputDecoration(
                      labelText: e.key == 'x' ? 'X post' : 'LinkedIn post', border: const OutlineInputBorder()),
                  onChanged: (_) => setState(() {}),
                ),
              ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              FilledButton(onPressed: widget.busy || xTooLong ? null : () => _answer('now'), child: const Text('Publish now')),
              OutlinedButton(
                  onPressed: widget.busy || xTooLong ? null : () => _answer('next_slot'),
                  child: const Text('At my next slot')),
              TextButton(onPressed: widget.busy ? null : () => _answer('hold'), child: const Text('Hold')),
            ]),
          ],
        ),
      ),
    );
  }
}
