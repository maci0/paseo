import { waitForLocationReady } from "./readiness.js";

import type { CommandListOutput, SkillListOutput } from "@opencode/client";
import type { V2Api } from "./api.js";

import type { AgentSlashCommand } from "../../../agent-sdk-types.js";

export async function commands(client: V2Api, directory: string): Promise<AgentSlashCommand[]> {
  const location = { directory };
  await waitForLocationReady({ client, location });
  // scriptc lowers Promise.all over the opencode client's calls only through typed promise bindings.
  const configuredRequest: Promise<CommandListOutput> = client.command.list({ location });
  const skillsRequest: Promise<SkillListOutput> = client.skill.list({ location });
  const [configured, skills] = await Promise.all([configuredRequest, skillsRequest]);
  const result = new Map<string, AgentSlashCommand>();
  for (const name of ["compact", "summarize"])
    result.set(name, {
      name,
      description: "Compact the current session",
      argumentHint: "",
      kind: "command",
    });
  for (const command of configured.data)
    result.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      argumentHint: "",
      kind: "command",
    });
  for (const skill of skills.data) {
    if (result.has(skill.id)) continue;
    result.set(skill.id, {
      name: skill.id,
      description: skill.description ?? "",
      argumentHint: "",
      kind: "skill",
    });
  }
  return [...result.values()];
}
