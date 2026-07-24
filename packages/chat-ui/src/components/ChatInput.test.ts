import { describe, expect, it } from "vitest";
import { parseRunningGoalControl } from "./ChatInput";

describe("parseRunningGoalControl", () => {
  it("recognizes commands that are safe while a goal run is active", () => {
    expect(parseRunningGoalControl("/goal")).toBe("status");
    expect(parseRunningGoalControl("/goal pause")).toBe("pause");
    expect(parseRunningGoalControl("/goal clear")).toBe("clear");
    expect(parseRunningGoalControl("/goal done")).toBe("clear");
    expect(parseRunningGoalControl("/goal stop")).toBe("stop");
  });

  it("does not treat a new objective as a running control command", () => {
    expect(parseRunningGoalControl("/goal Status page implementation")).toBeNull();
    expect(parseRunningGoalControl("/goal resume")).toBeNull();
  });
});
