import 'package:flutter/material.dart';

/// Per-article mood (FR-6.19): adjusts the profile's voice for this one article. The API
/// refuses `critical` for a profile with medical guardrails (FR-6.20).
const moods = {
  'normal': 'Normal',
  'optimistic': 'Optimistic',
  'excited': 'Excited',
  'very_excited': 'Very excited',
  'concerned': 'Concerned',
  'disappointed': 'Disappointed',
  'critical': 'Critical',
};

/// A compact mood selector, `normal` preselected.
class MoodSelector extends StatelessWidget {
  const MoodSelector({super.key, required this.value, required this.onChanged, this.hideCritical = false});
  final String value;
  final ValueChanged<String> onChanged;
  final bool hideCritical;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 6, runSpacing: 6, children: [
        for (final e in moods.entries)
          if (!(hideCritical && e.key == 'critical'))
            ChoiceChip(label: Text(e.value), selected: value == e.key, onSelected: (_) => onChanged(e.key)),
      ]);
}

/// Generate's one question: which mood? Returns null on cancel.
Future<String?> moodDialog(BuildContext context, {bool hideCritical = false}) {
  var mood = 'normal';
  return showDialog<String>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: const Text('Generate — what mood?'),
        content: MoodSelector(value: mood, hideCritical: hideCritical, onChanged: (m) => setState(() => mood = m)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, mood), child: const Text('Generate')),
        ],
      ),
    ),
  );
}
