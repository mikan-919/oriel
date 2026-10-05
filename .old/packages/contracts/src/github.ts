import * as v from "valibot";

export const githubRepositorySchema = v.strictObject({
  owner: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
});

export type GitHubRepository = v.InferOutput<typeof githubRepositorySchema>;
