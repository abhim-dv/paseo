import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { PersistedAgentDescriptor } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import {
  classifyDirectoryForProjectMembership,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

const DEFAULT_CODEX_AUTO_IMPORT_LIMIT = 500;
const DEFAULT_CODEX_AUTO_IMPORT_MAX_AGE_DAYS = 7;

function resolveMaxAgeDays(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_CODEX_AUTO_IMPORT_MAX_AGE_DAYS;
  }
  return input;
}

function minIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function buildPersistenceLookupKeys(record: StoredAgentRecord): string[] {
  const provider = record.provider.trim();
  const sessionId = record.persistence?.sessionId?.trim() ?? "";
  const nativeHandle =
    typeof record.persistence?.nativeHandle === "string"
      ? record.persistence.nativeHandle.trim()
      : "";
  const keys = new Set<string>();
  if (sessionId) {
    keys.add(`${provider}:${sessionId}`);
  }
  if (nativeHandle) {
    keys.add(`${provider}:${nativeHandle}`);
  }
  return Array.from(keys);
}

function buildDescriptorLookupKeys(descriptor: PersistedAgentDescriptor): string[] {
  const provider = descriptor.provider.trim();
  const sessionId = descriptor.sessionId.trim();
  const nativeHandle =
    typeof descriptor.persistence.nativeHandle === "string"
      ? descriptor.persistence.nativeHandle.trim()
      : "";
  const keys = new Set<string>();
  if (sessionId) {
    keys.add(`${provider}:${sessionId}`);
  }
  if (nativeHandle) {
    keys.add(`${provider}:${nativeHandle}`);
  }
  return Array.from(keys);
}

function buildImportedStoredAgentRecord(
  descriptor: PersistedAgentDescriptor,
  agentId: string,
): StoredAgentRecord {
  const activityAt = descriptor.lastActivityAt.toISOString();
  return {
    id: agentId,
    provider: descriptor.provider,
    cwd: normalizeWorkspaceId(descriptor.cwd),
    createdAt: activityAt,
    updatedAt: activityAt,
    lastActivityAt: activityAt,
    lastUserMessageAt: null,
    title: descriptor.title,
    labels: {},
    lastStatus: "closed",
    lastModeId: null,
    config: {
      title: descriptor.title,
    },
    runtimeInfo: {
      provider: descriptor.provider,
      sessionId: descriptor.sessionId,
    },
    persistence: descriptor.persistence,
    archivedAt: descriptor.archivedAt ? descriptor.archivedAt.toISOString() : null,
  };
}

export interface SyncCodexPersistedAgentsOptions {
  agentManager: Pick<AgentManager, "listPersistedAgents">;
  agentStorage: Pick<AgentStorage, "list" | "remove" | "upsert">;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  workspaceGitService: WorkspaceGitService;
  logger: Logger;
  limit?: number;
  maxAgeDays?: number;
}

export interface SyncCodexPersistedAgentsResult {
  discoveredThreads: number;
  eligibleThreads: number;
  importedAgents: number;
  skippedAgents: number;
  skippedOldThreads: number;
  skippedNonProjectThreads: number;
  removedStoredAgents: number;
  upsertedProjects: number;
  upsertedWorkspaces: number;
}

