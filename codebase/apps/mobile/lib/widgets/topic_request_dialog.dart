import 'package:flutter/material.dart';

/// "Write about my topic" (FR-5.8): title, optional notes and source links. Returns the
/// /runs/request body, or null on cancel.
Future<Map<String, dynamic>?> topicRequestDialog(BuildContext context) async {
  final title = TextEditingController();
  final notes = TextEditingController();
  final links = TextEditingController();
  final submitted = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Write about my topic'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: title, decoration: const InputDecoration(labelText: 'Topic title'), autofocus: true),
        TextField(controller: notes, decoration: const InputDecoration(labelText: 'Notes (optional)'), maxLines: 2),
        TextField(
            controller: links,
            decoration: const InputDecoration(labelText: 'Source links, one per line (optional)'),
            maxLines: 2),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Request')),
      ],
    ),
  );
  if (submitted != true || title.text.trim().isEmpty) return null;
  return {
    'title': title.text.trim(),
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
