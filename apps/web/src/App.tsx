import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
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
        <Route path="/host/:sessionCode" element={<HostPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