// eslint-disable-next-line complexity
export async function syncCodexPersistedAgents(
  options: SyncCodexPersistedAgentsOptions,
): Promise<SyncCodexPersistedAgentsResult> {
  const logger = options.logger.child({ module: "codex-auto-import" });
  const limit = options.limit ?? DEFAULT_CODEX_AUTO_IMPORT_LIMIT;
  const maxAgeDays = resolveMaxAgeDays(options.maxAgeDays);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const descriptors = await options.agentManager.listPersistedAgents({
    provider: "codex",
    limit,
  });
  const archivedOnlyDescriptors = await options.agentManager.listPersistedAgents({
    provider: "codex",
    limit,
    includeArchived: true,
  });
  const allDescriptorsByKey = new Map<string, PersistedAgentDescriptor>();
  for (const descriptor of [...descriptors, ...archivedOnlyDescriptors]) {
    const key = descriptor.persistence.nativeHandle ?? descriptor.sessionId;
    allDescriptorsByKey.set(key, descriptor);
  }
  const allDescriptors = Array.from(allDescriptorsByKey.values());

  await Promise.all([options.projectRegistry.initialize(), options.workspaceRegistry.initialize()]);

  const [storedAgents, existingProjects, existingWorkspaces] = await Promise.all([
    options.agentStorage.list(),
    options.projectRegistry.list(),
    options.workspaceRegistry.list(),
  ]);

  if (descriptors.length === 0 && archivedOnlyDescriptors.length === 0) {
    logger.debug("No persisted Codex agents found for auto-import");
    return {
      discoveredThreads: 0,
      eligibleThreads: 0,
      importedAgents: 0,
      skippedAgents: 0,
      skippedOldThreads: 0,
      skippedNonProjectThreads: 0,
      removedStoredAgents: 0,
      upsertedProjects: 0,
      upsertedWorkspaces: 0,
    };
  }

  const existingAgentIdsByHandle = new Map<string, string>();
  const storedAgentsById = new Map(storedAgents.map((record) => [record.id, record]));
  for (const record of storedAgents) {
    for (const key of buildPersistenceLookupKeys(record)) {
      existingAgentIdsByHandle.set(key, record.id);
    }
  }

  const persistedDescriptorByHandle = new Map<string, PersistedAgentDescriptor>();
  for (const descriptor of allDescriptors) {
    for (const key of buildDescriptorLookupKeys(descriptor)) {
      persistedDescriptorByHandle.set(key, descriptor);
    }
  }

  const descriptorMemberships = new Map<
    string,
    {
      descriptor: PersistedAgentDescriptor;
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      activityAt: string;
    }
  >();
  const activeProjectKeys = new Set<string>();
  let skippedNonProjectThreads = 0;

  for (const descriptor of allDescriptors) {
    const normalizedCwd = normalizeWorkspaceId(descriptor.cwd);
    const checkout = await options.workspaceGitService.getCheckout(normalizedCwd);
    if (!checkout.isGit) {
      skippedNonProjectThreads += 1;
      continue;
    }
    descriptorMemberships.set(descriptor.sessionId, {
      descriptor,
      membership: classifyDirectoryForProjectMembership({
        cwd: normalizedCwd,
        checkout,
      }),
      activityAt: descriptor.lastActivityAt.toISOString(),
    });
  }

  for (const descriptor of descriptors) {
    const ageMs = now - descriptor.lastActivityAt.getTime();
    if (ageMs > maxAgeMs) {
      continue;
    }
    const membershipEntry = descriptorMemberships.get(descriptor.sessionId);
    if (!membershipEntry) {
      continue;
    }
    activeProjectKeys.add(membershipEntry.membership.projectKey);
  }

  const eligibleDescriptors = allDescriptors.filter((descriptor) => {
    const membershipEntry = descriptorMemberships.get(descriptor.sessionId);
    return membershipEntry ? activeProjectKeys.has(membershipEntry.membership.projectKey) : false;
  });

  const projectRanges = new Map<
    string,
    {
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      createdAt: string | null;
      updatedAt: string | null;
    }
  >();
  const workspaceRanges = new Map<
    string,
    {
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      createdAt: string | null;
      updatedAt: string | null;
    }
  >();

  let importedAgents = 0;
  let skippedAgents = 0;
  let removedStoredAgents = 0;

  const eligibleHandleKeys = new Set<string>();

  for (const descriptor of eligibleDescriptors) {
    const membershipEntry = descriptorMemberships.get(descriptor.sessionId);
    if (!membershipEntry) {
      continue;
    }
    for (const key of buildDescriptorLookupKeys(descriptor)) {
      eligibleHandleKeys.add(key);
    }
    const { membership, activityAt } = membershipEntry;

    const workspaceEntry = workspaceRanges.get(membership.workspaceId) ?? {
      membership,
      createdAt: null,
      updatedAt: null,
    };
    workspaceEntry.createdAt = minIsoDate(workspaceEntry.createdAt, activityAt);
    workspaceEntry.updatedAt = maxIsoDate(workspaceEntry.updatedAt, activityAt);
    workspaceRanges.set(membership.workspaceId, workspaceEntry);

    const projectEntry = projectRanges.get(membership.projectKey) ?? {
      membership,
      createdAt: null,
      updatedAt: null,
    };
    projectEntry.createdAt = minIsoDate(projectEntry.createdAt, activityAt);
    projectEntry.updatedAt = maxIsoDate(projectEntry.updatedAt, activityAt);
    projectRanges.set(membership.projectKey, projectEntry);

    const existingAgentId = buildDescriptorLookupKeys(descriptor)
      .map((key) => existingAgentIdsByHandle.get(key) ?? null)
      .find((value): value is string => typeof value === "string");
    if (existingAgentId) {
      const existingRecord = storedAgentsById.get(existingAgentId);
      if (existingRecord) {
        const nextActivityAt = descriptor.lastActivityAt.toISOString();
        const nextArchivedAt = descriptor.archivedAt ? descriptor.archivedAt.toISOString() : null;
        const nextTitle =
          descriptor.title ?? existingRecord.title ?? existingRecord.config?.title ?? null;
        const requiresUpdate =
          (existingRecord.title ?? null) !== nextTitle ||
          (existingRecord.config?.title ?? null) !== nextTitle ||
          existingRecord.lastActivityAt !== nextActivityAt ||
          existingRecord.updatedAt !== nextActivityAt ||
          (existingRecord.archivedAt ?? null) !== nextArchivedAt;
        if (requiresUpdate) {
          const nextRecord: StoredAgentRecord = {
            ...existingRecord,
            title: nextTitle,
            config: {
              ...existingRecord.config,
              title: nextTitle,
            },
            persistence: descriptor.persistence,
            updatedAt: nextActivityAt,
            lastActivityAt: nextActivityAt,
            archivedAt: nextArchivedAt,
          };
          await options.agentStorage.upsert(nextRecord);
          storedAgentsById.set(existingRecord.id, nextRecord);
        }
      }
      skippedAgents += 1;
      continue;
    }

    const record = buildImportedStoredAgentRecord(descriptor, randomUUID());
    await options.agentStorage.upsert(record);
    for (const key of buildDescriptorLookupKeys(descriptor)) {
      existingAgentIdsByHandle.set(key, record.id);
    }
    importedAgents += 1;
  }

  for (const record of storedAgents) {
    if (record.provider !== "codex") {
      continue;
    }
    const handleKeys = buildPersistenceLookupKeys(record);
    const persistedDescriptor = handleKeys
      .map((key) => persistedDescriptorByHandle.get(key) ?? null)
      .find((value): value is PersistedAgentDescriptor => value !== null);
    const membershipEntry = persistedDescriptor
      ? (descriptorMemberships.get(persistedDescriptor.sessionId) ?? null)
      : null;
    const isEligibleProjectThread =
      membershipEntry !== null && activeProjectKeys.has(membershipEntry.membership.projectKey);

    if (persistedDescriptor?.archivedAt && isEligibleProjectThread) {
      const nextArchivedAt = persistedDescriptor.archivedAt.toISOString();
      const nextTitle = persistedDescriptor.title ?? record.title ?? record.config?.title ?? null;
      const nextActivityAt = persistedDescriptor.lastActivityAt.toISOString();
      await options.agentStorage.upsert({
        ...record,
        title: nextTitle,
        config: {
          ...record.config,
          title: nextTitle,
        },
        persistence: persistedDescriptor.persistence,
        archivedAt: nextArchivedAt,
        updatedAt: nextActivityAt,
        lastActivityAt: nextActivityAt,
      });
      storedAgentsById.set(record.id, {
        ...record,
        title: nextTitle,
        config: {
          ...record.config,
          title: nextTitle,
        },
        persistence: persistedDescriptor.persistence,
        archivedAt: nextArchivedAt,
        updatedAt: nextActivityAt,
        lastActivityAt: nextActivityAt,
      });
      continue;
    }

    if (isEligibleProjectThread || handleKeys.some((key) => eligibleHandleKeys.has(key))) {
      continue;
    }
    await options.agentStorage.remove(record.id);
    removedStoredAgents += 1;
  }

  const projectMap = new Map(existingProjects.map((record) => [record.projectId, record]));
  const workspaceMap = new Map(existingWorkspaces.map((record) => [record.workspaceId, record]));

  for (const [projectId, entry] of projectRanges.entries()) {
    const existing = projectMap.get(projectId) ?? null;
    const createdAt =
      minIsoDate(existing?.createdAt ?? null, entry.createdAt) ?? new Date().toISOString();
    const updatedAt = maxIsoDate(existing?.updatedAt ?? null, entry.updatedAt) ?? createdAt;
    await options.projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId,
        rootPath: entry.membership.projectRootPath,
        kind: entry.membership.projectKind,
        displayName: entry.membership.projectName,
        createdAt,
        updatedAt,
        archivedAt: existing?.archivedAt ?? null,
      }),
    );
  }

  for (const [workspaceId, entry] of workspaceRanges.entries()) {
    const existing = workspaceMap.get(workspaceId) ?? null;
    const createdAt =
      minIsoDate(existing?.createdAt ?? null, entry.createdAt) ?? new Date().toISOString();
    const updatedAt = maxIsoDate(existing?.updatedAt ?? null, entry.updatedAt) ?? createdAt;
    await options.workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: entry.membership.projectKey,
        cwd: entry.membership.checkout.cwd,
        kind: entry.membership.workspaceKind,
        displayName: entry.membership.workspaceDisplayName,
        createdAt,
        updatedAt,
        archivedAt: existing?.archivedAt ?? null,
      }),
    );
  }

  logger.info(
    {
      discoveredThreads: descriptors.length,
      eligibleThreads: eligibleDescriptors.length,
      importedAgents,
      skippedAgents,
      skippedOldThreads: descriptors.filter((descriptor) => {
        const membershipEntry = descriptorMemberships.get(descriptor.sessionId);
        if (!membershipEntry) {
          return false;
        }
        return !activeProjectKeys.has(membershipEntry.membership.projectKey);
      }).length,
      skippedNonProjectThreads,
      removedStoredAgents,
      upsertedProjects: projectRanges.size,
      upsertedWorkspaces: workspaceRanges.size,
      maxAgeDays,
    },
    "Synced persisted Codex projects and threads into daemon state",
  );

  return {
    discoveredThreads: descriptors.length,
    eligibleThreads: eligibleDescriptors.length,
    importedAgents,
    skippedAgents,
    skippedOldThreads: descriptors.filter((descriptor) => {
      const membershipEntry = descriptorMemberships.get(descriptor.sessionId);
      if (!membershipEntry) {
        return false;
      }
      return !activeProjectKeys.has(membershipEntry.membership.projectKey);
    }).length,
    skippedNonProjectThreads,
    removedStoredAgents,
    upsertedProjects: projectRanges.size,
    upsertedWorkspaces: workspaceRanges.size,
  };
}
