import os from "node:os";
import { promises as fs } from "@ponderosa/native-host/fs";
import path from "node:path";
import type { AgentStore } from "@ponderosa/agents";
import type {
  CreateHostFolderRequest,
  HostFolderBrowseDto,
  HostFolderCreateDto,
  ProjectFolderOptionsDto,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";

export interface ProjectFolderRoutesOptions {
  readonly managedWorkspacesRoot: string;
  readonly pathBoundary: ProjectFolderPathBoundary;
  readonly store: Pick<AgentStore, "listProjects">;
}

export interface ProjectFolderPathBoundary {
  insideRoot(candidate: string, root: string): boolean;
  validatedBrowsePath(input: string): Promise<{ candidate: string; root: string }>;
  defaultBrowsePath(): Promise<string>;
}

export function createProjectFolderPathBoundary(options: {
  readonly managedWorkspacesRoot: string;
  readonly allowedBrowseRoots?: readonly string[];
}): ProjectFolderPathBoundary {
  const configuredBrowseRoots = (options.allowedBrowseRoots
    ?? (process.env.PONDEROSA_BROWSE_ROOTS ?? "").split(path.delimiter))
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  const restrictedBrowseRoots = async (): Promise<string[]> => {
    const resolved: string[] = [];
    for (const root of configuredBrowseRoots) {
      try {
        const real = await fs.realpath(root);
        if ((await fs.stat(real)).isDirectory() && !resolved.includes(real)) resolved.push(real);
      } catch { /* invalid configured roots are not exposed */ }
    }
    return resolved;
  };

  const insideRoot = (candidate: string, root: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const validatedBrowsePath = async (input: string): Promise<{ candidate: string; root: string }> => {
    const candidate = await fs.realpath(path.resolve(input));
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error("path must be a directory");
    const roots = await restrictedBrowseRoots();
    const root = roots.length > 0
      ? roots.find((allowed) => insideRoot(candidate, allowed))
      : path.parse(candidate).root;
    if (!root) throw new Error("path is outside configured browse roots");
    return { candidate, root };
  };

  const defaultBrowsePath = async (): Promise<string> => {
    const restrictedRoots = await restrictedBrowseRoots();
    if (restrictedRoots[0]) return restrictedRoots[0];
    try {
      const home = await fs.realpath(os.homedir());
      if ((await fs.stat(home)).isDirectory()) return home;
    } catch { /* use the managed workspace when the host home is unavailable */ }
    await fs.mkdir(options.managedWorkspacesRoot, { recursive: true });
    return fs.realpath(options.managedWorkspacesRoot);
  };

  return { insideRoot, validatedBrowsePath, defaultBrowsePath };
}

export function registerProjectFolderRoutes(
  app: FastifyInstance,
  options: ProjectFolderRoutesOptions,
): void {
  const { defaultBrowsePath, insideRoot, validatedBrowsePath } = options.pathBoundary;

  app.get("/api/project-folders", async (): Promise<ProjectFolderOptionsDto> => {
    await fs.mkdir(options.managedWorkspacesRoot, { recursive: true });
    const registered = options.store.listProjects().map((project) => ({
      hostPath: project.hostPath,
      name: project.label,
      source: "registered" as const,
    }));
    const managedEntries = await fs.readdir(options.managedWorkspacesRoot, { withFileTypes: true });
    const managed = managedEntries.filter((entry) => entry.isDirectory()).map((entry) => ({
      hostPath: path.join(options.managedWorkspacesRoot, entry.name),
      name: entry.name,
      source: "managed" as const,
    }));
    const folders = new Map<string, ProjectFolderOptionsDto["folders"][number]>();
    for (const folder of [...registered, ...managed]) {
      if (!folders.has(folder.hostPath)) folders.set(folder.hostPath, folder);
    }
    return {
      managedRoot: options.managedWorkspacesRoot,
      folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  app.get<{ Querystring: { path?: string } }>(
    "/api/project-folders/browse",
    async (request, reply): Promise<HostFolderBrowseDto | unknown> => {
      try {
        const requested = request.query.path || await defaultBrowsePath();
        const { candidate, root } = await validatedBrowsePath(requested);
        const entries = await fs.readdir(candidate, { withFileTypes: true });
        const folders: HostFolderBrowseDto["folders"] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          try {
            const hostPath = await fs.realpath(path.join(candidate, entry.name));
            if (!insideRoot(hostPath, root) || !(await fs.stat(hostPath)).isDirectory()) continue;
            folders.push({ name: entry.name, hostPath });
          } catch { /* broken/inaccessible links are omitted */ }
        }
        const parent = path.dirname(candidate);
        return {
          path: candidate,
          root,
          ...(insideRoot(parent, root) ? { parentPath: parent } : {}),
          folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "folder is unavailable",
        });
      }
    },
  );

  app.post<{ Body: CreateHostFolderRequest }>(
    "/api/project-folders/create",
    async (request, reply): Promise<HostFolderCreateDto | unknown> => {
      const parentPath = request.body?.parentPath?.trim();
      const name = request.body?.name?.trim();
      if (!parentPath) return reply.code(400).send({ error: "parentPath is required" });
      if (!name || !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(name) || name === "." || name === "..") {
        return reply.code(400).send({ error: "folder name must be a single safe name" });
      }
      try {
        const parent = await validatedBrowsePath(parentPath);
        const requestedPath = path.join(parent.candidate, name);
        if (!insideRoot(requestedPath, parent.root)) {
          return reply.code(400).send({ error: "folder is outside the configured browse root" });
        }
        await fs.mkdir(requestedPath, { recursive: false });
        const hostPath = await fs.realpath(requestedPath);
        return { name, hostPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return reply.code(409).send({ error: "folder already exists" });
        }
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "folder could not be created",
        });
      }
    },
  );
}
