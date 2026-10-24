import 'package:flutter/material.dart';

import 'fields.dart';

const _days = {'mon': 'Mon', 'tue': 'Tue', 'wed': 'Wed', 'thu': 'Thu', 'fri': 'Fri', 'sat': 'Sat', 'sun': 'Sun'};

/// Topic policy and cadence (FR-3.5–3.6).
class TopicsSection extends StatelessWidget {
  const TopicsSection({super.key, required this.profile, required this.onChanged});
  final Json profile;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final topics = profile['topicPolicy'] as Json;
    final cadence = profile['cadence'] as Json;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SectionTitle('Topics'),
      _InterestsField(topics: topics, onChanged: onChanged),
      CommaListField(label: 'Never write about', map: topics, field: 'bannedTopics', onChanged: onChanged),
      const SectionTitle('Cadence'),
      TextValueField(label: 'Posts per week (1–7)', map: cadence, field: 'postsPerWeek', number: true, onChanged: onChanged),
      TextValueField(label: 'Preferred hour (UTC, 0–23)', map: cadence, field: 'preferredHourUtc', number: true, onChanged: onChanged),
      const Text('Preferred days'),
      const SizedBox(height: 4),
      ListChips(map: cadence, field: 'preferredDays', options: _days, onChanged: onChanged),
    ]);
  }
}

/// Weighted interests, one per line as "topic = weight" (weight 1–5, default 3).
class _InterestsField extends StatelessWidget {
  const _InterestsField({required this.topics, required this.onChanged});
  final Json topics;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final lines = ((topics['interests'] as List<dynamic>?) ?? [])
        .cast<Map<String, dynamic>>()
        .map((i) => '${i['topic']} = ${i['weight']}')
        .join('\n');
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        initialValue: lines,
        maxLines: null,
        decoration: const InputDecoration(
            labelText: 'Interests — one per line, "topic = weight" (1–5)', border: OutlineInputBorder()),
        onChanged: (v) {
          topics['interests'] = [
            for (final line in v.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty))
              {
                'topic': line.split('=').first.trim(),
                'weight': (int.tryParse(line.contains('=') ? line.split('=').last.trim() : '') ?? 3).clamp(1, 5),
              },
          ];
          onChanged();
        },
      ),
    );
  }
}
