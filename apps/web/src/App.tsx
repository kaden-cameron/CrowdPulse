import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthCallbackPage, HostAccessProvider } from "./components/HostAccess";
import { HostPage } from "./pages/HostPage";
import { JoinPage } from "./pages/JoinPage";
import { LandingPage } from "./pages/LandingPage";
import { StagePage } from "./pages/StagePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/join/:sessionCode" element={<JoinPage />} />
        <Route path="/stage/:sessionCode" element={<StagePage />} />
        <Route
          path="/host/:sessionCode"
          element={
            <HostAccessProvider>
              <HostPage />
            </HostAccessProvider>
          }
        />
        <Route
          path="/auth/callback"
          element={
            <HostAccessProvider>
              <AuthCallbackPage />
            </HostAccessProvider>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
