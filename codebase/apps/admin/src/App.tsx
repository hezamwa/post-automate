import { useState } from "react";
import { ApiError, clearSession, getSession, login, type SessionUser } from "./api";
import { MonitorView } from "./views/Monitor";
import { RoutesView } from "./views/Routes";
import { UsersView } from "./views/Users";

// Admin web dashboard v1 (OD-17, design §15): same Worker API, same JWT flow,
// role=admin required. Panels: monitor + switches · AI routes + tests · users.

type Tab = "monitor" | "routes" | "users";

function LoginView({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login panel">
      <h1>Post-Automate Admin</h1>
      <form onSubmit={(e) => void submit(e)}>
        <div>
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" style={{ width: "100%" }} />
        </div>
        <div>
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={{ width: "100%" }} />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !email || !password}>Log in</button>
      </form>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(() => getSession()?.user ?? null);
  const [tab, setTab] = useState<Tab>("monitor");

  if (!user) return <LoginView onLogin={setUser} />;

  return (
    <>
      <nav>
        <h1>Post-Automate Admin</h1>
        <span className="tabs" style={{ display: "flex", gap: "0.5rem", marginLeft: "1rem" }}>
          {(["monitor", "routes", "users"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </span>
        <span className="spacer" />
        <span className="who">{user.displayName}</span>
        <button
          onClick={() => {
            clearSession();
            setUser(null);
          }}
        >
          Log out
        </button>
      </nav>
      <main>
        {tab === "monitor" && <MonitorView />}
        {tab === "routes" && <RoutesView />}
        {tab === "users" && <UsersView selfId={user.id} />}
      </main>
    </>
  );
}
