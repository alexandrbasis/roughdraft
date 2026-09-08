import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireServerStartLock,
  getServerStartLockPath,
} from "./server-start-lock";

describe("server start lock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createLockPath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-lock-"));
    tempDirs.push(tempDir);
    return getServerStartLockPath(path.join(tempDir, "state", "server.json"));
  }

  it("cleans a stale owner and acquires the lock", async () => {
    const lockPath = createLockPath();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999_999,
        token: "stale-owner",
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    const lock = await acquireServerStartLock(lockPath, {
      isProcessRunning: () => false,
      retryDelayMs: 1,
      timeoutMs: 100,
    });

    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")),
    ).toMatchObject({
      pid: process.pid,
    });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not remove a replacement owner's lock during release", async () => {
    const lockPath = createLockPath();
    const lock = await acquireServerStartLock(lockPath, {
      processId: 1001,
      isProcessRunning: () => true,
    });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 1002,
        token: "replacement-owner",
        acquiredAt: new Date().toISOString(),
      }),
    );

    lock.release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")),
    ).toMatchObject({ pid: 1002, token: "replacement-owner" });
  });

  it("does not remove a replacement owner during stale cleanup", async () => {
    const lockPath = createLockPath();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 1003,
        token: "stale-owner",
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    await expect(
      acquireServerStartLock(lockPath, {
        isProcessRunning: (pid) => {
          if (pid === 1003) {
            fs.writeFileSync(
              path.join(lockPath, "owner.json"),
              JSON.stringify({
                pid: 1004,
                token: "replacement-owner",
                acquiredAt: new Date().toISOString(),
              }),
            );
            return false;
          }
          return true;
        },
        retryDelayMs: 1,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for Roughdraft startup lock");

    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")),
    ).toMatchObject({ pid: 1004, token: "replacement-owner" });
  });

  it("does not delete a replacement lock during stale-owner removal", async () => {
    const lockPath = createLockPath();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 1003,
        token: "stale-owner",
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    const originalRmSync = fs.rmSync.bind(fs);
    let observedReclamationClaim = false;
    let simulatedReplacementLoss = false;
    let interleaved = false;
    const rmSyncSpy = vi
      .spyOn(fs, "rmSync")
      .mockImplementation((target, options) => {
        if (String(target) === lockPath && !interleaved) {
          interleaved = true;
          observedReclamationClaim = fs
            .readdirSync(lockPath)
            .some((entry) => entry.startsWith(".reclaim-"));

          if (!observedReclamationClaim) {
            originalRmSync(lockPath, { recursive: true, force: false });
            fs.mkdirSync(lockPath);
            fs.writeFileSync(
              path.join(lockPath, "owner.json"),
              JSON.stringify({
                pid: 1004,
                token: "replacement-owner",
                acquiredAt: new Date().toISOString(),
              }),
            );
            originalRmSync(lockPath, { recursive: true, force: false });
            simulatedReplacementLoss = true;
            return;
          }
        }

        return originalRmSync(target, options);
      });

    try {
      await expect(
        acquireServerStartLock(lockPath, {
          isProcessRunning: () => false,
          retryDelayMs: 1,
          timeoutMs: 0,
        }),
      ).rejects.toThrow("Timed out waiting for Roughdraft startup lock");
    } finally {
      rmSyncSpy.mockRestore();
    }

    expect(interleaved).toBe(true);
    expect(observedReclamationClaim).toBe(true);
    expect(simulatedReplacementLoss).toBe(false);
  });

  it("fails closed when a missing-owner reclaimer leaves its tombstone", async () => {
    const lockPath = createLockPath();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    const originalRmSync = fs.rmSync.bind(fs);
    let shouldFailReclaimer = true;
    const rmSyncSpy = vi
      .spyOn(fs, "rmSync")
      .mockImplementation((target, options) => {
        if (String(target) === lockPath && shouldFailReclaimer) {
          shouldFailReclaimer = false;
          throw new Error("simulated reclaimer crash");
        }
        return originalRmSync(target, options);
      });
    let clock = 60_000;
    const lockOptions = {
      isProcessRunning: () => false,
      now: () => clock,
      retryDelayMs: 1,
      sleepImpl: async (ms: number) => {
        clock += ms;
      },
    };

    try {
      await expect(
        acquireServerStartLock(lockPath, {
          ...lockOptions,
          timeoutMs: 0,
          staleLockAgeMs: 1,
        }),
      ).rejects.toThrow("simulated reclaimer crash");

      expect(
        fs.readdirSync(lockPath).some((entry) => entry.startsWith(".reclaim-")),
      ).toBe(true);

      await expect(
        acquireServerStartLock(lockPath, {
          ...lockOptions,
          timeoutMs: 5,
          staleLockAgeMs: 1,
        }),
      ).rejects.toThrow("Timed out waiting for Roughdraft startup lock");
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      rmSyncSpy.mockRestore();
    }
  });

  it("bounds acquisition while another process owns the lock", async () => {
    const lockPath = createLockPath();
    const lock = await acquireServerStartLock(lockPath, {
      processId: 2001,
      isProcessRunning: () => true,
    });

    await expect(
      acquireServerStartLock(lockPath, {
        isProcessRunning: () => true,
        retryDelayMs: 1,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for Roughdraft startup lock");

    lock.release();
  });
});
