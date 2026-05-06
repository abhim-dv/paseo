import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentStorage } from "./agent/agent-storage.js";
import type { PersistedAgentDescriptor } from "./agent/agent-sdk-types.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { syncCodexPersistedAgents } from "./codex-auto-import.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { normalizeWorkspaceId } from "./workspace-registry-model.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";

function createDescriptor(
  overrides: Partial<PersistedAgentDescriptor> &
    Pick<PersistedAgentDescriptor, "sessionId" | "cwd">,
): PersistedAgentDescriptor {
  const provider = overrides.provider ?? "codex";
  const sessionId = overrides.sessionId;
  const cwd = overrides.cwd;
  return {
    provider,
    sessionId,
    cwd,
    title: overrides.title ?? null,
    lastActivityAt: overrides.lastActivityAt ?? new Date("2026-05-06T18:00:00.000Z"),
    archivedAt: overrides.archivedAt ?? null,
    persistence: overrides.persistence ?? {
      provider,
      sessionId,
      nativeHandle: sessionId,
      metadata: {
        provider,
        cwd,
      },
    },
    timeline: overrides.timeline ?? [],
  };
}

describe("syncCodexPersistedAgents", () => {
  let tmpDir: string;
  let paseoHome: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let workspaceGitService: WorkspaceGitService;
  const logger = createTestLogger();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T20:00:00.000Z"));
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-auto-import-"));
    paseoHome = path.join(tmpDir, ".paseo");
    agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    projectRegistry = new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "projects", "workspaces.json"),
      logger,
    );
    workspaceGitService = createNoopWorkspaceGitService();
    await agentStorage.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("imports missing Codex threads and materializes project/workspace records", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@github.com:acme/rnd-lejepa-encoder-v1.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: cwd,
      }),
    });

    const descriptors = [
      createDescriptor({
        sessionId: "thread-1",
        cwd: "/tmp/rnd-lejepa-encoder-v1",
        title: "Existing encoder thread",
        lastActivityAt: new Date("2026-05-06T18:30:00.000Z"),
      }),
      createDescriptor({
        sessionId: "thread-2",
        cwd: "/tmp/rnd-lejepa-encoder-v1",
        title: "Follow-up thread",
        lastActivityAt: new Date("2026-05-06T19:30:00.000Z"),
      }),
    ];

    const result = await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    expect(result).toEqual({
      discoveredThreads: 2,
      eligibleThreads: 2,
      importedAgents: 2,
      skippedAgents: 0,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 0,
      removedStoredAgents: 0,
      upsertedProjects: 1,
      upsertedWorkspaces: 1,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(2);
    expect(storedAgents.map((record) => record.persistence?.sessionId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe("remote:github.com/acme/rnd-lejepa-encoder-v1");
    expect(projects[0]?.updatedAt).toBe("2026-05-06T19:30:00.000Z");

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspaceId).toBe(normalizeWorkspaceId("/tmp/rnd-lejepa-encoder-v1"));
    expect(workspaces[0]?.updatedAt).toBe("2026-05-06T19:30:00.000Z");
  });

  test("dedupes already-imported threads by persistence handle and groups git worktrees under one project", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: cwd.endsWith("feature-a") ? "feature-a" : "feature-b",
        remoteUrl: "git@github.com:acme/rnd-lejepa-encoder-v1.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/repos/rnd-lejepa-encoder-v1",
      }),
    });

    await agentStorage.upsert({
      id: "existing-agent",
      provider: "codex",
      cwd: "/repos/rnd-lejepa-encoder-v1/feature-a",
      createdAt: "2026-05-06T16:00:00.000Z",
      updatedAt: "2026-05-06T17:00:00.000Z",
      lastActivityAt: "2026-05-06T17:00:00.000Z",
      lastUserMessageAt: null,
      title: "Imported already",
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: { title: "Imported already" },
      runtimeInfo: { provider: "codex", sessionId: "thread-existing" },
      persistence: {
        provider: "codex",
        sessionId: "thread-existing",
        nativeHandle: "thread-existing",
        metadata: {
          provider: "codex",
          cwd: "/repos/rnd-lejepa-encoder-v1/feature-a",
        },
      },
      archivedAt: null,
    });

    const descriptors = [
      createDescriptor({
        sessionId: "thread-existing",
        cwd: "/repos/rnd-lejepa-encoder-v1/feature-a",
        title: "Imported already",
        lastActivityAt: new Date("2026-05-06T17:00:00.000Z"),
      }),
      createDescriptor({
        sessionId: "thread-new",
        cwd: "/repos/rnd-lejepa-encoder-v1/feature-b",
        title: "New worktree thread",
        lastActivityAt: new Date("2026-05-06T20:00:00.000Z"),
      }),
    ];

    const result = await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    expect(result).toEqual({
      discoveredThreads: 2,
      eligibleThreads: 2,
      importedAgents: 1,
      skippedAgents: 1,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 0,
      removedStoredAgents: 0,
      upsertedProjects: 1,
      upsertedWorkspaces: 2,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(2);
    expect(storedAgents.map((record) => record.persistence?.sessionId).sort()).toEqual([
      "thread-existing",
      "thread-new",
    ]);

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe("remote:github.com/acme/rnd-lejepa-encoder-v1");
    expect(projects[0]?.rootPath).toBe("/repos/rnd-lejepa-encoder-v1");
    expect(projects[0]?.updatedAt).toBe("2026-05-06T20:00:00.000Z");

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((record) => record.workspaceId).sort()).toEqual([
      normalizeWorkspaceId("/repos/rnd-lejepa-encoder-v1/feature-a"),
      normalizeWorkspaceId("/repos/rnd-lejepa-encoder-v1/feature-b"),
    ]);
  });

  test("imports older project threads when the project has recent activity within the cutoff", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@github.com:acme/recent-project.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: cwd,
      }),
    });

    const descriptors = [
      createDescriptor({
        sessionId: "thread-recent",
        cwd: "/tmp/recent-project",
        lastActivityAt: new Date("2026-05-06T19:30:00.000Z"),
      }),
      createDescriptor({
        sessionId: "thread-old",
        cwd: "/tmp/recent-project",
        lastActivityAt: new Date("2026-04-20T19:30:00.000Z"),
      }),
    ];

    const result = await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
      maxAgeDays: 7,
    });

    expect(result).toEqual({
      discoveredThreads: 2,
      eligibleThreads: 2,
      importedAgents: 2,
      skippedAgents: 0,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 0,
      removedStoredAgents: 0,
      upsertedProjects: 1,
      upsertedWorkspaces: 1,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(2);
    expect(storedAgents.map((record) => record.persistence?.sessionId).sort()).toEqual([
      "thread-old",
      "thread-recent",
    ]);
  });

  test("skips recent Codex desktop chats that are not tied to a git workspace", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        if (cwd.includes("Documents")) {
          return {
            cwd,
            isGit: false,
            currentBranch: null,
            remoteUrl: null,
            worktreeRoot: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          };
        }
        return {
          cwd,
          isGit: true,
          currentBranch: "main",
          remoteUrl: "git@github.com:acme/project.git",
          worktreeRoot: cwd,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "F:\\git\\project",
        };
      },
    });

    const descriptors = [
      createDescriptor({
        sessionId: "desktop-chat",
        cwd: "C:\\Users\\abhism12\\Documents\\Codex\\2026-05-06\\scratch-thread",
        lastActivityAt: new Date("2026-05-06T19:30:00.000Z"),
      }),
      createDescriptor({
        sessionId: "project-thread",
        cwd: "F:\\git\\project",
        lastActivityAt: new Date("2026-05-06T19:31:00.000Z"),
      }),
    ];

    const result = await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
      maxAgeDays: 7,
    });

    expect(result).toEqual({
      discoveredThreads: 2,
      eligibleThreads: 1,
      importedAgents: 1,
      skippedAgents: 0,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 1,
      removedStoredAgents: 0,
      upsertedProjects: 1,
      upsertedWorkspaces: 1,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(1);
    expect(storedAgents[0]?.persistence?.sessionId).toBe("project-thread");
  });

  test("removes previously stored detached Codex chats that no longer pass the import filter", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        if (cwd.includes("Documents")) {
          return {
            cwd,
            isGit: false,
            currentBranch: null,
            remoteUrl: null,
            worktreeRoot: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          };
        }
        return {
          cwd,
          isGit: true,
          currentBranch: "main",
          remoteUrl: "git@github.com:acme/project.git",
          worktreeRoot: cwd,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "F:\\git\\project",
        };
      },
    });

    await agentStorage.upsert({
      id: "old-chat",
      provider: "codex",
      cwd: "C:\\Users\\abhism12\\Documents\\Codex\\2026-05-06\\scratch-thread",
      createdAt: "2026-05-06T18:00:00.000Z",
      updatedAt: "2026-05-06T18:00:00.000Z",
      lastActivityAt: "2026-05-06T18:00:00.000Z",
      lastUserMessageAt: null,
      title: "Old desktop chat",
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: { title: "Old desktop chat" },
      runtimeInfo: { provider: "codex", sessionId: "old-chat" },
      persistence: {
        provider: "codex",
        sessionId: "old-chat",
        nativeHandle: "old-chat",
        metadata: {
          provider: "codex",
          cwd: "C:\\Users\\abhism12\\Documents\\Codex\\2026-05-06\\scratch-thread",
        },
      },
      archivedAt: null,
    });

    const result = await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) => {
          const descriptors = [
            createDescriptor({
              sessionId: "project-thread",
              cwd: "F:\\git\\project",
              lastActivityAt: new Date("2026-05-06T19:31:00.000Z"),
            }),
          ];
          return options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt);
        },
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
      maxAgeDays: 7,
    });

    expect(result).toEqual({
      discoveredThreads: 1,
      eligibleThreads: 1,
      importedAgents: 1,
      skippedAgents: 0,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 0,
      removedStoredAgents: 1,
      upsertedProjects: 1,
      upsertedWorkspaces: 1,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents.find((record) => record.id === "old-chat")).toBeUndefined();
  });

  test("refreshes existing imported Codex thread metadata when desktop rename or new activity changes it", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@github.com:acme/project.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "F:\\git\\project",
      }),
    });

    await agentStorage.upsert({
      id: "existing-agent",
      provider: "codex",
      cwd: "F:\\git\\project",
      createdAt: "2026-05-06T18:00:00.000Z",
      updatedAt: "2026-05-06T18:00:00.000Z",
      lastActivityAt: "2026-05-06T18:00:00.000Z",
      lastUserMessageAt: null,
      title: "Old title",
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: { title: "Old title" },
      runtimeInfo: { provider: "codex", sessionId: "thread-existing" },
      persistence: {
        provider: "codex",
        sessionId: "thread-existing",
        nativeHandle: "thread-existing",
        metadata: { provider: "codex", cwd: "F:\\git\\project" },
      },
      archivedAt: null,
    });

    const descriptors = [
      createDescriptor({
        sessionId: "thread-existing",
        cwd: "F:\\git\\project",
        title: "Renamed on desktop",
        lastActivityAt: new Date("2026-05-06T19:45:00.000Z"),
      }),
    ];

    await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
      maxAgeDays: 7,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(1);
    expect(storedAgents[0]?.title).toBe("Renamed on desktop");
    expect(storedAgents[0]?.config?.title).toBe("Renamed on desktop");
    expect(storedAgents[0]?.updatedAt).toBe("2026-05-06T19:45:00.000Z");
    expect(storedAgents[0]?.lastActivityAt).toBe("2026-05-06T19:45:00.000Z");
  });

  test("marks existing imported Codex threads archived when desktop archives them", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@github.com:acme/project.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "F:\\git\\project",
      }),
    });

    await agentStorage.upsert({
      id: "existing-agent",
      provider: "codex",
      cwd: "F:\\git\\project",
      createdAt: "2026-05-06T18:00:00.000Z",
      updatedAt: "2026-05-06T18:00:00.000Z",
      lastActivityAt: "2026-05-06T18:00:00.000Z",
      lastUserMessageAt: null,
      title: "Project thread",
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: { title: "Project thread" },
      runtimeInfo: { provider: "codex", sessionId: "thread-existing" },
      persistence: {
        provider: "codex",
        sessionId: "thread-existing",
        nativeHandle: "thread-existing",
        metadata: { provider: "codex", cwd: "F:\\git\\project" },
      },
      archivedAt: null,
    });

    const descriptors = [
      createDescriptor({
        sessionId: "thread-active",
        cwd: "F:\\git\\project",
        title: "Still active on desktop",
        lastActivityAt: new Date("2026-05-06T19:52:00.000Z"),
      }),
      createDescriptor({
        sessionId: "thread-existing",
        cwd: "F:\\git\\project",
        title: "Archived on desktop",
        lastActivityAt: new Date("2026-05-06T19:50:00.000Z"),
        archivedAt: new Date("2026-05-06T19:51:00.000Z"),
      }),
    ];

    await syncCodexPersistedAgents({
      agentManager: {
        listPersistedAgents: async (options) =>
          options?.includeArchived
            ? descriptors
            : descriptors.filter((descriptor) => !descriptor.archivedAt),
      },
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
      maxAgeDays: 7,
    });

    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(2);
    const archivedThread = storedAgents.find(
      (record) => record.persistence?.sessionId === "thread-existing",
    );
    expect(archivedThread?.title).toBe("Archived on desktop");
    expect(archivedThread?.archivedAt).toBe("2026-05-06T19:51:00.000Z");
    expect(archivedThread?.updatedAt).toBe("2026-05-06T19:50:00.000Z");
  });
});
