// Shared by all server instances using this process.
const projectImportTails = new Map<string, Promise<void>>();
export const withProjectImportLock = async <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const previous = projectImportTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    projectImportTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try { return await work(); } finally {
      release();
      if (projectImportTails.get(projectId) === tail) projectImportTails.delete(projectId);
    }
  };
