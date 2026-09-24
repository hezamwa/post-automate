import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../widgets/mood.dart';
import '../widgets/topic_request_dialog.dart';
import 'draft_detail.dart';
import 'run_detail.dart';

/// Runs: history + **Generate** + "My topic" (FR-5.8, FR-7.7 override). A run waiting on a
/// gate opens its gate screen (spec §4); a busy Generate opens the waiting draft (spec §2).
class RunsScreen extends StatefulWidget {
  const RunsScreen({super.key});

  @override
  State<RunsScreen> createState() => RunsScreenState();
}

class RunsScreenState extends State<RunsScreen> {
  List<RunSummary>? _runs;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    try {
      final res = await ApiClient.instance.get('/runs');
      setState(() {
        _runs = (res['runs'] as List<dynamic>).map((r) => RunSummary.fromJson(r as Map<String, dynamic>)).toList();
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  void _snack(String message) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));

  Future<void> _open(Widget screen) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
    await reload();
  }

  Future<void> _act(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
      await reload();
    } on ApiException catch (e) {
      // Spec §2: one undecided draft at a time — Generate opens it instead of starting a run.
      final existing = e.body?['existingDraftId'] as String?;
      if (e.status == 409 && existing != null && mounted) {
        _snack('Finish the draft that is waiting for you first.');
        await _open(DraftDetailScreen(draftId: existing));
      } else if (mounted) {
        _snack(e.message);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _generate() async {
    final mood = await moodDialog(context);
    if (mood == null) return;
    await _act(() async {
      final res = await ApiClient.instance.post('/runs/trigger', {'mood': mood});
      if (!mounted) return;
      _snack('Generating — finding what is trending for you.');
      await _open(RunDetailScreen(runId: res['runId'] as String));
    });
  }

  Future<void> _requestTopic() async {
    final body = await topicRequestDialog(context);
    if (body == null) return;
    await _act(() async {
      try {
        await _startTopic(body);
      } on ApiException catch (e) {
        if (e.status != 409 || e.body?['requiresOverride'] != true) rethrow;
        if (!mounted || !await bannedTopicOverrideDialog(context, e.message)) {
          return;
        }
        await _startTopic({...body, 'overrideBannedTopics': true});
      }
    });
  }

  Future<void> _startTopic(Map<String, dynamic> body) async {
    final res = await ApiClient.instance.post('/runs/request', body);
    final similar = ((res['warnings'] as Map<String, dynamic>?)?['similarRecentTopics'] as List<dynamic>?) ?? [];
    if (!mounted) return;
    _snack(
      similar.isEmpty ? 'Researching your topic.' : 'Started. Heads-up: similar to recent "${similar.first}" (FR-5.7).',
    );
    await _open(RunDetailScreen(runId: res['runId'] as String));
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(child: Text(_error!, textAlign: TextAlign.center));
    }
    final runs = _runs;
    if (runs == null) return const Center(child: CircularProgressIndicator());
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: reload,
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          itemCount: runs.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, i) {
            final r = runs[i];
            return ListTile(
              title: Text(r.topicTitle ?? '${r.trigger} run'),
              subtitle: Text(
                '${r.awaitsInput ? 'waiting for your ${r.gate} choice' : r.state.replaceAll('_', ' ')}'
                '${r.error != null ? ' — ${r.error}' : ''}\n'
                '${r.startedAt.toLocal().toString().substring(0, 16)}',
              ),
              isThreeLine: r.error != null,
              onTap: () => _open(RunDetailScreen(runId: r.id)),
              trailing: r.awaitsInput
                  ? FilledButton(
                      onPressed: _busy ? null : () => _open(RunDetailScreen(runId: r.id)),
                      child: const Text('Answer'),
                    )
                  : null,
            );
          },
        ),
      ),
      floatingActionButton: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          FloatingActionButton.extended(
            heroTag: 'topic',
            onPressed: _busy ? null : _requestTopic,
            icon: const Icon(Icons.lightbulb_outline),
            label: const Text('My topic'),
          ),
          const SizedBox(height: 8),
          FloatingActionButton.extended(
            heroTag: 'run',
            onPressed: _busy ? null : _generate,
            icon: const Icon(Icons.auto_awesome),
            label: const Text('Generate'),
          ),
        ],
      ),
    );
  }
}
