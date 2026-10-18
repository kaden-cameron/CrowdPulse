import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import type { AuthConfig } from "@crowdpulse/shared";

// How the host page proves who it is (Doc 06). With Auth0, the browser holds only the public
// client ID; access tokens stay in memory and go out as `Authorization: Bearer`. Without Auth0
// (local dev only), a typed dev key goes out as `x-host-key`.

export type HostHeaders = Record<string, string>;

export interface HostAccess {
  mode: AuthConfig["mode"] | "loading" | "error";
  /** True once host requests can be attempted (signed in, or a dev key entered). */
  ready: boolean;
  userLabel: string | null;
  error: string | null;
  login(): void;
  logout(): void;
  getHeaders(): Promise<HostHeaders>;
  devKey: string;
  /** Commits a dev key (call on submit, not per keystroke, so `ready` flips once). */
  setDevKey(key: string): void;
}

const Ctx = createContext<HostAccess | null>(null);

export function useHostAccess(): HostAccess {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHostAccess must be used inside <HostAccessProvider>");
  return v;
}

const noop = () => {};
const DEV_KEY_STORAGE = "crowdpulse.hostKey";

export function HostAccessProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/auth/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setConfig)
      .catch((e: Error) => setError(`Could not load sign-in settings (${e.message})`));
  }, []);

  if (!config) {
    const value: HostAccess = {
      mode: error ? "error" : "loading",
      ready: false,
      userLabel: null,
      error,
      login: noop,
      logout: noop,
      getHeaders: async () => ({}),
      devKey: "",
      setDevKey: noop,
    };
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }

  if (config.mode === "dev-key") return <DevKeyAccess>{children}</DevKeyAccess>;

  return (
    <Auth0Provider
      domain={config.domain}
      clientId={config.clientId}
      authorizationParams={{
        audience: config.audience,
        redirect_uri: `${window.location.origin}/auth/callback`,
      }}
      onRedirectCallback={(appState) => navigate(appState?.returnTo ?? "/", { replace: true })}
    >
      <Auth0Access>{children}</Auth0Access>
    </Auth0Provider>
  );
}

function Auth0Access({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user, error, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();

  const getHeaders = useCallback(async (): Promise<HostHeaders> => {
    const token = await getAccessTokenSilently();
    return { authorization: `Bearer ${token}` };
  }, [getAccessTokenSilently]);

  const value = useMemo<HostAccess>(
    () => ({
      mode: "auth0",
      ready: !isLoading && isAuthenticated,
      userLabel: user ? (user.email ?? user.name ?? user.sub ?? "Signed in") : null,
      error: error?.message ?? null,
      login: () =>
        loginWithRedirect({ appState: { returnTo: window.location.pathname + window.location.search } }),
      logout: () => logout({ logoutParams: { returnTo: window.location.origin } }),
      getHeaders,
      devKey: "",
      setDevKey: noop,
    }),
    [isLoading, isAuthenticated, user, error, loginWithRedirect, logout, getHeaders],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function DevKeyAccess({ children }: { children: ReactNode }) {
  const [devKey, setDevKey] = useState(() => {
    try {
      return sessionStorage.getItem(DEV_KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(DEV_KEY_STORAGE, devKey);
    } catch {
      /* private mode */
    }
  }, [devKey]);

  const value = useMemo<HostAccess>(
    () => ({
      mode: "dev-key",
      ready: devKey.length > 0,
      userLabel: null,
      error: null,
      login: noop,
      logout: () => setDevKey(""),
      getHeaders: async () => ({ "x-host-key": devKey }),
      devKey,
      setDevKey,
    }),
    [devKey],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The dev-key form. The typed key stays local until "Sign in" (or Enter), so the host page doesn't
 * unlock on the first keystroke and pollers don't start with a partial key.
 */
export function DevKeySignIn() {
  const { devKey, setDevKey } = useHostAccess();
  const [draft, setDraft] = useState(devKey);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDevKey(draft.trim());
  };

  return (
    <form className="host-auth" onSubmit={submit}>
      <label className="host-field">
        <span className="metric-label">Dev host key (Auth0 not configured on this server)</span>
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type the dev host key"
        />
      </label>
      <button type="submit" className="btn primary" disabled={!draft.trim()}>
        Sign in
      </button>
    </form>
  );
}

/** Landing route for the Auth0 redirect; the provider exchanges the code and navigates back. */
export function AuthCallbackPage() {
  const { error } = useHostAccess();
  return (
    <main className="host-page">
      <section className="host-grid">
        <div className="host-block">
          <h1>{error ? "Sign-in failed" : "Signing you in…"}</h1>
          {error && <p className="feedback feedback-rejected">{error}</p>}
        </div>
      </section>
    </main>
  );
}
