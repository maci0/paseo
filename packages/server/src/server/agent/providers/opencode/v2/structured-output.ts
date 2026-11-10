import { z } from "zod";
import type { SessionMessageInfo } from "@opencode/client";
import { createJsonSchemaCompiler } from "../../../json-schema-validator.js";

export const STRUCTURED_OUTPUT_TOOL = "paseo_structured_output";
const schemas = createJsonSchemaCompiler();

export function structuredOutput(input: unknown) {
  const schema = z.union([z.boolean(), z.record(z.string(), z.json())]).parse(input);
  const compiled = schemas.compile(schema);
  return {
    schema,
    assert(history: SessionMessageInfo[]) {
      const start = history.findLastIndex((message) => message.type === "user");
      for (const message of history.slice(start + 1)) {
        if (message.type !== "assistant") continue;
        for (const part of message.content) {
          if (
            part.type !== "tool" ||
            part.name !== STRUCTURED_OUTPUT_TOOL ||
            part.state.status !== "completed"
          )
            continue;
          const result = part.state.metadata?.paseoStructuredOutput;
          if (result === undefined) continue;
          const errors = compiled.validate(result);
          if (errors.length > 0)
            throw new Error(`Invalid OpenCode structured output: ${schemas.errorsText(errors)}`);
          return;
        }
      }
      throw new Error("OpenCode finished without submitting the required structured output");
    },
  };
}
