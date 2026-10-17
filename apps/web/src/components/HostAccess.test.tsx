import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAccessProvider, useHostAccess } from "./HostAccess";

const loginWithRedirect = vi.fn();
vi.mock("@auth0/auth0-react", () => ({
  Auth0Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth0: () => ({
    isLoading: false,
    isAuthenticated: false,
    user: undefined,
    error: undefined,
    loginWithRedirect,
    logout: vi.fn(),
    getAccessTokenSilently: vi.fn(),
  }),
}));

function Probe() {
  const a = useHostAccess();
  return (
    <div>
      <span>mode:{a.mode}</span>
      <span>ready:{String(a.ready)}</span>
      {a.mode === "auth0" && <button onClick={a.login}>Sign in as host</button>}
      {a.mode === "dev-key" && <input aria-label="key" value={a.devKey} onChange={(e) => a.setDevKey(e.target.value)} />}
    </div>
  );
}

const renderWith = (config: object) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(config), { status: 200 })));
  return render(
    <MemoryRouter>
      <HostAccessProvider>
        <Probe />
      </HostAccessProvider>
    </MemoryRouter>,
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("HostAccessProvider", () => {
  it("uses Auth0 when the server says so, and starts signed out", async () => {
    renderWith({ mode: "auth0", domain: "t.us.auth0.com", clientId: "c", audience: "a" });
    expect(await screen.findByText("mode:auth0")).toBeInTheDocument();
    expect(screen.getByText("ready:false")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in as host" }));
    expect(loginWithRedirect).toHaveBeenCalled();
  });

  it("falls back to a dev key only when the server has no Auth0", async () => {
    renderWith({ mode: "dev-key" });
    expect(await screen.findByText("mode:dev-key")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("key"), "k");
    expect(screen.getByText("ready:true")).toBeInTheDocument();
  });
});
