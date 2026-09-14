export async function settleDecisionResponse<T>(
  response: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await response();
  } catch {
    return undefined;
  }
}
