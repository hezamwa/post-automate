import 'package:flutter/material.dart';

import '../../models.dart';

/// Spec §3 step 8: the quality-check findings, shown on the review screen.
class QualityPanel extends StatelessWidget {
  const QualityPanel({super.key, required this.quality});
  final QualityCheck quality;

  @override
  Widget build(BuildContext context) {
    final failed = quality.findings.where((f) => !f.ok).toList();
    final headline = quality.passed
        ? (quality.autoRevised ? 'Quality check passed after one automatic revision' : 'Quality check passed')
        : 'Quality check found issues — please review them';
    return Card(
      color: quality.passed ? null : Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(headline, style: const TextStyle(fontWeight: FontWeight.w600)),
          for (final f in failed) Text('• ${f.check.replaceAll('_', ' ')}: ${f.note}'),
        ]),
      ),
    );
  }
}

/// Spec §5.1: the instance is gone — approve and reject still work, revise does not.
class StaleNotice extends StatelessWidget {
  const StaleNotice({super.key});

  @override
  Widget build(BuildContext context) => const Card(
        child: Padding(
          padding: EdgeInsets.all(12),
          child: Text('This draft has waited a long time. You can still approve, edit or reject it; '
              'revise and change angle are no longer available.'),
        ),
      );
}

/// Spec §5.2: the auto-publish warning, with its one-tap Hold.
class AutoPublishBanner extends StatelessWidget {
  const AutoPublishBanner({super.key, required this.onHold, required this.busy});
  final VoidCallback onHold;
  final bool busy;

  @override
  Widget build(BuildContext context) => Card(
        color: Theme.of(context).colorScheme.tertiaryContainer,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(children: [
            const Expanded(child: Text('Auto-publish will publish this draft at your next slot unless you hold it.')),
            FilledButton(onPressed: busy ? null : onHold, child: const Text('Hold')),
          ]),
        ),
      );
}
