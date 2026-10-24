import 'package:flutter/material.dart';

/// The review screen's action bar: the draft gate's decisions while reviewable (revise and
/// change angle disabled on a stale draft, spec §5.1), cancel-schedule, retract.
class DraftActions extends StatelessWidget {
  const DraftActions({
    super.key,
    required this.status,
    required this.reviewable,
    required this.stale,
    required this.canChangeAngle,
    required this.busy,
    required this.onApprove,
    required this.onRevise,
    required this.onChangeAngle,
    required this.onReject,
    required this.onCancelSchedule,
    required this.onRetract,
  });
  final String status;
  final bool reviewable;
  final bool stale;
  final bool canChangeAngle;
  final bool busy;
  final VoidCallback onApprove;
  final VoidCallback onRevise;
  final VoidCallback onChangeAngle;
  final VoidCallback onReject;
  final VoidCallback onCancelSchedule;
  final VoidCallback onRetract;

  VoidCallback? _enabled(VoidCallback fn, {bool when = true}) => busy || !when ? null : fn;

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            if (reviewable) ...[
              FilledButton(onPressed: _enabled(onApprove), child: const Text('Approve')),
              OutlinedButton(onPressed: _enabled(onRevise, when: !stale), child: const Text('Revise')),
              if (canChangeAngle)
                OutlinedButton(onPressed: _enabled(onChangeAngle, when: !stale), child: const Text('Change angle')),
              OutlinedButton(onPressed: _enabled(onReject), child: const Text('Reject')),
            ],
            if (status == 'scheduled')
              OutlinedButton(onPressed: _enabled(onCancelSchedule), child: const Text('Cancel scheduled publish')),
            if (status == 'published') OutlinedButton(onPressed: _enabled(onRetract), child: const Text('Urgent retract')),
          ]),
        ),
      );
}
