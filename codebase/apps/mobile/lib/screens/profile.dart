import 'dart:convert';

import 'package:flutter/material.dart';

import '../api.dart';
import '../widgets/profile/connected_accounts.dart';
import '../widgets/profile/fields.dart';
import '../widgets/profile/publishing_section.dart';
import '../widgets/profile/topics_section.dart';
import '../widgets/profile/writing_section.dart';
import 'my_data.dart';

/// The profile page (FR-3.11): edits the active profile and saves the whole payload as a
/// new version (FR-3.10). Identity, domain, example posts and the compliance block are
/// kept as loaded — they are not edited here.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Json? _profile;
  int? _version;
  bool _dirty = false;
  bool _busy = false;
  String? _error;
  int _formKey = 0; // bumped on reload so the fields re-read their initial values

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final res = await ApiClient.instance.get('/profile');
      setState(() {
        // a deep copy: the fields edit it in place
        _profile = jsonDecode(jsonEncode(res['profile'])) as Json;
        _version = res['version'] as int;
        _dirty = false;
        _error = null;
        _formKey++;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      final res = await ApiClient.instance.request('PATCH', '/profile', body: _profile);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Saved as version ${res['version']}.')));
      await _reload();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _changed() => setState(() => _dirty = true);

  @override
  Widget build(BuildContext context) {
    final profile = _profile;
    if (_error != null) return Center(child: Text(_error!, textAlign: TextAlign.center));
    if (profile == null) return const Center(child: CircularProgressIndicator());
    return Scaffold(
      body: ListView(
        key: ValueKey(_formKey),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
        children: [
          Row(children: [
            Expanded(child: Text('Profile version $_version', style: Theme.of(context).textTheme.bodySmall)),
            TextButton.icon(
              icon: const Icon(Icons.folder_open_outlined),
              label: const Text('My data'),
              onPressed: () =>
                  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const MyDataScreen())),
            ),
          ]),
          WritingSection(profile: profile, onChanged: _changed),
          TopicsSection(profile: profile, onChanged: _changed),
          PublishingSection(profile: profile, onChanged: _changed),
          const ConnectedAccounts(),
        ],
      ),
      floatingActionButton: _dirty
          ? FloatingActionButton.extended(
              onPressed: _busy ? null : _save,
              icon: const Icon(Icons.save_outlined),
              label: const Text('Save as new version'),
            )
          : null,
    );
  }
}
