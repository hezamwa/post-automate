import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';

/// Runs: history + "run discovery now" + request-a-topic (FR-5.8, with the FR-7.7
/// banned-topic warn/override flow) + the 3-angle picker for parked user runs (FR-6.3).
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
        _runs = (res['runs'] as List<dynamic>)
            .map((r) => RunSummary.fromJson(r as Map<String, dynamic>))
            .toList();
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  void _snack(String message) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));

  Future<void> _act(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
      await reload();
    } on ApiException catch (e) {
      if (mounted) _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _trigger() => _act(() async {
        await ApiClient.instance.post('/runs/trigger');
        if (mounted) _snack('Run started — discovery is finding topics.');
      });

  Future<void> _requestTopic() async {
    final title = TextEditingController();
    final notes = TextEditingController();
    final links = TextEditingController();
    final submitted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Write about my topic (FR-5.8)'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: title, decoration: const InputDecoration(labelText: 'Topic title'), autofocus: true),
            TextField(controller: notes, decoration: const InputDecoration(labelText: 'Notes (optional)'), maxLines: 2),
            TextField(
                controller: links,
                decoration: const InputDecoration(labelText: 'Source links, one per line (optional)'),
                maxLines: 2),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Request')),
        ],
      ),
    );
    if (submitted != true || title.text.trim().isEmpty) return;

    final body = <String, dynamic>{
      'title': title.text.trim(),
      if (notes.text.trim().isNotEmpty) 'notes': notes.text.trim(),
      if (links.text.trim().isNotEmpty)
        'links': links.text.trim().split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList(),
    };
    await _act(() async {
      try {
        final res = await ApiClient.instance.post('/runs/request', body);
        final similar =
            ((res['warnings'] as Map<String, dynamic>?)?['similarRecentTopics'] as List<dynamic>?) ?? [];
        if (mounted) {
          _snack(similar.isEmpty
              ? 'Run started — you will pick from 3 angles once research is done.'
              : 'Run started. Heads-up: similar to recent "${similar.first}" (FR-5.7).');
        }
      } on ApiException catch (e) {
        // FR-7.7: banned-topic collision → explicit override required
        if (e.status == 409 && e.body?['requiresOverride'] == true) {
          if (!mounted) return;
          final override = await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('Banned-topic collision (FR-7.7)'),
              content: Text(e.message),
              actions: [
                TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true), child: const Text('Override and proceed')),
              ],
            ),
          );
          if (override == true) {
            await ApiClient.instance.post('/runs/request', {...body, 'overrideBannedTopics': true});
            if (mounted) _snack('Run started with the banned-topic override.');
          }
        } else {
          rethrow;
        }
      }
    });
  }

  Future<void> _pickAngle(RunSummary run) async {
    final index = await showDialog<int>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Pick the angle (FR-6.3)'),
        children: [
          for (var i = 0; i < run.angleProposals.length; i++)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, i),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${run.angleProposals[i]['headline']}',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text('${run.angleProposals[i]['thesis'] ?? ''}',
                      style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
        ],
      ),
    );
    if (index == null) return;
    await _act(() async {
      await ApiClient.instance.post('/runs/${run.id}/angle', {'angleIndex': index});
      if (mounted) _snack('Angle chosen — writing the article.');
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Center(child: Text(_error!, textAlign: TextAlign.center));
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
                '${r.state}${r.error != null ? ' — ${r.error}' : ''}\n'
                '${r.startedAt.toLocal().toString().substring(0, 16)}',
              ),
              isThreeLine: r.error != null,
              trailing: r.awaitsAngleChoice
                  ? FilledButton(
                      onPressed: _busy ? null : () => _pickAngle(r), child: const Text('Pick angle'))
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
            onPressed: _busy ? null : _trigger,
            icon: const Icon(Icons.play_arrow),
            label: const Text('Run now'),
          ),
        ],
      ),
    );
  }
}
