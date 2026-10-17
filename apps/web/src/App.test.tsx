import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "./App";

// Simulates the real SDK: the provider finishes the code exchange on mount and calls
// onRedirectCallback, which navigates from /auth/callback to the host page.
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@auth0/auth0-react", () => ({
  Auth0Provider: ({
    children,
    onRedirectCallback,
  }: {
    children: React.ReactNode;
    onRedirectCallback: (s: { returnTo: string }) => void;
  }) => {
    useEffect(() => {
      mounts.count++;
      onRedirectCallback({ returnTo: "/host/demo" });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <>{children}</>;
  },
  useAuth0: () => ({
    isLoading: false,
    isAuthenticated: true,
    user: { email: "host@example.com" },
    error: undefined,
    loginWithRedirect: vi.fn(),
    logout: vi.fn(),
    getAccessTokenSilently: vi.fn(async () => "token"),
  }),
}));
vi.mock("./pages/HostPage", () => ({ HostPage: () => <p>host page</p> }));

afterEach(() => {
  vi.unstubAllGlobals();
  mounts.count = 0;
});

describe("Auth0 sign-in routing", () => {
  it("keeps one Auth0 provider from /auth/callback to the host page (sign-in carries over)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ mode: "auth0", domain: "t.us.auth0.com", clientId: "c", audience: "a" }))),
    );
    render(
      <MemoryRouter initialEntries={["/auth/callback?code=abc&state=xyz"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(await screen.findByText("host page")).toBeInTheDocument();
    // Let any provider the host route would create finish loading its config and mount.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 100));
    // The provider that completed sign-in is the one the host page uses: no second client,
    // no config refetch, no silent-auth iframe needed.
    expect(mounts.count).toBe(1);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});
