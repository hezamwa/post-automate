import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../widgets/gates/option_gate.dart';
import '../widgets/gates/outline_gate.dart';
import 'draft_detail.dart';

/// One run (spec §4): renders whichever gate it is waiting on from GET /runs/:id and
/// answers it with POST /runs/:id/gates/:gate. The publish gate lives on the draft.
class RunDetailScreen extends StatefulWidget {
  const RunDetailScreen({super.key, required this.runId});
  final String runId;

  @override
  State<RunDetailScreen> createState() => _RunDetailScreenState();
}

class _RunDetailScreenState extends State<RunDetailScreen> {
  RunDetail? _detail;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final res = await ApiClient.instance.get('/runs/${widget.runId}');
      setState(() {
        _detail = RunDetail.fromJson(res);
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _answer(String gate, Map<String, dynamic> body) async {
    setState(() => _busy = true);
    try {
      await ApiClient.instance.post('/runs/${widget.runId}/gates/$gate', body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Got it — the run continues.')));
      Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openDraft(String draftId) => Navigator.of(context)
      .pushReplacement(MaterialPageRoute<void>(builder: (_) => DraftDetailScreen(draftId: draftId)));

  static const _titles = {
    'topic': 'Choose a topic',
    'angle': 'Choose an angle',
    'outline': 'Check the outline',
    'image': 'Choose a hero image',
    'publish': 'Choose when to publish',
  };

  Widget _gateBody(RunDetail d, GateView gate) => switch (gate.name) {
        'outline' => OutlineGate(outline: d.outline, busy: _busy, onAnswer: (b) => _answer('outline', b)),
        'publish' => FilledButton(
            onPressed: d.draftId == null ? null : () => _openDraft(d.draftId!),
            child: const Text('Open the draft to publish')),
        _ => OptionGate(gate: gate, busy: _busy, onAnswer: (b) => _answer(gate.name, b)),
      };

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    if (_error != null) return Scaffold(appBar: AppBar(), body: Center(child: Text(_error!)));
    if (d == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    final gate = d.gate;
    return Scaffold(
      appBar: AppBar(title: Text(gate == null ? 'Run' : _titles[gate.name] ?? gate.name)),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(d.run.topicTitle ?? '${d.run.trigger} run', style: Theme.of(context).textTheme.titleMedium),
            Text('State: ${d.run.state.replaceAll('_', ' ')}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 16),
            if (gate != null) _gateBody(d, gate),
            if (gate == null) const Text('This run is not waiting for you right now.'),
            if (gate == null && d.draftId != null)
              TextButton(onPressed: () => _openDraft(d.draftId!), child: const Text('Open the draft')),
            if (d.choices.isNotEmpty) ...[
              const Divider(height: 32),
              Text('Choices so far', style: Theme.of(context).textTheme.titleSmall),
              for (final c in d.choices)
                Text('• ${c.gate}: ${c.source == 'auto' ? 'automatic' : 'you chose'}${c.freeText != null ? ' — "${c.freeText}"' : ''}'),
            ],
          ],
        ),
      ),
    );
  }
}
