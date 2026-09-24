import 'package:flutter/material.dart';

import '../api.dart';

/// "My data" (FR-3.15): what the system stores about you, read-only. Deletion is an
/// administrator action (FR-2.6).
class MyDataScreen extends StatefulWidget {
  const MyDataScreen({super.key});

  @override
  State<MyDataScreen> createState() => _MyDataScreenState();
}

class _MyDataScreenState extends State<MyDataScreen> {
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    ApiClient.instance.get('/me/data').then(
          (d) => setState(() => _data = d),
          onError: (Object e) => setState(() => _error = '$e'),
        );
  }

  String _date(Object? raw) => raw == null ? '—' : DateTime.parse(raw as String).toLocal().toString().substring(0, 16);

  List<Widget> _section(String title, List<dynamic> rows, String Function(Map<String, dynamic>) line) => [
        Padding(
          padding: const EdgeInsets.only(top: 20, bottom: 6),
          child: Text('$title (${rows.length})', style: Theme.of(context).textTheme.titleMedium),
        ),
        if (rows.isEmpty) const Text('Nothing stored.'),
        for (final r in rows.cast<Map<String, dynamic>>())
          Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(line(r), maxLines: 3, overflow: TextOverflow.ellipsis)),
      ];

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final account = d?['account'] as Map<String, dynamic>?;
    final spend = d?['spend'] as Map<String, dynamic>?;
    return Scaffold(
      appBar: AppBar(title: const Text('My data')),
      body: _error != null
          ? Center(child: Text(_error!))
          : d == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(padding: const EdgeInsets.all(16), children: [
                  const Text('Read-only. To have your data deleted, ask an administrator.'),
                  ..._section('Account', [account!], (a) =>
                      '${a['displayName']} · ${a['email']} · ${a['role']}\nSite: ${a['sanityProjectId'] ?? '—'} · since ${_date(a['createdAt'])}'),
                  ..._section('Spend this month', [spend!], (s) =>
                      '\$${s['monthToDateUsd']} of \$${s['monthlyCapUsd']} · ${s['maxRunsPerDay']} runs/day · auto-publish ${s['autoPublish'] == true ? 'on' : 'off'}'),
                  ..._section('Profile versions', d['profileVersions'] as List<dynamic>,
                      (p) => 'v${p['version']} · ${p['status']} · ${_date(p['createdAt'])}'),
                  ..._section('Connected accounts', (d['socialAccounts'] as List<dynamic>?) ?? [],
                      (a) => '${a['provider']} · ${a['handle']} · ${a['state']} · connected ${_date(a['connectedAt'])}'),
                  ..._section('Drafts', d['draftsByStatus'] as List<dynamic>, (r) => '${r['status']}: ${r['n']}'),
                  ..._section('Choices you made', d['gateChoices'] as List<dynamic>,
                      (g) => '${g['gate']} · ${g['source']}${g['freeText'] != null ? ' · "${g['freeText']}"' : ''} · ${_date(g['chosenAt'])}'),
                  ..._section('Revision instructions', d['revisions'] as List<dynamic>,
                      (r) => '#${r['revisionNo']} "${r['instructions']}" · ${_date(r['createdAt'])}'),
                  ..._section('Your edits (diffs)', d['editDiffs'] as List<dynamic>,
                      (e) => '${_date(e['createdAt'])}\n${e['diff']}'),
                ]),
    );
  }
}
