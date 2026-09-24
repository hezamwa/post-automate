import 'package:flutter/material.dart';

// Form building blocks for the profile page (FR-3.11). Each edits one key of a JSON map
// in place and calls [onChanged]; the page saves the whole map as a new version.

typedef Json = Map<String, dynamic>;

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 24, bottom: 8),
        child: Text(text, style: Theme.of(context).textTheme.titleMedium),
      );
}

class EnumField extends StatelessWidget {
  const EnumField({super.key, required this.label, required this.map, required this.field, required this.options, required this.onChanged});
  final String label;
  final Json map;
  final String field;
  final Map<String, String> options; // value → label
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: DropdownButtonFormField<String>(
          initialValue: map[field] as String?,
          decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
          items: [for (final e in options.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: (v) {
            map[field] = v;
            onChanged();
          },
        ),
      );
}

class TextValueField extends StatelessWidget {
  const TextValueField({super.key, required this.label, required this.map, required this.field, required this.onChanged, this.maxLines = 1, this.number = false});
  final String label;
  final Json map;
  final String field;
  final VoidCallback onChanged;
  final int maxLines;
  final bool number; // stores an int

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextFormField(
          initialValue: '${map[field] ?? ''}',
          maxLines: maxLines,
          keyboardType: number ? TextInputType.number : null,
          decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
          onChanged: (v) {
            map[field] = number ? (int.tryParse(v.trim()) ?? map[field]) : v;
            onChanged();
          },
        ),
      );
}

/// A list of strings edited as comma-separated text (tone words, banned topics).
class CommaListField extends StatelessWidget {
  const CommaListField({super.key, required this.label, required this.map, required this.field, required this.onChanged});
  final String label;
  final Json map;
  final String field;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextFormField(
          initialValue: ((map[field] as List<dynamic>?) ?? []).join(', '),
          decoration: InputDecoration(labelText: '$label (comma-separated)', border: const OutlineInputBorder()),
          onChanged: (v) {
            map[field] = v.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
            onChanged();
          },
        ),
      );
}

class SwitchField extends StatelessWidget {
  const SwitchField({super.key, required this.label, required this.map, required this.field, required this.onChanged, this.subtitle});
  final String label;
  final String? subtitle;
  final Json map;
  final String field;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) => SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label),
        subtitle: subtitle == null ? null : Text(subtitle!),
        value: map[field] == true,
        onChanged: (v) {
          map[field] = v;
          onChanged();
        },
      );
}

/// Toggles membership of [value] in the list at [field] (channels, preferred days).
class ListChips extends StatelessWidget {
  const ListChips({super.key, required this.map, required this.field, required this.options, required this.onChanged});
  final Json map;
  final String field;
  final Map<String, String> options;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final selected = ((map[field] as List<dynamic>?) ?? []).cast<String>();
    return Wrap(spacing: 6, runSpacing: 6, children: [
      for (final e in options.entries)
        FilterChip(
          label: Text(e.value),
          selected: selected.contains(e.key),
          onSelected: (on) {
            map[field] = on
                ? [...selected, e.key]
                : selected.where((s) => s != e.key).toList();
            onChanged();
          },
        ),
    ]);
  }
}
