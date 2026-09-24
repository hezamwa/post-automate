import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:post_automate_mobile/widgets/profile/publishing_section.dart';
import 'package:post_automate_mobile/widgets/profile/topics_section.dart';

// The profile page edits the loaded JSON in place (FR-3.11); these check the shapes the
// Worker's profileSchema expects come out of the fields.
Map<String, dynamic> _profile() => {
      'primaryLanguage': 'en',
      'translation': {'enabled': false},
      'channels': ['x'],
      'socialPosting': 'confirm',
      'aiDisclosure': false,
      'autoRun': false,
      'gates': {'topic': 'auto'},
      'topicPolicy': {
        'interests': [
          {'topic': 'ai', 'weight': 5},
        ],
        'bannedTopics': <String>[],
      },
      'cadence': {'postsPerWeek': 2, 'preferredDays': ['mon'], 'preferredHourUtc': 9},
    };

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child)));

void main() {
  testWidgets('channels and scheduled runs edit the map', (tester) async {
    final profile = _profile();
    var changes = 0;
    await tester.pumpWidget(_host(PublishingSection(profile: profile, onChanged: () => changes++)));
    await tester.tap(find.text('LinkedIn'));
    await tester.tap(find.text('Scheduled runs'));
    await tester.pump();
    expect(profile['channels'], ['x', 'linkedin']);
    expect(profile['autoRun'], isTrue);
    expect(changes, 2);
  });

  testWidgets('interests parse "topic = weight" lines, weights clamped to 1–5', (tester) async {
    final profile = _profile();
    await tester.pumpWidget(_host(TopicsSection(profile: profile, onChanged: () {})));
    await tester.enterText(find.widgetWithText(TextFormField, 'ai = 5'), 'ai = 5\nmobile dev = 9\nflutter');
    expect((profile['topicPolicy'] as Map)['interests'], [
      {'topic': 'ai', 'weight': 5},
      {'topic': 'mobile dev', 'weight': 5},
      {'topic': 'flutter', 'weight': 3},
    ]);
  });
}
