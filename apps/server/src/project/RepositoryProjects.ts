import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ProjectEnsureRepositoryError,
  ProjectId,
  type OrchestrationProjectShell,
  type ProjectEnsureRepositoryInput,
  type ProjectEnsureRepositoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

/**
 * Projects by repository rather than by path. Another environment names a
 * repository by its canonical key; this one finds its project for it, or
 * clones the remote into its projects folder and adds one. New threads aimed
 * at a machine without the repository and thread transfers both go through
 * here, so both clone the same way.
 */
export class RepositoryProjects extends Context.Service<
  RepositoryProjects,
  {
    readonly find: (
      canonicalKey: string,
    ) => Effect.Effect<OrchestrationProjectShell | null, ProjectEnsureRepositoryError>;
    readonly ensure: (
      input: ProjectEnsureRepositoryInput,
    ) => Effect.Effect<ProjectEnsureRepositoryResult, ProjectEnsureRepositoryError>;
  }
>()("t3/project/RepositoryProjects") {}

const fail = (message: string) => (cause: unknown) =>
  new ProjectEnsureRepositoryError({ message, cause });

/** The folder name a clone of `remoteUrl` gets: its last path segment, without `.git`. */
export function repositoryFolderName(remoteUrl: string): string {
  return (
    remoteUrl
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, "")
      .replace(/[^\w.-]+/g, "-") || "project"
  );
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  // ponytail: one clone at a time, so two requests for one repository cannot clone it twice.
  const cloneLock = yield* Semaphore.make(1);

  const find: RepositoryProjects["Service"]["find"] = Effect.fn("RepositoryProjects.find")(
    function* (canonicalKey) {
      const shells = yield* projects
        .listShells()
        .pipe(Effect.mapError(fail("Could not read the projects.")));
      for (const shell of shells) {
        const key =
          shell.repositoryIdentity?.canonicalKey ??
          (yield* identities.resolve(shell.workspaceRoot))?.canonicalKey ??
          null;
        if (key === canonicalKey) return shell;
      }
      return null;
    },
  );

  const clone = Effect.fn("RepositoryProjects.clone")(function* (
    input: ProjectEnsureRepositoryInput,
  ) {
    const root = managedFolders.namedProjectsRoot;
    yield* fileSystem
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(fail("Could not create the projects folder.")));
    const name = repositoryFolderName(input.remoteUrl);
    let destinationPath = path.join(root, name);
    for (
      let attempt = 2;
      yield* fileSystem.exists(destinationPath).pipe(Effect.orElseSucceed(() => true));
      attempt += 1
    ) {
      if (attempt > 50) {
        return yield* new ProjectEnsureRepositoryError({
          message: `Every folder name for '${name}' is taken.`,
        });
      }
      destinationPath = path.join(root, `${name}-${attempt}`);
    }
    yield* repositories
      .cloneRepository({ remoteUrl: input.remoteUrl, destinationPath })
      .pipe(Effect.mapError(fail(`Could not clone ${input.remoteUrl} on this environment.`)));
    yield* identities.resolve(destinationPath, { refresh: true });
    const projectId = ProjectId.make(NodeCrypto.randomUUID());
    yield* projects
      .create({
        commandId: CommandId.make(`repository-project:${projectId}`),
        projectId,
        title: input.title,
        workspaceRoot: destinationPath,
      })
      .pipe(
        Effect.mapError(fail("Could not add the cloned repository as a project.")),
        Effect.tapError(() => repositories.discardClone(destinationPath).pipe(Effect.ignore)),
      );
    return { projectId, workspaceRoot: destinationPath, cloned: true };
  });

  const ensure: RepositoryProjects["Service"]["ensure"] = (input) =>
    cloneLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* find(input.canonicalKey);
        if (existing !== null) {
          return { projectId: existing.id, workspaceRoot: existing.workspaceRoot, cloned: false };
        }
        return yield* clone(input);
      }),
    );

  return RepositoryProjects.of({ find, ensure });
});

export const layer = Layer.effect(RepositoryProjects, make);
