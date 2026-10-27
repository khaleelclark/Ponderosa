import { DEFAULT_ASSET_LIMITS, decisionAnswersError, type DecisionAnswerDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { api } from "../../api";
import { createClientId } from "../../clientId";
import type { DecisionPrompt } from "../../decisions";
import { queryKeys } from "../../queryKeys";
import { composerAttachmentReducer } from "../chat/composerUtils";
import { useComposerDraftAttachments } from "../chat/useComposerDraftAttachments";

/** The existing draft store/upload queue, owned by this Decision alone. */
export function useDecisionAnswerDraft(decision: DecisionPrompt, open: boolean) {
  const scope = decision.agentId && !decision.runtimeAction ? `agent:${decision.agentId}` : undefined;
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<DecisionAnswerDto[] | undefined>(() => decision.questions?.map(question => ({ questionId: question.id, status: "answered", text: "", attachmentIds: [] })));
  const questionByFile = useRef(new Map<File, string>());
  const signatureOf = (text: string, ids: string[], answers?: DecisionAnswerDto[]) => JSON.stringify(answers ? [text, ids, answers] : [text, ids]);
  const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
  const [ready, setReady] = useState(!scope), [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>(), [retry, setRetry] = useState(0);
  const mounted = useRef(true), loaded = useRef(false), revision = useRef(0), saved = useRef("");
  const [clientId] = useState(() => createClientId());
  const writes = useRef(Promise.resolve());
  const { data: limits = DEFAULT_ASSET_LIMITS } = useQuery({ queryKey: queryKeys.assetLimits.all,
    queryFn: () => api.getAssetLimits(), staleTime: 5 * 60_000, enabled: open && Boolean(scope) });
  const uploads = useComposerDraftAttachments({ assetLimits: limits, conversationDraftId: scope, draftOwnerId: decision.id,
    files: attachments.files, dispatch, onEdit() {}, onBeforeClear() {} });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !scope || loaded.current) return;
    let cancelled = false;
    const signal = AbortSignal.timeout(30_000);
    setLoadError(undefined);
    void api.getConversationDraft(scope, decision.id, signal).then(async draft => {
      const stored = draft.attachments ?? [];
      if (draft.conversationId !== scope || draft.ownerId !== decision.id ||
          stored.length !== draft.attachmentIds.length || stored.some((file, index) => file.id !== draft.attachmentIds[index] || file.ownerId !== decision.id || file.conversationId !== scope))
        throw new Error("This Decision draft could not be verified.");
      const retainedAnswers = draft.decisionAnswers ?? answers;
      if (decision.questions && (decisionAnswersError(decision.questions, retainedAnswers, true) ||
          JSON.stringify(retainedAnswers!.flatMap(answer => answer.attachmentIds ?? []).sort()) !== JSON.stringify([...draft.attachmentIds].sort()))) throw new Error("The saved question/file identities could not be verified.");
      const restored = await Promise.all(stored.map(async attachment => ({ attachment, file: await api.downloadDraftAttachment(attachment, signal) })));
      if (cancelled) return;
      revision.current = draft.revision;
      saved.current = signatureOf(draft.text, draft.attachmentIds, retainedAnswers);
      for (const item of restored) {
        const owner = retainedAnswers?.find(answer => answer.attachmentIds?.includes(item.attachment.id));
        if (owner) questionByFile.current.set(item.file, owner.questionId);
      }
      setAnswers(retainedAnswers);
      setText(draft.text); uploads.replaceRestored(restored); loaded.current = true; setReady(true);
    }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "The answer draft could not be loaded."); });
    return () => { cancelled = true; };
  }, [open, scope, decision.id, retry]);
  const ids = attachments.files.flatMap(file => uploads.attachmentIds.current.get(file) ?? []);
  const retainedAnswers = answers?.map(answer => ({ ...answer, ...(answer.status === "answered" ? { attachmentIds: attachments.files.flatMap(file => questionByFile.current.get(file) === answer.questionId ? uploads.attachmentIds.current.get(file) ?? [] : []) } : {}) }));
  const signature = signatureOf(text, ids, retainedAnswers);
  const latest = useRef({ text, ids, answers: retainedAnswers, signature }); latest.current = { text, ids, answers: retainedAnswers, signature };
  useEffect(() => { for (const file of questionByFile.current.keys()) if (!attachments.files.includes(file)) questionByFile.current.delete(file); }, [attachments.files]);
  useEffect(() => {
    if (!scope || !ready || signature === saved.current) return;
    const timer = setTimeout(() => {
      writes.current = writes.current.catch(() => {}).then(async () => {
        if (!mounted.current) return;
        const snapshot = latest.current;
        if (snapshot.signature === saved.current) return;
        try {
          const draft = await api.putConversationDraft(scope, { ownerId: decision.id, text: snapshot.text, attachmentIds: snapshot.ids,
            ...(snapshot.answers ? { decisionAnswers: snapshot.answers } : {}), expectedRevision: revision.current, clientId }, AbortSignal.timeout(10_000));
          revision.current = draft.revision; saved.current = snapshot.signature;
          if (mounted.current) setSaveError(undefined);
        } catch {
          // One canonical read can confirm a lost write; never overwrite a
          // different window's draft using a guessed newer revision.
          try {
            const draft = await api.getConversationDraft(scope, decision.id, AbortSignal.timeout(10_000));
            if (draft.conversationId === scope && draft.ownerId === decision.id && signatureOf(draft.text, draft.attachmentIds, draft.decisionAnswers) === snapshot.signature) {
              revision.current = draft.revision; saved.current = snapshot.signature;
              if (mounted.current) setSaveError(undefined);
              return;
            }
          } catch { /* retain the local answer and original File objects */ }
          if (mounted.current) setSaveError("The draft save could not be confirmed. Keep this window open; your answer is retained here.");
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [scope, ready, signature, decision.id, retry]);
  return { text, setText, answers: retainedAnswers,
    setAnswer: (answer: DecisionAnswerDto) => setAnswers(previous => previous?.map(item => item.questionId === answer.questionId ? answer : item)),
    addFiles: (files: File[], questionId?: string) => {
      if (decision.questions && (!questionId || !decision.questions.some(q => q.id === questionId))) return;
      if (questionId) setAnswers(previous => previous?.map(answer => answer.questionId === questionId ? { ...answer, status: "answered", optionId: undefined } : answer));
      if (questionId) for (const file of files) questionByFile.current.set(file, questionId);
      uploads.addFiles(files);
    },
    questionByFile: questionByFile.current,
    attachments, uploads, limits, ready, loadError, saveError, canAttach: Boolean(scope),
    retry: () => setRetry(value => value + 1),
    attachmentIds: ids, uploadsComplete: ids.length === attachments.files.length };
}
