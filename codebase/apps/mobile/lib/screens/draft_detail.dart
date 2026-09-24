import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../widgets/draft/approve_dialog.dart';
import '../widgets/draft/decision_dialogs.dart';
import '../widgets/draft/derivative_tile.dart';
import '../widgets/draft/draft_actions.dart';
import '../widgets/draft/review_panels.dart';
import '../widgets/gates/publish_gate.dart';

/// Review screen (design §15, spec §5): the article, quality findings, channel outcomes,
/// the draft gate's decisions, the publish gate once approved, and cancel/retract.
class DraftDetailScreen extends StatefulWidget {
  const DraftDetailScreen({super.key, required this.draftId});
  final String draftId;

  @override
  State<DraftDetailScreen> createState() => _DraftDetailScreenState();
}

class _DraftDetailScreenState extends State<DraftDetailScreen> {
  DraftDetail? _detail;
  String? _error;
  bool _busy = false;
  final _markdown = TextEditingController();
  String _originalMarkdown = '';

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final detail = DraftDetail.fromJson(await ApiClient.instance.get('/drafts/${widget.draftId}'));
      setState(() {
        _detail = detail;
        _originalMarkdown = detail.markdown ?? '';
        _markdown.text = _originalMarkdown;
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  /// Run [fn]; on success show [done] and either leave the screen or reload it.
  Future<void> _act(Future<void> Function() fn, {String? done, bool pop = false}) async {
    setState(() => _busy = true);
    try {
      await fn();
      if (!mounted) return;
      if (done != null) _snack(done);
      pop ? Navigator.of(context).pop() : await _reload();
    } on ApiException catch (e) {
      if (mounted) _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decide(Map<String, dynamic> body, String done) =>
      _act(() => ApiClient.instance.post('/drafts/${widget.draftId}/decision', body), done: done, pop: true);

  Future<void> _approve() async {
    final detail = _detail!;
    if (detail.medical && !await complianceChecklist(context)) return;
    if (!mounted) return;
    final extra = await approveDialog(context, detail);
    if (extra == null) return;
    final edited = _markdown.text != _originalMarkdown ? _markdown.text : null;
    await _decide({'action': 'approve', 'editedMarkdown': ?edited, ...extra},
        detail.publishAsk ? 'Approved — preparing the channel texts.' : 'Approved.');
  }

  Future<void> _revise() async {
    final instructions = await reviseDialog(context);
    if (instructions != null) await _decide({'action': 'revise', 'instructions': instructions}, 'Revision requested.');
  }

  Future<void> _changeAngle() async {
    final index = await changeAngleDialog(context, _detail!.angleProposals);
    if (index != null) await _decide({'action': 'change_angle', 'angleIndex': index}, 'Regenerating from the new angle.');
  }

  Future<void> _reject() async {
    final category = await rejectDialog(context);
    if (category != null) await _decide({'action': 'reject', 'rejectionCategory': category}, 'Rejected — draft removed.');
  }

  Future<void> _post(String path, String done, {bool pop = false}) =>
      _act(() => ApiClient.instance.post('/drafts/${widget.draftId}/$path'), done: done, pop: pop);

  Future<void> _answerPublish(Map<String, dynamic> body) => _act(
      () => ApiClient.instance.post('/runs/${_detail!.summary.runId}/gates/publish', body),
      done: body['optionId'] == 'hold' ? 'Held — back in your queue.' : 'On its way.',
      pop: true);

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    if (_error != null) return Scaffold(appBar: AppBar(), body: Center(child: Text(_error!)));
    if (detail == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    final s = detail.summary;
    final reviewable = s.status == 'pending_approval' && s.gate != 'publish';
    final titles = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: Text(s.gate == 'publish' ? 'ready to publish' : s.status.replaceAll('_', ' '))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (s.angleHeadline != null) Text(s.angleHeadline!, style: titles.titleLarge),
          const SizedBox(height: 12),
          if (s.gate == 'publish') PublishGate(derivatives: s.derivatives, busy: _busy, onAnswer: _answerPublish),
          if (detail.canHoldAutoPublish) AutoPublishBanner(busy: _busy, onHold: () => _post('hold', 'Held.')),
          if (reviewable && s.stale) const StaleNotice(),
          if (reviewable && detail.quality != null) QualityPanel(quality: detail.quality!),
          if (s.derivatives.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('Channels', style: titles.titleMedium),
            for (final d in s.derivatives) DerivativeTile(derivative: d),
          ],
          const Divider(height: 32),
          Text(reviewable ? 'Article — edits here are captured on approve (FR-6.9)' : 'Article', style: titles.titleMedium),
          const SizedBox(height: 8),
          detail.markdown == null
              ? const Text('Body purged (DR-9.11) — the published copy lives in Sanity.')
              : TextField(
                  controller: _markdown,
                  maxLines: null,
                  readOnly: !reviewable,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.5),
                  decoration: const InputDecoration(border: OutlineInputBorder()),
                ),
          const SizedBox(height: 96),
        ],
      ),
      bottomNavigationBar: DraftActions(
        status: s.status,
        reviewable: reviewable,
        stale: s.stale,
        canChangeAngle: detail.angleProposals.length > 1,
        busy: _busy,
        onApprove: _approve,
        onRevise: _revise,
        onChangeAngle: _changeAngle,
        onReject: _reject,
        onCancelSchedule: () => _post('cancel-schedule', 'Back to pending review (FR-7.8).'),
        onRetract: () => _post('retract', 'Retracted (FR-7.6).', pop: true),
      ),
    );
  }
}
