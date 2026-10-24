import 'package:flutter/material.dart';

import 'mood.dart';

/// "Write about my topic" (FR-5.8): title, optional notes and source links, and the mood
/// (FR-6.19). Returns the /runs/request body, or null on cancel.
Future<Map<String, dynamic>?> topicRequestDialog(BuildContext context, {bool hideCritical = false}) async {
  var mood = 'normal';
  final title = TextEditingController();
  final notes = TextEditingController();
  final links = TextEditingController();
  final submitted = await showDialog<bool>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: const Text('Write about my topic'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: title,
                decoration: const InputDecoration(labelText: 'Topic title'),
                autofocus: true,
              ),
              TextField(
                controller: notes,
                decoration: const InputDecoration(labelText: 'Notes (optional)'),
                maxLines: 2,
              ),
              TextField(
                controller: links,
                decoration: const InputDecoration(labelText: 'Source links, one per line (optional)'),
                maxLines: 2,
              ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Text('Mood', style: Theme.of(context).textTheme.labelLarge),
              ),
              const SizedBox(height: 4),
              MoodSelector(value: mood, hideCritical: hideCritical, onChanged: (m) => setState(() => mood = m)),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Request')),
        ],
      ),
    ),
  );
  if (submitted != true || title.text.trim().isEmpty) return null;
  return {
    'title': title.text.trim(),
    'mood': mood,
    if (notes.text.trim().isNotEmpty) 'notes': notes.text.trim(),
    if (links.text.trim().isNotEmpty)
      'links': links.text.trim().split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList(),
  };
}

/// FR-7.7: a banned-topic collision needs an explicit override.
Future<bool> bannedTopicOverrideDialog(BuildContext context, String message) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Banned-topic collision (FR-7.7)'),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Override and proceed')),
        ],
      ),
    ) ==
    true;
