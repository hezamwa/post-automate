import 'package:flutter/material.dart';

import 'fields.dart';

/// Voice and audience (FR-3.3–3.4).
class WritingSection extends StatelessWidget {
  const WritingSection({super.key, required this.profile, required this.onChanged});
  final Json profile;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final voice = profile['voice'] as Json;
    final audience = profile['audience'] as Json;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SectionTitle('Voice'),
      CommaListField(label: 'Tone', map: voice, field: 'tone', onChanged: onChanged),
      EnumField(
          label: 'Formality',
          map: voice,
          field: 'formality',
          options: const {'casual': 'Casual', 'neutral': 'Neutral', 'formal': 'Formal'},
          onChanged: onChanged),
      EnumField(
          label: 'Sentence length',
          map: voice,
          field: 'sentenceLength',
          options: const {'short': 'Short', 'mixed': 'Mixed', 'long': 'Long'},
          onChanged: onChanged),
      EnumField(
          label: 'Emoji',
          map: voice,
          field: 'emojiPolicy',
          options: const {'never': 'Never', 'sparing': 'Sparing', 'free': 'Free'},
          onChanged: onChanged),
      EnumField(
          label: 'Hashtags',
          map: voice,
          field: 'hashtagPolicy',
          options: const {'never': 'Never', 'few': 'A few', 'many': 'Many'},
          onChanged: onChanged),
      TextValueField(label: 'Hook style', map: voice, field: 'hookStyle', onChanged: onChanged),
      const SectionTitle('Audience'),
      TextValueField(label: 'Who you write for', map: audience, field: 'description', maxLines: 2, onChanged: onChanged),
      EnumField(
          label: 'Assumed expertise',
          map: audience,
          field: 'expertiseLevel',
          options: const {'general': 'General', 'informed': 'Informed', 'expert': 'Expert'},
          onChanged: onChanged),
    ]);
  }
}
