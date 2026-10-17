import { Schema } from "effect";

export const ActionInput = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.Json),
  repositoryFullName: Schema.optionalKey(Schema.Json),
});
export interface ActionInput extends Schema.Schema.Type<typeof ActionInput> {}
