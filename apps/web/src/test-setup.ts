import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor give up after 1s by default — too short when the laptop is also running the
// dev servers. Give them (and each test) more room so slow machines don't fail good code.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => cleanup());
