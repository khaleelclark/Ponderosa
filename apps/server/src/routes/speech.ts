import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "@ponderosa/agents";
import { DEFAULT_SPEECH_PREFERENCES, SPEECH_LIMITS, type SynthesizeSpeechRequest } from "@ponderosa/core";
import { SpeechService } from "../speech-service.js";

/** Registered under the same host authentication/origin hooks as other APIs. */
export function registerSpeechRoutes(app: FastifyInstance, context: {
  dataDir: string;
  workspace: WorkspaceStore;
  changed(): void;
  observe?(event:string,fields:Record<string,number|string>):void;
  publishWorkspaceSince(cursor: number): void;
}): void {
  const selectEngine = (removed = false) => {
    const speech = context.workspace.getPreferences().speech ?? DEFAULT_SPEECH_PREFERENCES;
    if (!removed && speech.engineExplicit) return;
    const cursor = context.workspace.cursor();
    context.workspace.updatePreferences({ speech: { ...speech, engine: removed ? "browser" : "kokoro" } });
    context.publishWorkspaceSince(cursor);
  };
  const service = new SpeechService(context.dataDir, context.changed, () => selectEngine(), undefined, context.observe);
  app.addHook("onReady", async () => service.initialize());
  app.addHook("onClose", async () => service.close());
  app.get("/api/speech/status", async () => service.status());
  app.post("/api/speech/suggestion/claim", async () => {
    const speech=context.workspace.getPreferences().speech??DEFAULT_SPEECH_PREFERENCES;
    if(speech.localVoiceSuggestion!=="unseen")return {show:false};
    const cursor=context.workspace.cursor();
    context.workspace.updatePreferences({speech:{...speech,localVoiceSuggestion:"dismissed"}});
    context.publishWorkspaceSince(cursor);
    return {show:true};
  });
  app.get("/api/speech/notices", async (_request, reply) => {
    try{return reply.type("text/plain; charset=utf-8").header("X-Content-Type-Options","nosniff").send(await service.notices());}
    catch{return reply.type("text/plain; charset=utf-8").send(
    "Ponderosa local speech — private Pine / Linux x64 release\n\n" +
    "Kokoro 82M / Kokoro 1.0: Apache-2.0; https://huggingface.co/hexgrad/Kokoro-82M\n" +
    "sherpa-onnx 1.13.8: Apache-2.0; https://github.com/k2-fsa/sherpa-onnx\n" +
    "ONNX Runtime: MIT; https://github.com/microsoft/onnxruntime\n" +
    "eSpeak NG phonemization: GPL-3.0; https://github.com/espeak-ng/espeak-ng\n\n" +
    "Voice mappings: Willow = af_heart; Cedar = am_michael; Hazel = bf_emma.\n" +
    "Complete license texts are included in the private optional package's notices directory. Corresponding source inputs are distributed beside the package in the same private release. " +
    "This release is qualified for Pine's Linux host; Windows and macOS hosting are not enabled. Windows/macOS browsers can use the Pine host. " +
    "The private package mirror is retained as installation media when installed voices are removed. Public redistribution requires separate review.\n",
  );}
  });
  for (const action of ["install", "repair", "update"] as const) {
    app.post(`/api/speech/kokoro/${action}`, async (_request, reply) => {
      try {
        if (action === "install") service.install(); else await service.repair();
        return reply.code(202).send(service.status());
      } catch { return reply.code(409).send({ error: "Local voices cannot start this operation. Check voice settings." }); }
    });
  }
  app.post("/api/speech/kokoro/install/cancel", async () => { await service.cancelInstall(); return service.status(); });
  app.delete("/api/speech/kokoro", async (_request, reply) => {
    try { await service.remove(); selectEngine(true); return service.status(); }
    catch { return reply.code(409).send({ error: "Local voices could not be removed safely. Cancel any installation and retry." }); }
  });
  app.delete("/api/speech/cache", async () => { service.clearCache(); return service.status(); });
  app.post<{ Body: SynthesizeSpeechRequest }>("/api/speech/synthesize", {
    bodyLimit: SPEECH_LIMITS.segmentBytes * 8,
  }, async (request, reply) => {
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", disconnect);
    try {
      const audio = await service.synthesize(request.body, controller.signal);
      return reply.header("Content-Type", "audio/wav")
        .header("Content-Length", audio.length)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Speech-Request-Id", request.id).send(audio);
    } catch {
      return reply.code(409).send({ error: "Local speech could not complete. Use browser voice or try again." });
    } finally { reply.raw.off("close", disconnect); }
  });
}
