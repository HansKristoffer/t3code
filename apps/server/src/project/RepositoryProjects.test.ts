// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as RepositoryProjects from "./RepositoryProjects.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-repository-projects-"));
const projects: Array<{ id: string; workspaceRoot: string; repositoryIdentity: unknown }> = [];
const clones: Array<string> = [];
NodeFS.mkdirSync(NodePath.join(root, "repo"));

const TestLayer = RepositoryProjects.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      listShells: () => Effect.succeed([...projects] as never),
      create: (input) =>
        Effect.sync(() => {
          projects.push({
            id: input.projectId,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: { canonicalKey: "github.com/acme/repo" },
          });
          return {} as never;
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: root }),
  ),
  Layer.provide(
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: ({ destinationPath, remoteUrl }) =>
        Effect.sync(() => {
          clones.push(destinationPath);
          return { cwd: destinationPath, remoteUrl: remoteUrl!, repository: null };
        }),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

describe("RepositoryProjects", () => {
  it.effect("clones a missing repository beside taken folders, then reuses it", () =>
    Effect.gen(function* () {
      const repositories = yield* RepositoryProjects.RepositoryProjects;
      const input = {
        canonicalKey: "github.com/acme/repo",
        remoteUrl: "git@github.com:acme/repo.git",
        title: "Repo",
      };
      const first = yield* repositories.ensure(input);
      const second = yield* repositories.ensure(input);

      assert.deepEqual(clones, [NodePath.join(root, "repo-2")]);
      assert.isTrue(first.cloned);
      assert.deepEqual(second, { ...first, cloned: false });
    }).pipe(Effect.provide(TestLayer)),
  );
});
