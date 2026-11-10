import { randomUUID } from "node:crypto";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { type CollectionRead, VersionedCollection } from "./internal/versioned-collection.js";

// Named interfaces as type arguments: scriptc cannot instantiate a generic class with the
// protocol's z.infer type aliases directly.
interface ProjectDirectoryEntry extends WorkspaceProjectDescriptorPayload {}
interface WorkspaceDirectoryEntry extends WorkspaceDescriptorPayload {}

interface AgentDirectoryEntry {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
}

interface DirectorySyncCursor {
  generation?: string;
  afterSeq?: number;
}

interface DirectoryVersion {
  generation: string;
  seq: number;
}

type ProjectUpdate = Extract<SessionOutboundMessage, { type: "project.update" }>;
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];
type ProjectListResponse = Extract<
  SessionOutboundMessage,
  { type: "project.list.response" }
>["payload"];
type FetchWorkspacesResponse = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchAgentsResponse = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];

/** Daemon-global latest-state sequence owner for the active app directory. */
export class DirectorySyncService {
  private readonly generation: string;
  private readonly projects = new VersionedCollection<ProjectDirectoryEntry>({
    getId: (project) => project.projectId,
  });
  private readonly workspaces = new VersionedCollection<WorkspaceDirectoryEntry>({
    getId: (workspace) => workspace.id,
  });
  private readonly agents = new VersionedCollection<AgentDirectoryEntry>({
    getId: (entry) => entry.agent.id,
  });

  constructor(generation = randomUUID()) {
    this.generation = generation;
  }

  synchronizeProjects(
    snapshot: readonly WorkspaceProjectDescriptorPayload[],
    cursor: DirectorySyncCursor,
  ): Pick<ProjectListResponse, "projects" | "sync"> {
    this.projects.replaceAll(snapshot);
    const read = this.read(this.projects, cursor);
    return {
      projects: read.values.map(({ seq, value }) => ({ ...value, syncSeq: seq })),
      sync: this.metadata(read),
    };
  }

  synchronizeWorkspaces(
    snapshot: readonly WorkspaceDescriptorPayload[],
    cursor: DirectorySyncCursor,
    includeBackground = false,
  ): Pick<FetchWorkspacesResponse, "entries" | "emptyProjects" | "pageInfo" | "sync"> {
    this.workspaces.replaceAll(snapshot);
    const read = this.read(this.workspaces, cursor, includeBackground);
    return {
      entries: read.values.map(({ seq, value }) => ({ ...value, syncSeq: seq })),
      emptyProjects: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      sync: this.metadata(read, includeBackground),
    };
  }

  synchronizeAgents(
    snapshot: readonly AgentDirectoryEntry[],
    cursor: DirectorySyncCursor,
    includeBackground = false,
  ): Pick<FetchAgentsResponse, "entries" | "pageInfo" | "sync"> {
    this.agents.replaceAll(snapshot);
    const read = this.read(this.agents, cursor, includeBackground);
    return {
      entries: read.values.map(({ seq, value }) => ({ ...value, syncSeq: seq })),
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      sync: this.metadata(read, includeBackground),
    };
  }

  sequenceProjectUpdate(
    update: ProjectUpdate["payload"],
    includeSequence: boolean,
  ): ProjectUpdate["payload"] {
    if (update.kind === "upsert") {
      this.projects.replace(update.project);
    } else {
      this.projects.remove(update.projectId);
    }
    const id = update.kind === "upsert" ? update.project.projectId : update.projectId;
    return this.withVersion(update, includeSequence, this.version(this.projects, id));
  }

  sequenceWorkspaceUpdate(
    payload: WorkspaceUpdatePayload,
    value: WorkspaceDescriptorPayload | null,
    id: string,
    includeSequence: boolean,
    includeBackground = false,
  ): WorkspaceUpdatePayload {
    if (value) {
      this.workspaces.replace(value);
    } else {
      this.workspaces.remove(id);
    }
    const version = this.version(this.workspaces, id);
    if (!version || !includeSequence) return payload;
    // Not through the generic withVersion: scriptc cannot lower its intersection return
    // type. One spread per arm so each spreads a single record type.
    const generation = this.generationFor(includeBackground);
    if (payload.kind === "upsert") return { ...payload, ...version, generation };
    return { ...payload, ...version, generation };
  }

  sequenceAgentUpdate<T extends object>(
    payload: T,
    value: AgentDirectoryEntry | null,
    id: string,
    includeSequence: boolean,
    includeBackground = false,
  ): T & Partial<DirectoryVersion> {
    if (value) {
      this.agents.replace(value);
    } else {
      this.agents.remove(id);
    }
    return this.withVersion(
      payload,
      includeSequence,
      this.version(this.agents, id),
      includeBackground,
    );
  }

  private metadata(read: CollectionRead<unknown>, includeBackground = false) {
    return {
      generation: this.generationFor(includeBackground),
      headSeq: read.headSeq,
      mode: read.mode,
      ...(read.reason ? { reason: read.reason } : {}),
      removals: read.removals,
    };
  }

  private withVersion<T extends object>(
    payload: T,
    includeSequence: boolean,
    version: DirectoryVersion | null,
    includeBackground = false,
  ): T & Partial<DirectoryVersion> {
    return version && includeSequence
      ? { ...payload, ...version, generation: this.generationFor(includeBackground) }
      : payload;
  }

  private read<T>(
    collection: VersionedCollection<T>,
    cursor: DirectorySyncCursor,
    includeBackground = false,
  ): CollectionRead<T> {
    if (cursor.generation !== this.generationFor(includeBackground)) {
      return collection.readSnapshot(
        cursor.generation === undefined ? "no_cursor" : "generation_changed",
      );
    }
    if (cursor.afterSeq === undefined) {
      return collection.readSnapshot("no_cursor");
    }
    return collection.readAfter(cursor.afterSeq);
  }

  private generationFor(includeBackground: boolean): string {
    return includeBackground ? `${this.generation}:background` : this.generation;
  }

  private version<T>(collection: VersionedCollection<T>, id: string): DirectoryVersion | null {
    const seq = collection.sequenceFor(id);
    return seq === null ? null : { generation: this.generation, seq };
  }
}
