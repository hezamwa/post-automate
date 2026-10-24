import 'package:flutter/material.dart';

import 'fields.dart';

const _languages = {'en': 'English', 'ar': 'Arabic'};
const _askAuto = {'ask': 'Ask me', 'auto': 'Decide for me'};
const _gates = {
  'topic': 'Topic',
  'angle': 'Angle',
  'outline': 'Outline',
  'image': 'Hero image',
  'derivatives': 'X / LinkedIn / translation',
  'publish': 'Publish time',
};

/// Language, translation, channels, disclosure, social posting, scheduled runs, and the
/// ask/auto setting per step (FR-3.7, FR-3.12–3.14, FR-6.18, article-workflow §4.1).
class PublishingSection extends StatelessWidget {
  const PublishingSection({super.key, required this.profile, required this.onChanged});
  final Json profile;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final translation = profile['translation'] as Json;
    final gates = (profile['gates'] ??= <String, dynamic>{}) as Json;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SectionTitle('Language'),
      EnumField(label: 'Articles are written in', map: profile, field: 'primaryLanguage', options: _languages, onChanged: onChanged),
      SwitchField(label: 'Also publish a translated edition', map: translation, field: 'enabled', onChanged: onChanged),
      if (translation['enabled'] == true)
        EnumField(label: 'Translate into', map: translation, field: 'targetLanguage', options: _languages, onChanged: onChanged),
      const SectionTitle('Channels'),
      ListChips(map: profile, field: 'channels', options: const {'x': 'X', 'linkedin': 'LinkedIn'}, onChanged: onChanged),
      const SizedBox(height: 8),
      EnumField(
          label: 'Posting to X / LinkedIn',
          map: profile,
          field: 'socialPosting',
          options: const {'confirm': 'I tap Post after the article is live', 'auto': 'Post as soon as the article is live'},
          onChanged: onChanged),
      SwitchField(
          label: 'AI disclosure note on articles', map: profile, field: 'aiDisclosure', onChanged: onChanged),
      SwitchField(
          label: 'Scheduled runs',
          subtitle: 'Start a run on your preferred days while you use the app regularly',
          map: profile,
          field: 'autoRun',
          onChanged: onChanged),
      const SectionTitle('When should a run ask you?'),
      for (final e in _gates.entries)
        EnumField(label: e.value, map: gates, field: e.key, options: _askAuto, onChanged: onChanged),
    ]);
  }
}
