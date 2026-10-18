export type RetainedDataFailure = "initial" | "refresh" | undefined;

export function retainedDataFailure(
  hasData: boolean,
  failed: boolean,
): RetainedDataFailure {
  return failed ? (hasData ? "refresh" : "initial") : undefined;
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
