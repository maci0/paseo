import type { PluginHookEvents } from "@getpaseo/plugin/server";
import type {
  PluginBeforeResults,
  PluginLifecycle,
  PluginLifecycleHooks,
  PluginWireBeforeRequests,
} from "../plugins/lifecycle/index.js";

/**
 * PluginLifecycleHooks over a fake written against PluginLifecycle's generic before, emit and
 * wait: each per-hook method calls the fake with that hook's name. A missing before returns
 * the request unchanged, as PluginService does without plugins.
 */
export function pluginHooksFrom(fake: Partial<PluginLifecycle>): PluginLifecycleHooks {
  function before<Name extends keyof PluginWireBeforeRequests>(
    name: Name,
    request: PluginWireBeforeRequests[Name],
  ): Promise<PluginBeforeResults[Name]> {
    return fake.before ? fake.before(name, request) : Promise.resolve(request);
  }
  function emit<Name extends keyof PluginHookEvents>(
    name: Name,
    event: PluginHookEvents[Name],
  ): void {
    fake.emit?.(name, event);
  }
  return {
    wait: (name, payload) => (fake.wait ? fake.wait(name, payload) : Promise.resolve()),
    beforeWorkspaceCreate: (request) => before("workspace.create.before", request),
    beforeWorktreeCreate: (request) => before("worktree.create.before", request),
    beforeAgentCreate: (request) => before("agent.create.before", request),
    beforeAgentOpen: (request) => before("agent.open.before", request),
    emitWorkspaceCreateAfter: (event) => emit("workspace.create.after", event),
    emitAgentCreateAfter: (event) => emit("agent.create.after", event),
    emitAgentArchiveAfter: (event) => emit("agent.archive.after", event),
    emitAgentCloseAfter: (event) => emit("agent.close.after", event),
    emitAgentTurnBefore: (event) => emit("agent.turn.before", event),
    emitAgentTurnAfter: (event) => emit("agent.turn.after", event),
    emitAgentPermissionBefore: (event) => emit("agent.permission.before", event),
    emitAgentPermissionAfter: (event) => emit("agent.permission.after", event),
  };
}
