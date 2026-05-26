import { describe, expect, it } from "vitest";
import {
  shouldForceMobileSnapshotTimelineFetch,
  shouldStartMobileSnapshotCatchup,
} from "./session.js";

type Activity = Parameters<typeof shouldStartMobileSnapshotCatchup>[0]["next"];

function activity(overrides: Partial<Activity>): Activity {
  return {
    deviceType: "mobile",
    focusedAgentId: "agent-1",
    lastActivityAt: new Date("2026-05-26T12:00:00.000Z"),
    appVisible: true,
    appVisibilityChangedAt: new Date("2026-05-26T12:00:00.000Z"),
    ...overrides,
  };
}

describe("mobile snapshot catch-up policy", () => {
  it("starts a snapshot catch-up window when mobile resumes focused on an agent", () => {
    expect(
      shouldStartMobileSnapshotCatchup({
        previous: activity({ appVisible: false, focusedAgentId: "agent-1" }),
        next: activity({ appVisible: true, focusedAgentId: "agent-1" }),
      }),
    ).toBe(true);
  });

  it("starts a snapshot catch-up window when mobile switches focused agents", () => {
    expect(
      shouldStartMobileSnapshotCatchup({
        previous: activity({ focusedAgentId: "agent-2" }),
        next: activity({ focusedAgentId: "agent-1" }),
      }),
    ).toBe(true);
  });

  it("does not start catch-up for visible web clients", () => {
    expect(
      shouldStartMobileSnapshotCatchup({
        previous: null,
        next: activity({ deviceType: "web" }),
      }),
    ).toBe(false);
  });

  it("forces timeline fetches to snapshot only for the visible focused mobile agent", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const visibleFocused = activity({ focusedAgentId: "agent-1" });

    expect(
      shouldForceMobileSnapshotTimelineFetch({
        activity: visibleFocused,
        agentId: "agent-1",
        expiresAtMs: nowMs + 1,
        nowMs,
      }),
    ).toBe(true);
    expect(
      shouldForceMobileSnapshotTimelineFetch({
        activity: visibleFocused,
        agentId: "agent-2",
        expiresAtMs: nowMs + 1,
        nowMs,
      }),
    ).toBe(false);
    expect(
      shouldForceMobileSnapshotTimelineFetch({
        activity: visibleFocused,
        agentId: "agent-1",
        expiresAtMs: nowMs,
        nowMs,
      }),
    ).toBe(false);
  });
});
