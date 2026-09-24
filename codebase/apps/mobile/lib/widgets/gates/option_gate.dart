import 'package:flutter/material.dart';

import '../../models.dart';

/// Topic, angle and image gates (spec §4.3): pick an option — the recommended one is
/// preselected — or answer in your own words. Sends `{optionId}` or `{freeText}`.
class OptionGate extends StatefulWidget {
  const OptionGate({super.key, required this.gate, required this.onAnswer, required this.busy});
  final GateView gate;
  final Future<void> Function(Map<String, dynamic> body) onAnswer;
  final bool busy;

  @override
  State<OptionGate> createState() => _OptionGateState();
}

class _OptionGateState extends State<OptionGate> {
  late String? _selected = widget.gate.recommended.isEmpty ? null : widget.gate.recommended;
  final _freeText = TextEditingController();

  String get _freeTextHint => switch (widget.gate.name) {
        'topic' => 'Or write about something else instead…',
        'angle' => 'Or describe your own angle…',
        'image' => 'Or describe the image you want…',
        _ => 'Or answer in your own words…',
      };

  @override
  Widget build(BuildContext context) {
    final text = _freeText.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        RadioGroup<String>(
          groupValue: text.isEmpty ? _selected : null,
          onChanged: (v) => setState(() {
            _selected = v;
            _freeText.clear();
          }),
          child: Column(children: [
            for (final o in widget.gate.options)
              RadioListTile<String>(
                value: o.id,
                title: Row(children: [
                  Expanded(child: Text(o.title, style: const TextStyle(fontWeight: FontWeight.w600))),
                  if (o.id == widget.gate.recommended)
                    const Chip(label: Text('Recommended'), visualDensity: VisualDensity.compact),
                ]),
                subtitle: Text([o.summary, o.why].where((s) => s.isNotEmpty).join('\n')),
                isThreeLine: o.summary.isNotEmpty && o.why.isNotEmpty,
              ),
          ]),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _freeText,
          minLines: 1,
          maxLines: 3,
          decoration: InputDecoration(labelText: _freeTextHint, border: const OutlineInputBorder()),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: widget.busy || (text.isEmpty && _selected == null)
              ? null
              : () => widget.onAnswer(text.isNotEmpty ? {'freeText': text} : {'optionId': _selected}),
          child: Text(text.isNotEmpty ? 'Use my answer' : 'Continue with this choice'),
        ),
      ],
    );
  }
}
