import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';

/// Review screen (design §15, FR-7.x): article + per-derivative outcomes, with
/// approve-now / approve-next-slot / edit / revise / change-angle / reject, the
/// per-draft translation override (FR-6.14), cancel-schedule and retract.
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
      final res = await ApiClient.instance.get('/drafts/${widget.draftId}');
      final detail = DraftDetail.fromJson(res);
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

  Future<void> _act(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decision(Map<String, dynamic> body, {String done = 'Done'}) => _act(() async {
        await ApiClient.instance.post('/drafts/${widget.draftId}/decision', body);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
        Navigator.of(context).pop();
      });

  /// FR-6.8: the medical reviewer must tick every compliance item before approving.
  Future<bool> _complianceChecklist() async {
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
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < items.length; i++)
                  CheckboxListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    title: Text(items[i], style: const TextStyle(fontSize: 13)),
                    value: checked[i],
                    onChanged: (v) => setDialogState(() => checked[i] = v ?? false),
                  ),
              ],
            ),
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

  Future<void> _approve() async {
    final detail = _detail!;
    if (detail.medical && !await _complianceChecklist()) return;
    if (!mounted) return;

    String? blogType;
    if (detail.supportsBlogType) {
      blogType = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Which blog? (design §8)'),
          children: [
            SimpleDialogOption(
                onPressed: () => Navigator.pop(context, 'public'),
                child: const Text('Public — general health education')),
            SimpleDialogOption(
                onPressed: () => Navigator.pop(context, 'em'),
                child: const Text('EM — emergency-medicine professionals')),
          ],
        ),
      );
      if (blogType == null) return;
      if (!mounted) return;
    }

    final mode = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Publish when? (FR-7.5)'),
        children: [
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'now'), child: const Text('Publish now')),
          SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'next_slot'),
              child: const Text('At my next preferred slot')),
        ],
      ),
    );
    if (mode == null) return;
    final edited = _markdown.text != _originalMarkdown ? _markdown.text : null;
    await _decision(
      {'action': 'approve', 'publishMode': mode, 'editedMarkdown': ?edited, 'blogType': ?blogType},
      done: mode == 'now' ? 'Approved — publishing.' : 'Approved — scheduled for your next slot.',
    );
  }

  Future<void> _revise() async {
    final controller = TextEditingController();
    final instructions = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Revision instructions (max 3 per draft, FR-7.9)'),
        content: TextField(controller: controller, maxLines: 4, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, controller.text), child: const Text('Request revision')),
        ],
      ),
    );
    if (instructions == null || instructions.trim().isEmpty) return;
    await _decision({'action': 'revise', 'instructions': instructions.trim()}, done: 'Revision requested.');
  }

  Future<void> _changeAngle() async {
    final proposals = _detail?.angleProposals ?? [];
    if (proposals.isEmpty) return;
    final index = await showDialog<int>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Regenerate from another angle (FR-7.9)'),
        children: [
          for (var i = 0; i < proposals.length; i++)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, i),
              child: Text('${proposals[i]['headline']}'),
            ),
        ],
      ),
    );
    if (index == null) return;
    await _decision({'action': 'change_angle', 'angleIndex': index}, done: 'Regenerating from the new angle.');
  }

  Future<void> _reject() async {
    final category = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Why reject? (FR-7.8)'),
        children: [
          SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'quality'),
              child: const Text('Content quality — tune my profile')),
          SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'changed_mind'),
              child: const Text('Wrong topic / changed my mind')),
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'other'), child: const Text('Other')),
        ],
      ),
    );
    if (category == null) return;
    await _decision({'action': 'reject', 'rejectionCategory': category}, done: 'Rejected — draft removed.');
  }

  Future<void> _requestTranslation() async {
    final target = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Translate this draft into… (FR-6.14)'),
        children: [
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'ar'), child: const Text('Arabic')),
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'en'), child: const Text('English')),
        ],
      ),
    );
    if (target == null) return;
    await _act(() async {
      final res = await ApiClient.instance
          .post('/drafts/${widget.draftId}/derivatives/translation', {'targetLanguage': target});
      final outcome = (res['derivative'] as Map<String, dynamic>)['outcome'];
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(outcome == 'produced'
              ? 'Translation added.'
              : 'Translation failed: ${(res['derivative'] as Map<String, dynamic>)['reason']}')));
      await _reload();
    });
  }

  Future<void> _dropTranslation() => _act(() async {
        await ApiClient.instance.delete('/drafts/${widget.draftId}/derivatives/translation');
        await _reload();
      });

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    if (_error != null) {
      return Scaffold(appBar: AppBar(), body: Center(child: Text(_error!)));
    }
    if (detail == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    }
    final s = detail.summary;
    final reviewable = s.status == 'pending_approval';
    final hasTranslation = s.derivatives.any((d) => d.kind == 'translation');

    return Scaffold(
      appBar: AppBar(title: Text(s.status.replaceAll('_', ' '))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (s.angleHeadline != null)
            Text(s.angleHeadline!, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),

          Text('Derivatives', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          for (final d in s.derivatives) _DerivativeTile(derivative: d),
          if (s.derivatives.isEmpty) const Text('No derivative records for this draft.'),
          if (reviewable)
            Align(
              alignment: Alignment.centerLeft,
              child: hasTranslation
                  ? TextButton(onPressed: _busy ? null : _dropTranslation, child: const Text('Drop translation'))
                  : TextButton(
                      onPressed: _busy ? null : _requestTranslation,
                      child: const Text('Request translation (FR-6.14)')),
            ),
          const Divider(height: 32),

          Text('Article — edits here are captured on approve (FR-6.9)',
              style: Theme.of(context).textTheme.titleMedium),
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
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (reviewable) ...[
                FilledButton(onPressed: _busy ? null : _approve, child: const Text('Approve')),
                OutlinedButton(onPressed: _busy ? null : _revise, child: const Text('Revise')),
                if (detail.angleProposals.length > 1)
                  OutlinedButton(onPressed: _busy ? null : _changeAngle, child: const Text('Change angle')),
                OutlinedButton(onPressed: _busy ? null : _reject, child: const Text('Reject')),
              ],
              if (s.status == 'scheduled')
                OutlinedButton(
                  onPressed: _busy
                      ? null
                      : () => _act(() async {
                            await ApiClient.instance.post('/drafts/${widget.draftId}/cancel-schedule');
                            if (!context.mounted) return;
                            ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(content: Text('Back to pending review (FR-7.8).')));
                            await _reload();
                          }),
                  child: const Text('Cancel scheduled publish'),
                ),
              if (s.status == 'published')
                OutlinedButton(
                  onPressed: _busy
                      ? null
                      : () => _act(() async {
                            await ApiClient.instance.post('/drafts/${widget.draftId}/retract');
                            if (!context.mounted) return;
                            ScaffoldMessenger.of(context)
                                .showSnackBar(const SnackBar(content: Text('Retracted (FR-7.6).')));
                            Navigator.of(context).pop();
                          }),
                  child: const Text('Urgent retract'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DerivativeTile extends StatelessWidget {
  const _DerivativeTile({required this.derivative});
  final Derivative derivative;

  @override
  Widget build(BuildContext context) {
    // DR-9.14: skipped (capability off) and failed (asked for, didn't arrive) MUST
    // render differently — the reason is shown either way.
    final (color, note) = switch (derivative.outcome) {
      'produced' => (Colors.green, null),
      'skipped' => (Colors.grey, derivative.reason ?? 'skipped'),
      _ => (Colors.red, derivative.reason ?? 'failed'),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.circle, size: 10, color: color),
            const SizedBox(width: 6),
            Text(derivative.label, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text(derivative.outcome, style: TextStyle(color: color, fontSize: 12)),
          ]),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(left: 16, top: 2),
              child: Text(note, style: Theme.of(context).textTheme.bodySmall),
            ),
          if (derivative.content != null && derivative.kind != 'translation')
            Padding(
              padding: const EdgeInsets.only(left: 16, top: 2),
              child: Text(derivative.content!,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}
