import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models.dart';

const _names = {'x': 'X', 'linkedin': 'LinkedIn'};

/// The published article's channel posts (FR-18.3, FR-18.5): Post when awaiting your
/// confirmation, Retry when it failed or the account was not connected, a link once posted.
class SocialPanel extends StatelessWidget {
  const SocialPanel({super.key, required this.posts, required this.busy, required this.onPost});
  final List<SocialPost> posts;
  final bool busy;
  final void Function(String channel) onPost;

  (String, Color) _label(SocialPost p) => switch (p.status) {
        'posted' => ('posted', Colors.green),
        'awaiting_confirm' => ('ready to post', Colors.blue),
        'not_connected' => ('not connected', Colors.orange),
        'deleted' => ('deleted with the retract', Colors.grey),
        _ => ('failed', Colors.red),
      };

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Social posts', style: Theme.of(context).textTheme.titleMedium),
      for (final p in posts)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Row(children: [
            Text(_names[p.channel] ?? p.channel, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text(_label(p).$1, style: TextStyle(color: _label(p).$2, fontSize: 12)),
          ]),
          subtitle: p.reason == null ? null : Text(p.reason!, style: small),
          trailing: switch (p.status) {
            'awaiting_confirm' => FilledButton(onPressed: busy ? null : () => onPost(p.channel), child: const Text('Post')),
            'failed' || 'not_connected' =>
              OutlinedButton(onPressed: busy ? null : () => onPost(p.channel), child: const Text('Retry')),
            'posted' when p.postUrl != null => IconButton(
                icon: const Icon(Icons.open_in_new),
                tooltip: 'Open the post',
                onPressed: () => launchUrl(Uri.parse(p.postUrl!), mode: LaunchMode.externalApplication)),
            _ => null,
          },
        ),
    ]);
  }
}
