// v0.1.3: the service definitions must not ask the OS to throttle the daemon. On macOS, launchd's
// ProcessType=Background put it at priority 4 with throttled CPU and IO (seen on a busy Mac: minutes
// to start after an update). Standard is launchd's normal, unthrottled class.
import { expect, test } from "bun:test";
import { planService } from "../../src/daemon/service.ts";

test("launchd: ProcessType is Standard, never Background, and IO is not marked low priority", () => {
  const plan = planService("/tmp/walkie-home", "darwin");
  expect(plan.platform).toBe("launchd");
  expect(plan.content).toContain("<key>ProcessType</key><string>Standard</string>");
  expect(plan.content).not.toContain("Background");
  expect(plan.content).not.toContain("LowPriorityIO");
  expect(plan.content).not.toContain("<key>Nice</key>");
  expect(plan.content).toContain("<key>KeepAlive</key><true/>");
});

test("systemd: no idle/batch scheduling, nice or IO class that would throttle the daemon", () => {
  const plan = planService("/tmp/walkie-home", "linux");
  expect(plan.platform).toBe("systemd");
  for (const key of ["Nice=", "CPUSchedulingPolicy=", "IOSchedulingClass=", "IOSchedulingPriority=", "CPUWeight=", "IOWeight=", "CPUQuota="]) {
    expect(plan.content).not.toContain(key);
  }
  expect(plan.content).toContain("Restart=always");
});

test("other platforms are refused", () => {
  expect(() => planService("/tmp/walkie-home", "win32")).toThrow(/not supported on win32/);
});
