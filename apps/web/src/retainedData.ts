export type RetainedDataState = "loading" | "error" | "ready";

export function retainedDataState(
  hasData: boolean,
  failed: boolean,
): RetainedDataState {
  if (hasData) return "ready";
  return failed ? "error" : "loading";
}

export async function loadRetainedData<T>(
  request: () => Promise<T>,
  onError: (message: string | undefined) => void,
  fallbackMessage: string,
): Promise<T | undefined> {
  onError(undefined);
  try {
    return await request();
  } catch (error) {
    onError(error instanceof Error && error.message
      ? `${fallbackMessage} ${error.message}`
      : fallbackMessage);
    return undefined;
  }
}
