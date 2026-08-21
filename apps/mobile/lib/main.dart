import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/drafts.dart';
import 'screens/login.dart';
import 'screens/runs.dart';

// Thin client (DR-9.7): the backend does everything; this app renders queues and
// sends decisions. FCM registration is wired via ApiClient.registerFcmToken once the
// Firebase mobile config lands — web builds skip push (agreed v1 scope).

void main() {
  runApp(const PostAutomateApp());
}

class PostAutomateApp extends StatelessWidget {
  const PostAutomateApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Post-Automate',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF0B62D6), useMaterial3: true),
      home: const _Root(),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  bool? _loggedIn; // null while restoring the stored session

  @override
  void initState() {
    super.initState();
    ApiClient.instance.restoreSession().then((ok) {
      if (mounted) setState(() => _loggedIn = ok);
    });
  }

  @override
  Widget build(BuildContext context) {
    return switch (_loggedIn) {
      null => const Scaffold(body: Center(child: CircularProgressIndicator())),
      false => LoginScreen(onLoggedIn: () => setState(() => _loggedIn = true)),
      true => HomeScreen(onLoggedOut: () => setState(() => _loggedIn = false)),
    };
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.onLoggedOut});
  final VoidCallback onLoggedOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_tab == 0 ? 'Drafts' : 'Runs'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Center(
              child: Text(ApiClient.instance.user?.displayName ?? '',
                  style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Log out',
            onPressed: () async {
              await ApiClient.instance.logout();
              widget.onLoggedOut();
            },
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: const [DraftsScreen(), RunsScreen()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.article_outlined), label: 'Drafts'),
          NavigationDestination(icon: Icon(Icons.autorenew), label: 'Runs'),
        ],
      ),
    );
  }
}
