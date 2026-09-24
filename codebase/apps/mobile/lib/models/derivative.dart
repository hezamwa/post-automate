class Derivative {
  Derivative({required this.kind, required this.outcome, this.content, this.reason});
  final String kind; // hero_image | x | linkedin | translation
  final String outcome; // produced | skipped | failed | declined (DR-9.14, spec §7)
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

  /// Skipped or failed — something asked for that did not arrive. `declined` was the
  /// creator's own choice at the derivatives gate, not an issue (spec §7).
  bool get isIssue => outcome == 'skipped' || outcome == 'failed';
}
