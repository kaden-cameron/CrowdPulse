import { Link } from "react-router-dom";
import { DEMO_SESSION_ID } from "@crowdpulse/shared";

export function LandingPage() {
  const code = DEMO_SESSION_ID;

  return (
    <main className="landing">
      <div className="landing-atmosphere" aria-hidden />
      <div className="landing-inner">
        <p className="brand-mark">CrowdPulse</p>
        <h1 className="landing-title">Feel the room. Shape the stage.</h1>
        <p className="landing-lede">
          Join a live session, vote the queue, and watch crowd energy light up
          the shared display.
        </p>
        <div className="cta-row">
          <Link className="btn primary" to={`/join/${code}`}>
            Join demo session
          </Link>
          <Link className="btn ghost" to={`/stage/${code}`}>
            Open stage
          </Link>
          <Link className="btn ghost" to={`/host/${code}`}>
            Host view
          </Link>
        </div>
        <p className="landing-hint">
          Session code <code>{code}</code> — share{" "}
          <code>/join/{code}</code> or a QR to that URL.
        </p>
      </div>
    </main>
  );
}
