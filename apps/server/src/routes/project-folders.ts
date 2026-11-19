import { createHash } from "node:crypto";
import os from "node:os";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, promises as fs } from "@ponderosa/native-host/fs";
import path from "node:path";
import { managedArtifactContentPath, managedArtifactProductSql, managedWorkspacePath, type AgentStore } from "@ponderosa/agents";
import { offlineMountIdentity } from "@ponderosa/native-host";
import { projectProductSql, requestProduct } from "../product-scope.js";
import { setImmediate as yieldToServer } from "node:timers/promises";
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
  readonly store: Pick<AgentStore, "listProjects" | "getConversation" | "sqlite">;
  readonly chatCreationInProgress: () => boolean;
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
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

  const dataDir = path.dirname(options.managedWorkspacesRoot);
  const folderIdentity = (stat: NonNullable<ReturnType<typeof lstatSync>>) =>
    createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest("hex");
  // Anchor each descent to its parent's descriptor so a substituted symlink
  // or a mount added after the inventory cannot redirect recursive removal.
  const removeLinuxFolder = (folder: string, mount: bigint, identity?: string): void => {
    const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = `/proc/self/fd/${fd}`;
      const info = fstatSync(fd);
      if (offlineMountIdentity(fd) !== mount || (identity && folderIdentity(info) !== identity)) {
        throw new Error("Managed folder identity or mount changed");
      }
      for (const child of readdirSync(opened, { withFileTypes: true })) {
        const target = path.join(opened, child.name);
        if (child.isDirectory()) removeLinuxFolder(target, mount);
        else unlinkSync(target);
      }
      const current = lstatSync(folder);
      if (info.dev !== current.dev || info.ino !== current.ino) throw new Error("Managed directory moved");
      rmdirSync(folder);
    } finally {
      closeSync(fd);
    }
  };
  const relatedFolders = (a: string, b: string) => insideRoot(a, b) || insideRoot(b, a);
  const referencedFolders = () => {
    const projects = options.store.sqlite.prepare(`
      SELECT p.host_path AS hostPath FROM projects p
      WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.project_id=p.id)
        OR EXISTS (SELECT 1 FROM agents a WHERE a.project_id=p.id AND a.deleted_at IS NULL)
    `).all() as { hostPath: string }[];
    const chats = options.store.sqlite.prepare("SELECT id FROM conversations").all() as { id: string }[];
    const agents = options.store.sqlite.prepare(`
      SELECT json_extract(working_copy_json, '$.rootPath') AS hostPath FROM agents WHERE deleted_at IS NULL
    `).all() as { hostPath: string | null }[];
    const paths = new Set([...projects, ...agents].flatMap(row => row.hostPath ? [row.hostPath] : []));
    for (const chat of chats) {
      const folder = options.store.getConversation(chat.id, { includeDeleting: true })?.workingDirectory;
      if (folder) paths.add(folder);
    }
    return [...paths];
  };
  const directoryBytes = async (root: string): Promise<number | null> => {
    const pending = [root];
    let count = 0;
    let bytes = 0;
    let rootDevice: number | undefined;
    try {
      while (pending.length) {
        if (++count % 128 === 0) await yieldToServer();
        const file = pending.pop()!;
        const info = await fs.lstat(file);
        rootDevice ??= info.dev;
        if (info.dev !== rootDevice) return null;
        if (info.isDirectory()) {
          for (const name of await fs.readdir(file)) pending.push(path.join(file, name));
        } else if (info.isFile()) bytes += info.size;
      }
      return bytes;
    } catch (error) {
      return count === 1 && (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
    }
  };
  const visibleArtifacts = options.store.sqlite.prepare(`
    SELECT artifact.artifact_id AS id FROM managed_artifact_projection artifact
    WHERE artifact.project_id=? AND ${managedArtifactProductSql('artifact', 'dev')}
  `);
  const chatProjects = options.store.sqlite.prepare(`
    SELECT id, label, host_path AS path FROM projects WHERE ${projectProductSql("projects.id", "dev")}
  `);
  const projectArtifactBytes = async (id: string): Promise<number | null> => {
    let bytes = 0;
    for (const artifact of visibleArtifacts.all(id) as { id: string }[]) {
      try {
        const info = await fs.lstat(managedArtifactContentPath(dataDir, id, artifact.id));
        if (!info.isFile()) return null;
        bytes += info.size;
      } catch {
        return null;
      }
    }
    return bytes;
  };
  let measuring = false;
  app.get("/api/chat-storage", async (request, reply) => {
    if (requestProduct(request) !== "dev") return reply.code(404).send({ error: "Chat Storage belongs to Chats" });
    if (measuring) return reply.code(409).send({ error: "A storage measurement is already running" });
    measuring = true;
    try {
      await fs.mkdir(options.managedWorkspacesRoot, { recursive: true });
      const references = referencedFolders();
      const folders = [];
      const entries = await fs.readdir(options.managedWorkspacesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        let folder: string;
        try { folder = managedWorkspacePath(dataDir, entry.name); } catch { continue; }
        const before = await fs.lstat(folder).catch(() => undefined);
        if (!before?.isDirectory()) continue;
        folders.push({ name: entry.name, path: folder, bytes: await directoryBytes(folder),
          identity: folderIdentity(before),
          referenced: references.some(reference => relatedFolders(reference, folder)) });
      }
      const projects = [];
      for (const project of chatProjects.all() as { id: string; label: string; path: string }[]) {
        projects.push({ ...project, artifactBytes: await projectArtifactBytes(project.id) });
      }
      return { folders, projects };
    } finally {
      measuring = false;
    }
  });

  app.delete<{ Params: { name: string }; Body: { confirmed?: boolean; identity?: string } }>(
    "/api/chat-storage/folders/:name", async (request, reply) => {
      if (requestProduct(request) !== "dev") return reply.code(404).send({ error: "Chat Storage belongs to Chats" });
      if (request.body?.confirmed !== true || !/^[a-f0-9]{64}$/.test(request.body?.identity ?? "")) return reply.code(400).send({ error: "Confirm permanent deletion of a reviewed managed folder" });
      let folder: string;
      try { folder = managedWorkspacePath(dataDir, request.params.name); }
      catch { return reply.code(400).send({ error: "Invalid managed folder" }); }
      if (options.chatCreationInProgress() || referencedFolders().some(reference => relatedFolders(reference, folder))) {
        return reply.code(409).send({ error: "This folder still has Chat or Agent references, or Chat creation is in progress" });
      }
      try {
        // Do not cross a mount or traverse a symlink when reclaiming managed
        // storage. Keep the validation and removal in one synchronous turn.
        const root = lstatSync(options.managedWorkspacesRoot);
        const entry = lstatSync(folder);
        if (folderIdentity(entry) !== request.body.identity) {
          return reply.code(409).send({ error: "Folder identity changed. Refresh storage and review the folder again." });
        }
        if (!root.isDirectory() || !entry.isDirectory() || entry.dev !== root.dev) {
          return reply.code(409).send({ error: "The target is not an ordinary managed folder" });
        }
        if (process.platform === "linux") {
          const realFolder = realpathSync(folder);
          const mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map(line => {
            const mountPoint = line.split(" ")[4];
            if (!mountPoint?.startsWith("/")) throw new Error("Mount inventory unavailable");
            return mountPoint.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
          });
          if (mounts.some(mount => insideRoot(mount, realFolder))) {
            return reply.code(409).send({ error: "The folder contains mounted storage" });
          }
          const rootFd = openSync(options.managedWorkspacesRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            removeLinuxFolder(`/proc/self/fd/${rootFd}/${request.params.name}`, offlineMountIdentity(rootFd), request.body.identity);
          } finally {
            closeSync(rootFd);
          }
          return { deleted: true };
        }
        const pending = [folder];
        while (pending.length) {
          const current = pending.pop()!;
          const info = lstatSync(current);
          if (info.dev !== root.dev) return reply.code(409).send({ error: "The folder contains mounted storage" });
          if (info.isDirectory()) for (const name of readdirSync(current)) pending.push(path.join(current, name));
        }
        rmSync(folder, { recursive: true });
        return { deleted: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "Managed folder not found" });
        request.log.error({ err: error }, "Managed folder removal failed");
        return reply.code(409).send({ error: "Could not remove the managed folder fully. Refresh storage before retrying." });
      }
    },
  );

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
