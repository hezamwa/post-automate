// The one option shape every gate renders (spec §4): {options, recommended}.

class GateOption {
  GateOption({required this.id, required this.title, required this.summary, required this.why});
  final String id;
  final String title;
  final String summary;
  final String why;

  factory GateOption.fromJson(Map<String, dynamic> json) => GateOption(
        id: json['id'] as String,
        title: (json['title'] as String?) ?? '',
        summary: (json['summary'] as String?) ?? '',
        why: (json['why'] as String?) ?? '',
      );

  static List<GateOption> listFrom(Object? raw) => ((raw as List<dynamic>?) ?? [])
      .map((o) => GateOption.fromJson(o as Map<String, dynamic>))
      .toList();
}

/// The gate a run is waiting on, from GET /runs/:id.
class GateView {
  GateView({required this.name, required this.options, required this.recommended});
  final String name; // topic | angle | outline | image | publish
  final List<GateOption> options;
  final String recommended;

  factory GateView.fromJson(Map<String, dynamic> json) => GateView(
        name: json['name'] as String,
        options: GateOption.listFrom(json['options']),
        recommended: (json['recommended'] as String?) ?? '',
      );
}

/// One recorded choice (the preference log, spec §4.3).
class GateChoice {
  GateChoice({required this.gate, required this.source, this.freeText});
  final String gate;
  final String source; // user | auto
  final String? freeText;

  factory GateChoice.fromJson(Map<String, dynamic> json) => GateChoice(
        gate: json['gate'] as String,
        source: json['source'] as String,
        freeText: json['freeText'] as String?,
      );
}

/// The derivatives gate on the approve screen (spec §4.1): multi-select, pre-ticked.
class DerivativesGate {
  DerivativesGate({required this.ask, required this.options, required this.preselected});
  final bool ask; // false = auto: the profile decides, checkboxes hidden
  final List<GateOption> options;
  final List<String> preselected;

  factory DerivativesGate.fromJson(Map<String, dynamic> json) => DerivativesGate(
        ask: json['setting'] == 'ask',
        options: GateOption.listFrom(json['options']),
        preselected: ((json['preselected'] as List<dynamic>?) ?? []).cast<String>(),
      );
}
