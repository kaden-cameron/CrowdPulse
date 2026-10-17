import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AuthCallbackPage, HostAccessProvider } from "./components/HostAccess";
import { HostPage } from "./pages/HostPage";
import { JoinPage } from "./pages/JoinPage";
import { LandingPage } from "./pages/LandingPage";
import { StagePage } from "./pages/StagePage";

/**
 * One HostAccessProvider (and so one Auth0 client) explicitly shared by the callback and host
 * pages. Auth0 finishes sign-in on /auth/callback, then navigates to /host/…; the host page must
 * keep that client's in-memory token. A fresh client would have to recover the session through
 * a third-party iframe, which Safari/iOS and Brave block. Guarded by App.test.tsx.
 */
function HostAccessLayout() {
  return (
    <HostAccessProvider>
      <Outlet />
    </HostAccessProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/join/:sessionCode" element={<JoinPage />} />
      <Route path="/stage/:sessionCode" element={<StagePage />} />
      <Route element={<HostAccessLayout />}>
        <Route path="/host/:sessionCode" element={<HostPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
