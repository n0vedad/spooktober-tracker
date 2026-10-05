import { cleanup } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Unmount rendered components between tests (no vitest globals enabled)
afterEach(cleanup);
