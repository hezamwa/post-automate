import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// API client (AR-10.7: the app talks ONLY to the Worker API). JWT access token +
/// rotated refresh token (FR-2.2); one silent refresh-and-retry on 401. Base URL is
/// injectable for device builds: --dart-define=API_BASE=https://…
const apiBase = String.fromEnvironment('API_BASE', defaultValue: 'http://localhost:8787');

class ApiException implements Exception {
  ApiException(this.status, this.message, [this.body]);
  final int status;
  final String message;
  final Map<String, dynamic>? body;
  @override
  String toString() => message;
}

class SessionUser {
  SessionUser({required this.id, required this.email, required this.displayName, required this.role});
  final String id;
  final String email;
  final String displayName;
  final String role;

  factory SessionUser.fromJson(Map<String, dynamic> json) => SessionUser(
        id: json['id'] as String,
        email: json['email'] as String,
        displayName: json['displayName'] as String,
        role: json['role'] as String,
      );
}

class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  // Origin-keyed on web — hence the pinned dev port (tools/run-web.sh).
  final _storage = const FlutterSecureStorage();
  String? _accessToken;
  String? _refreshToken;
  SessionUser? user;

  Future<bool> restoreSession() async {
    _accessToken = await _storage.read(key: 'accessToken');
    _refreshToken = await _storage.read(key: 'refreshToken');
    final rawUser = await _storage.read(key: 'user');
    if (rawUser != null) {
      user = SessionUser.fromJson(jsonDecode(rawUser) as Map<String, dynamic>);
    }
    return _accessToken != null && user != null;
  }

  Future<void> _saveSession(Map<String, dynamic> body) async {
    _accessToken = body['accessToken'] as String;
    _refreshToken = body['refreshToken'] as String;
    user = SessionUser.fromJson(body['user'] as Map<String, dynamic>);
    await _storage.write(key: 'accessToken', value: _accessToken);
    await _storage.write(key: 'refreshToken', value: _refreshToken);
    await _storage.write(key: 'user', value: jsonEncode(body['user']));
  }

  Future<SessionUser> login(String email, String password) async {
    final res = await http.post(
      Uri.parse('$apiBase/auth/login'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );
    final body = _decode(res);
    if (res.statusCode != 200) throw ApiException(res.statusCode, _errorOf(body, res.statusCode));
    await _saveSession(body);
    return user!;
  }

  Future<void> logout() async {
    _accessToken = null;
    _refreshToken = null;
    user = null;
    await _storage.deleteAll();
  }

  Future<bool> _tryRefresh() async {
    final token = _refreshToken;
    if (token == null) return false;
    final res = await http.post(
      Uri.parse('$apiBase/auth/refresh'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'refreshToken': token}),
    );
    if (res.statusCode != 200) {
      await logout();
      return false;
    }
    await _saveSession(_decode(res));
    return true;
  }

  /// Authenticated JSON request; refreshes once on 401 (the token lives 15 minutes).
  Future<Map<String, dynamic>> request(String method, String path, {Object? body}) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (_accessToken == null) throw ApiException(401, 'Not logged in.');
      final res = await http.Client().send(
        http.Request(method, Uri.parse('$apiBase$path'))
          ..headers.addAll({
            'authorization': 'Bearer $_accessToken',
            if (body != null) 'content-type': 'application/json',
          })
          ..body = body != null ? jsonEncode(body) : '',
      );
      final full = await http.Response.fromStream(res);
      if (full.statusCode == 401 && attempt == 0 && await _tryRefresh()) continue;
      final decoded = _decode(full);
      if (full.statusCode >= 400) {
        throw ApiException(full.statusCode, _errorOf(decoded, full.statusCode), decoded);
      }
      return decoded;
    }
    throw ApiException(401, 'Session expired — log in again.');
  }

  Future<Map<String, dynamic>> get(String path) => request('GET', path);
  Future<Map<String, dynamic>> post(String path, [Object? body]) => request('POST', path, body: body ?? {});
  Future<Map<String, dynamic>> delete(String path) => request('DELETE', path);

  /// design §9: refresh the device's FCM token on launch. No-op until the mobile
  /// Firebase config lands — web builds skip push entirely (agreed v1 scope).
  Future<void> registerFcmToken(String token) => post('/auth/fcm-token', {'token': token});

  Map<String, dynamic> _decode(http.Response res) {
    try {
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  String _errorOf(Map<String, dynamic> body, int status) =>
      (body['error'] as String?) ?? 'Request failed (HTTP $status)';
}
