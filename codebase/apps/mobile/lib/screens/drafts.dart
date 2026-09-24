import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import 'draft_detail.dart';

/// Drafts queue (design §15): pending first, each with its derivative outcomes; a draft
/// waiting at the publish gate reads "ready to publish", a stale one says so (spec §5.1).
class DraftsScreen extends StatefulWidget {
  const DraftsScreen({super.key});

  @override
  State<DraftsScreen> createState() => DraftsScreenState();
}

class DraftsScreenState extends State<DraftsScreen> {
  List<DraftSummary>? _drafts;
  String? _error;

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    try {
      final res = await ApiClient.instance.get('/drafts');
      setState(() {
        _drafts = (res['drafts'] as List<dynamic>)
            .map((d) => DraftSummary.fromJson(d as Map<String, dynamic>))
            .toList();
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  Color _statusColor(BuildContext context, String status) => switch (status) {
        'pending_approval' => Colors.orange,
        'revising' => Colors.orange,
        'scheduled' => Colors.blue,
        'published' => Colors.green,
        'rejected' || 'retracted' => Colors.grey,
        _ => Theme.of(context).colorScheme.primary,
      };

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(child: Text(_error!, textAlign: TextAlign.center));
    }
    final drafts = _drafts;
    if (drafts == null) return const Center(child: CircularProgressIndicator());
    if (drafts.isEmpty) {
      return const Center(child: Text('No drafts yet — tap Generate on the Runs tab.'));
    }
    return RefreshIndicator(
      onRefresh: reload,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: drafts.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final d = drafts[i];
          final failed = d.derivatives.where((x) => x.isIssue).length;
          final label = d.gate == 'publish' ? 'ready to publish' : d.status.replaceAll('_', ' ');
          return ListTile(
            title: Text(d.angleHeadline ?? 'Draft ${d.id.substring(0, 8)}',
                maxLines: 2, overflow: TextOverflow.ellipsis),
            subtitle: Text(
              '${d.createdAt.toLocal().toString().substring(0, 16)}'
              '${d.publishAt != null ? ' · publishes ${d.publishAt!.toLocal().toString().substring(0, 16)}' : ''}'
              '${failed > 0 ? ' · $failed channel issue${failed > 1 ? 's' : ''}' : ''}'
              '${d.stale && d.status == 'pending_approval' ? ' · waiting a long time' : ''}',
            ),
            trailing: Chip(
              label: Text(label),
              backgroundColor: _statusColor(context, d.status).withValues(alpha: 0.15),
              side: BorderSide.none,
            ),
            onTap: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => DraftDetailScreen(draftId: d.id)),
              );
              await reload();
            },
          );
        },
      ),
    );
  }
}
