async function failedResponseError(response, message) {
  const body = (await response.text()).trim();
  return new Error(body ? `${message}: ${body}` : message);
}

export async function requireSuccessfulResponse(response, message) {
  if (!response.ok) throw await failedResponseError(response, message);
}

export async function parseSuccessfulJsonResponse(response, message) {
  await requireSuccessfulResponse(response, message);
  return response.json();
}
