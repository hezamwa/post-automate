import 'package:flutter_test/flutter_test.dart';
import 'package:post_automate_mobile/models.dart';

// The read models against payloads shaped like the Worker's (design §7).
void main() {
  test('draft detail: publish gate, derivatives gate, quality, auto-publish hold', () {
    final d = DraftDetail.fromJson({
      'draft': {
        'id': 'd1',
        'runId': 'r1',
        'status': 'pending_approval',
        'createdAt': '2026-09-24T10:00:00Z',
        'stale': true,
        'qualityCheck': {
          'passed': false,
          'autoRevised': true,
          'findings': [
            {'check': 'length', 'ok': false, 'note': 'too short'},
            {'check': 'language', 'ok': true, 'note': ''},
          ],
        },
        'autoPublishWarnedAt': '2026-09-23T10:00:00Z',
      },
      'run': {'state': 'publishing', 'gate': 'publish'},
      'derivatives': [
        {'kind': 'x', 'outcome': 'produced', 'content': 'hi'},
        {'kind': 'linkedin', 'outcome': 'declined'},
      ],
      'gates': {
        'derivatives': {
          'setting': 'ask',
          'options': [
            {'id': 'x', 'title': 'X post', 'summary': '', 'why': ''},
          ],
          'preselected': ['x'],
        },
        'publish': {'setting': 'ask'},
      },
      'autoPublish': true,
    });
    expect(d.summary.gate, 'publish');
    expect(d.summary.stale, isTrue);
    expect(d.derivativesGate!.ask, isTrue);
    expect(d.derivativesGate!.preselected, ['x']);
    expect(d.publishAsk, isTrue);
    expect(d.quality!.findings.where((f) => !f.ok).single.check, 'length');
    expect(d.canHoldAutoPublish, isTrue);
    expect(d.summary.derivatives.where((x) => x.isIssue), isEmpty); // declined is a choice
  });

  test('run detail: waiting gate, outline sections, draft id', () {
    final r = RunDetail.fromJson({
      'run': {
        'id': 'r1',
        'trigger': 'manual',
        'state': 'drafting',
        'gate': 'outline',
        'startedAt': '2026-09-24T10:00:00Z',
        'outline': {
          'sections': [
            {'heading': 'Intro', 'keyPoints': ['why now']},
            {'heading': 'Body', 'keyPoints': []},
          ],
        },
      },
      'gate': {
        'name': 'outline',
        'options': [
          {'id': 'approve', 'title': '2 sections', 'summary': '', 'why': ''},
        ],
        'recommended': 'approve',
      },
      'draftId': null,
      'choices': [
        {'gate': 'angle', 'source': 'auto'},
      ],
    });
    expect(r.run.awaitsInput, isTrue);
    expect(r.gate!.name, 'outline');
    expect(r.outline.first.keyPoints, ['why now']);
    expect(r.choices.single.source, 'auto');
    expect(r.draftId, isNull);
  });
}
