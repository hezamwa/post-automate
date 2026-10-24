import 'package:flutter/material.dart';

// The draft gate's dialogs (spec §5, FR-6.8, FR-7.8–7.9). Each returns the answer, or
// null when the reviewer cancels.

/// FR-6.8: the medical reviewer must tick every compliance item before approving.
Future<bool> complianceChecklist(BuildContext context) async {
  const items = [
    'Educational/general information only — no advice for any individual',
    'No diagnosis or treatment recommendations',
    'No drug dosages, titration schedules, or prescribing guidance',
    'No real patients, cases (even anonymized), or institutional references',
    'The disclaimer block is present and intact',
  ];
  final checked = List<bool>.filled(items.length, false);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setDialogState) => AlertDialog(
        title: const Text('Compliance checklist (FR-6.8)'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < items.length; i++)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: Text(items[i], style: const TextStyle(fontSize: 13)),
                value: checked[i],
                onChanged: (v) => setDialogState(() => checked[i] = v ?? false),
              ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            onPressed: checked.every((c) => c) ? () => Navigator.pop(context, true) : null,
            child: const Text('All verified'),
          ),
        ],
      ),
    ),
  );
  return confirmed == true;
}

Future<String?> reviseDialog(BuildContext context) async {
  final controller = TextEditingController();
  final text = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Revision instructions (max 3 per draft, FR-7.9)'),
      content: TextField(controller: controller, maxLines: 4, autofocus: true),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Request revision')),
      ],
    ),
  );
  return text == null || text.trim().isEmpty ? null : text.trim();
}

Future<int?> changeAngleDialog(BuildContext context, List<Map<String, dynamic>> proposals) => showDialog<int>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Regenerate from another angle (FR-7.9)'),
        children: [
          for (var i = 0; i < proposals.length; i++)
            SimpleDialogOption(onPressed: () => Navigator.pop(context, i), child: Text('${proposals[i]['headline']}')),
        ],
      ),
    );

Future<String?> rejectDialog(BuildContext context) => showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Why reject? (FR-7.8)'),
        children: [
          SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'quality'), child: const Text('Content quality — tune my profile')),
          SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'changed_mind'), child: const Text('Wrong topic / changed my mind')),
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'other'), child: const Text('Other')),
        ],
      ),
    );
