// Light read models over the Worker API's JSON (the generated-client plan from the
// design's "Mobile API contract" can replace these once an OpenAPI spec exists).

class Derivative {
  Derivative({required this.kind, required this.outcome, this.content, this.reason});
  final String kind; // hero_image | x | linkedin | translation
  final String outcome; // produced | skipped | failed (DR-9.14)
  final String? content;
  final String? reason;

  factory Derivative.fromJson(Map<String, dynamic> json) => Derivative(
        kind: json['kind'] as String,
        outcome: json['outcome'] as String,
        content: json['content'] as String?,
        reason: json['reason'] as String?,
      );

  String get label => switch (kind) {
        'hero_image' => 'Hero image',
        'x' => 'X post',
        'linkedin' => 'LinkedIn post',
        'translation' => 'Translation',
        _ => kind,
      };
}

class DraftSummary {
  DraftSummary({
    required this.id,
    required this.runId,
    required this.status,
    required this.createdAt,
    this.publishAt,
    this.angleHeadline,
    this.derivatives = const [],
  });
  final String id;
  final String runId;
  final String status;
  final DateTime createdAt;
  final DateTime? publishAt;
  final String? angleHeadline;
  final List<Derivative> derivatives;

  factory DraftSummary.fromJson(Map<String, dynamic> json) => DraftSummary(
        id: json['id'] as String,
        runId: json['runId'] as String,
        status: json['status'] as String,
        createdAt: DateTime.parse(json['createdAt'] as String),
        publishAt: json['publishAt'] != null ? DateTime.parse(json['publishAt'] as String) : null,
        angleHeadline: (json['angle'] as Map<String, dynamic>?)?['headline'] as String?,
        derivatives: ((json['derivatives'] as List<dynamic>?) ?? [])
            .map((d) => Derivative.fromJson(d as Map<String, dynamic>))
            .toList(),
      );
}

class DraftDetail {
  DraftDetail({
    required this.summary,
    this.markdown,
    this.runState,
    this.angleProposals = const [],
    this.recommendedIndex = 0,
    this.medical = false,
    this.supportsBlogType = false,
  });
  final DraftSummary summary;
  final String? markdown; // null after publish/reject (purged, DR-9.11)
  final String? runState;
  final List<Map<String, dynamic>> angleProposals;
  final int recommendedIndex;
  final bool medical; // FR-6.8: compliance checklist required before approve
  final bool supportsBlogType; // Afnan's site: per-draft public/em choice (design §8)

  factory DraftDetail.fromJson(Map<String, dynamic> json) {
    final draft = json['draft'] as Map<String, dynamic>;
    final run = json['run'] as Map<String, dynamic>?;
    final proposals = run?['angleProposals'] as Map<String, dynamic>?;
    return DraftDetail(
      summary: DraftSummary.fromJson({...draft, 'derivatives': json['derivatives']}),
      markdown: draft['markdown'] as String?,
      runState: run?['state'] as String?,
      angleProposals:
          ((proposals?['angles'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(),
      recommendedIndex: (proposals?['recommendedIndex'] as num?)?.toInt() ?? 0,
      medical: json['medical'] == true,
      supportsBlogType: json['supportsBlogType'] == true,
    );
  }
}

class RunSummary {
  RunSummary({
    required this.id,
    required this.trigger,
    required this.state,
    required this.startedAt,
    this.error,
    this.topicTitle,
    this.angleProposals = const [],
  });
  final String id;
  final String trigger;
  final String state;
  final DateTime startedAt;
  final String? error;
  final String? topicTitle;
  final List<Map<String, dynamic>> angleProposals;

  factory RunSummary.fromJson(Map<String, dynamic> json) {
    final proposals = json['angleProposals'] as Map<String, dynamic>?;
    return RunSummary(
      id: json['id'] as String,
      trigger: json['trigger'] as String,
      state: json['state'] as String,
      startedAt: DateTime.parse(json['startedAt'] as String),
      error: json['error'] as String?,
      topicTitle: (json['userTopic'] as Map<String, dynamic>?)?['title'] as String?,
      angleProposals:
          ((proposals?['angles'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(),
    );
  }

  /// A user-topic run parked at the 24h angle wait (FR-6.3): proposals stored, still drafting.
  bool get awaitsAngleChoice => trigger == 'user_topic' && state == 'drafting' && angleProposals.isNotEmpty;
}
