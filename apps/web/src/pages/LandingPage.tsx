import { Link } from "react-router-dom";
import { DEMO_SESSION_ID } from "@crowdpulse/shared";
import { Dock } from "../components/Dock";
import { MenuBar } from "../components/MenuBar";
import { Window } from "../components/Window";
import { useDefaultAppearance } from "../lib/theme";

export function LandingPage() {
  const code = DEMO_SESSION_ID;
  useDefaultAppearance();

  return (
    <main className="landing desktop">
      <MenuBar title="Welcome" />
      <div className="landing-inner">
        <Window title="CrowdPulse" className="landing-window" headingLevel={1}>
          <div className="landing-hero">
            <span className="landing-sun" aria-hidden>
              ☼
            </span>
            <p className="landing-title">Feel the room. Shape the stage.</p>
          </div>
          <p className="landing-lede">
            Join a live session, vote the queue, and watch crowd energy light up the shared display.
          </p>
          <div className="cta-row">
            <Link className="btn primary" to={`/join/${code}`}>
              Join demo session
            </Link>
            <Link className="btn" to={`/stage/${code}`}>
              Open stage
            </Link>
            <Link className="btn" to={`/host/${code}`}>
              Host view
            </Link>
          </div>
          <p className="landing-hint">
            Session code <code>{code}</code> — share <code>/join/{code}</code> or scan the QR on the stage.
          </p>
        </Window>
      </div>
      <Dock sessionCode={code} />
    </main>
  );
}
