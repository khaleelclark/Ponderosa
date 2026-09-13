import type { SpeechStatusDto, SynthesizeSpeechRequest } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../api/real";

export const speechStatusKey = ["speech-status"] as const;
export const claimSpeechSuggestion = () => requestJson<{ show: boolean }>("/api/speech/suggestion/claim", { method: "POST" });
export function useSpeechStatus() {
  return useQuery({ queryKey: speechStatusKey, queryFn: () => requestJson<SpeechStatusDto>("/api/speech/status"), staleTime: 30_000 });
}
export function speechCommand(action: "install" | "repair" | "update" | "install/cancel" | "remove" | "clear-cache") {
  return requestJson<SpeechStatusDto>(action === "clear-cache" ? "/api/speech/cache" : `/api/speech/kokoro${action === "remove" ? "" : `/${action}`}`, {
    method: action === "remove" || action === "clear-cache" ? "DELETE" : "POST",
  });
}
export async function synthesizeSpeech(input: SynthesizeSpeechRequest, signal: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/speech/synthesize", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  });
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "audio/wav") throw new Error("Local speech could not complete.");
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared < 44 || declared > 2_880_044) throw new Error("Invalid local audio response.");
  const blob = await response.blob();
  if (blob.size !== declared) throw new Error("Incomplete local audio response.");
  return blob;
}
