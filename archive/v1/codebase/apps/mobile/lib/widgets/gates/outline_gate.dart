import 'package:flutter/material.dart';

import '../../models.dart';

/// The outline gate (spec §4.3): approve the outline, edit its sections, or ask for a
/// different one in your own words. Sends `{optionId: approve}`, `{sections}` or `{freeText}`.
class OutlineGate extends StatefulWidget {
  const OutlineGate({super.key, required this.outline, required this.onAnswer, required this.busy});
  final List<OutlineSection> outline;
  final Future<void> Function(Map<String, dynamic> body) onAnswer;
  final bool busy;

  @override
  State<OutlineGate> createState() => _OutlineGateState();
}

class _OutlineGateState extends State<OutlineGate> {
  // One field per section: the heading, then one key point per line.
  late final _sections = [
    for (final s in widget.outline) TextEditingController(text: [s.heading, ...s.keyPoints].join('\n')),
  ];
  final _instructions = TextEditingController();

  bool get _edited {
    for (var i = 0; i < _sections.length; i++) {
      final s = widget.outline[i];
      if (_sections[i].text.trim() != [s.heading, ...s.keyPoints].join('\n')) return true;
    }
    return false;
  }

  List<Map<String, dynamic>> _editedSections() => [
        for (final c in _sections)
          if (c.text.trim().isNotEmpty)
            {
              'heading': c.text.trim().split('\n').first.trim(),
              'keyPoints': c.text.trim().split('\n').skip(1).map((l) => l.trim()).where((l) => l.isNotEmpty).take(4).toList(),
            },
      ];

  @override
  Widget build(BuildContext context) {
    final instructions = _instructions.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('First line is the heading; each further line a key point (up to 4).',
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        for (var i = 0; i < _sections.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: TextField(
              controller: _sections[i],
              maxLines: null,
              decoration: InputDecoration(labelText: 'Section ${i + 1}', border: const OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            ),
          ),
        FilledButton(
          onPressed: widget.busy
              ? null
              : () => widget.onAnswer(_edited ? {'sections': _editedSections()} : {'optionId': 'approve'}),
          child: Text(_edited ? 'Use my edited outline' : 'Approve this outline'),
        ),
        const Divider(height: 32),
        TextField(
          controller: _instructions,
          maxLines: 3,
          decoration: const InputDecoration(
              labelText: 'Or ask for a different outline — what should change?', border: OutlineInputBorder()),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: widget.busy || instructions.length < 3 ? null : () => widget.onAnswer({'freeText': instructions}),
          child: const Text('Request another outline'),
        ),
      ],
    );
  }
}
