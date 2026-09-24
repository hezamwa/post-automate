import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api.dart';
import 'fields.dart';

const _names = {'x': 'X', 'linkedin': 'LinkedIn'};

/// Connected accounts (FR-18.1, FR-18.7): connect opens the platform's own consent page —
/// you log in there, never here (NFR-11.8). Reloads when the app comes back to the front.
class ConnectedAccounts extends StatefulWidget {
  const ConnectedAccounts({super.key});

  @override
  State<ConnectedAccounts> createState() => _ConnectedAccountsState();
}

class _ConnectedAccountsState extends State<ConnectedAccounts> with WidgetsBindingObserver {
  Map<String, Map<String, dynamic>> _byProvider = {};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _reload();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _reload();
  }

  Future<void> _reload() async {
    try {
      final res = await ApiClient.instance.get('/social/accounts');
      final list = (res['accounts'] as List<dynamic>).cast<Map<String, dynamic>>();
      if (mounted) setState(() => _byProvider = {for (final a in list) a['provider'] as String: a});
    } on ApiException catch (_) {
      // the section stays empty; connecting reports its own errors
    }
  }

  Future<void> _run(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _connect(String provider) => _run(() async {
        final res = await ApiClient.instance.post('/social/$provider/connect');
        await launchUrl(Uri.parse(res['authorizeUrl'] as String), mode: LaunchMode.externalApplication);
      });

  Future<void> _disconnect(String provider) => _run(() async {
        final res = await ApiClient.instance.delete('/social/$provider');
        final note = res['note'] as String?;
        if (note != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(note)));
        await _reload();
      });

  String _status(Map<String, dynamic>? a) {
    if (a == null) return 'Not connected';
    final expires = a['expiresAt'] == null ? '' : ' · until ${(a['expiresAt'] as String).substring(0, 10)}';
    return switch (a['state']) {
      'expired' => '${a['handle']} — expired, reconnect',
      'expiring' => '${a['handle']} — expiring soon$expires',
      _ => '${a['handle']}$expires',
    };
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          const Expanded(child: SectionTitle('Connected accounts')),
          IconButton(onPressed: _busy ? null : _reload, icon: const Icon(Icons.refresh), tooltip: 'Refresh'),
        ]),
        for (final p in _names.keys)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(_names[p]!),
            subtitle: Text(_status(_byProvider[p])),
            trailing: Wrap(spacing: 4, children: [
              if (_byProvider[p] == null || _byProvider[p]!['state'] != 'connected')
                FilledButton(
                    onPressed: _busy ? null : () => _connect(p),
                    child: Text(_byProvider[p] == null ? 'Connect' : 'Reconnect')),
              if (_byProvider[p] != null)
                TextButton(onPressed: _busy ? null : () => _disconnect(p), child: const Text('Disconnect')),
            ]),
          ),
        Text('You sign in on X or LinkedIn itself. This app never sees your password.',
            style: Theme.of(context).textTheme.bodySmall),
      ]);
}
