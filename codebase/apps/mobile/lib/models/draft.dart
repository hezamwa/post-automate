import 'derivative.dart';
import 'gate.dart';

DateTime? _date(Object? raw) => raw == null ? null : DateTime.parse(raw as String);

class DraftSummary {
  DraftSummary({
    required this.id,
    required this.runId,
    required this.status,
    required this.createdAt,
    this.publishAt,
    this.angleHeadline,
    this.stale = false,
    this.gate,
    this.derivatives = const [],
  });
  final String id;
  final String runId;
  final String status;
  final DateTime createdAt;
  final DateTime? publishAt;
  final String? angleHeadline;
  final bool stale; // spec §5.1: instance gone — revise / change angle unavailable
  final String? gate; // the gate the run waits on — "publish" after approval
  final List<Derivative> derivatives;

  factory DraftSummary.fromJson(Map<String, dynamic> json) => DraftSummary(
        id: json['id'] as String,
        runId: json['runId'] as String,
        status: json['status'] as String,
        createdAt: DateTime.parse(json['createdAt'] as String),
        publishAt: _date(json['publishAt']),
        angleHeadline: (json['angle'] as Map<String, dynamic>?)?['headline'] as String?,
        stale: json['stale'] == true,
        gate: json['gate'] as String?,
        derivatives: ((json['derivatives'] as List<dynamic>?) ?? [])
            .map((d) => Derivative.fromJson(d as Map<String, dynamic>))
            .toList(),
      );
}

/// Spec §3 step 8: the quality-check verdict shown on the review screen.
class QualityCheck {
  QualityCheck({required this.passed, required this.autoRevised, required this.findings});
  final bool passed;
  final bool autoRevised;
  final List<({String check, bool ok, String note})> findings;

  static QualityCheck? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    return QualityCheck(
      passed: raw['passed'] == true,
      autoRevised: raw['autoRevised'] == true,
      findings: ((raw['findings'] as List<dynamic>?) ?? [])
          .cast<Map<String, dynamic>>()
          .map((f) => (check: f['check'] as String, ok: f['ok'] == true, note: (f['note'] as String?) ?? ''))
          .toList(),
    );
  }
}

class DraftDetail {
  DraftDetail({
    required this.summary,
    this.markdown,
    this.runState,
    this.angleProposals = const [],
    this.medical = false,
    this.supportsBlogType = false,
    this.quality,
    this.derivativesGate,
    this.publishAsk = false,
    this.autoPublish = false,
    this.autoPublishWarnedAt,
    this.autoPublishHeldAt,
  });
  final DraftSummary summary;
  final String? markdown; // null after publish/reject (purged, DR-9.11)
  final String? runState;
  final List<Map<String, dynamic>> angleProposals;
  final bool medical; // FR-6.8: compliance checklist required before approve
  final bool supportsBlogType; // Afnan's site: per-draft public/em choice (design §8)
  final QualityCheck? quality;
  final DerivativesGate? derivativesGate;
  final bool publishAsk; // the publish gate asks after approval — no publish-mode choice here
  final bool autoPublish; // spec §5.2: admin flag, read-only for the creator
  final DateTime? autoPublishWarnedAt;
  final DateTime? autoPublishHeldAt;

  factory DraftDetail.fromJson(Map<String, dynamic> json) {
    final draft = json['draft'] as Map<String, dynamic>;
    final run = json['run'] as Map<String, dynamic>?;
    final proposals = run?['angleProposals'] as Map<String, dynamic>?;
    final gates = json['gates'] as Map<String, dynamic>?;
    return DraftDetail(
      summary: DraftSummary.fromJson({...draft, 'derivatives': json['derivatives'], 'gate': run?['gate']}),
      markdown: draft['markdown'] as String?,
      runState: run?['state'] as String?,
      angleProposals: ((proposals?['angles'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(),
      medical: json['medical'] == true,
      supportsBlogType: json['supportsBlogType'] == true,
      quality: QualityCheck.fromJson(draft['qualityCheck']),
      derivativesGate: gates?['derivatives'] == null
          ? null
          : DerivativesGate.fromJson(gates!['derivatives'] as Map<String, dynamic>),
      publishAsk: (gates?['publish'] as Map<String, dynamic>?)?['setting'] == 'ask',
      autoPublish: json['autoPublish'] == true,
      autoPublishWarnedAt: _date(draft['autoPublishWarnedAt']),
      autoPublishHeldAt: _date(draft['autoPublishHeldAt']),
    );
  }

  /// Spec §5.2: warned, not yet held — the one-tap Hold is offered.
  bool get canHoldAutoPublish =>
      summary.status == 'pending_approval' && autoPublishWarnedAt != null && autoPublishHeldAt == null;
}
