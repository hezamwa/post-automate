import 'gate.dart';

class RunSummary {
  RunSummary({
    required this.id,
    required this.trigger,
    required this.state,
    required this.startedAt,
    this.gate,
    this.error,
    this.topicTitle,
  });
  final String id;
  final String trigger;
  final String state;
  final DateTime startedAt;
  final String? gate; // the gate the run is waiting on (spec §4), null when not waiting
  final String? error;
  final String? topicTitle;

  factory RunSummary.fromJson(Map<String, dynamic> json) => RunSummary(
        id: json['id'] as String,
        trigger: json['trigger'] as String,
        state: json['state'] as String,
        startedAt: DateTime.parse(json['startedAt'] as String),
        gate: json['gate'] as String?,
        error: json['error'] as String?,
        topicTitle: (json['userTopic'] as Map<String, dynamic>?)?['title'] as String?,
      );

  bool get awaitsInput => gate != null;
}

typedef OutlineSection = ({String heading, List<String> keyPoints});

/// GET /runs/:id — one payload renders any gate (spec §4).
class RunDetail {
  RunDetail({required this.run, this.gate, this.draftId, this.choices = const [], this.outline = const []});
  final RunSummary run;
  final GateView? gate;
  final String? draftId;
  final List<GateChoice> choices;
  final List<OutlineSection> outline; // the current outline — what the outline gate edits

  factory RunDetail.fromJson(Map<String, dynamic> json) => RunDetail(
        run: RunSummary.fromJson(json['run'] as Map<String, dynamic>),
        gate: json['gate'] == null ? null : GateView.fromJson(json['gate'] as Map<String, dynamic>),
        draftId: json['draftId'] as String?,
        choices: ((json['choices'] as List<dynamic>?) ?? [])
            .map((c) => GateChoice.fromJson(c as Map<String, dynamic>))
            .toList(),
        outline: ((((json['run'] as Map<String, dynamic>)['outline'] as Map<String, dynamic>?)?['sections']
                    as List<dynamic>?) ??
                [])
            .cast<Map<String, dynamic>>()
            .map((s) => (
                  heading: s['heading'] as String,
                  keyPoints: ((s['keyPoints'] as List<dynamic>?) ?? []).cast<String>(),
                ))
            .toList(),
      );
}
