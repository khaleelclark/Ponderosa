import {NativePortableImportChoices,nativeImportChoiceError,type NativeImportChoices} from './NativePortableDataChoices';
import {PendingAgentImportRecovery} from './PendingAgentImportRecovery';
import {fingerprintAgentImport} from './agentImportFingerprint';
import {agentImportFingerprintHeader,agentImportOperationMatches,listPendingAgentImports,releasePendingAgentImport,retainPendingAgentImport,type AgentImportMetadata,type PendingAgentImport} from './agentImportRecovery';
import {currentProductScope} from '../api/productScope';
import {ensureCreationAttemptPersisted,mayRecordCreationReceipt,mayRetryCreationAttempt,readDurableChatAttempts,saveCreationAttempts,sameCreationAttempt,sameCreationOwner,submitCreationAttempt,type ChatCreationAttempt} from './chatCreationAttempts';

import {LifecycleReview} from './lifecycle/LifecycleReview';
import {NativeApplications,PostImportAccessReview} from './PostImportAccessReview';
import {validWorkingRootDestinations} from './workingRootDestinations';
import type { PortableAgentPreview } from "./agent-package-preview.types";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL, AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL, type AgentDto, type ConversationDto, type EngineDto, type ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {
  engineIsAvailable,
  engineUnavailableReason,
  soleAvailableEngineId,
} from "../conversationEngine";
import { useMutationNotification } from "./MutationNotifications";
import { agentBelongsToConversation } from "../agents";
import { externalAgentImportPrompt } from "./externalAgentImportPrompt";

import { ChatInstructionsImportChoice, chatInstructionsResolution, type ChatInstructionsAction } from "./ChatInstructionsImportChoice";

const MAX_IMPORT_FILE_BYTES = AGENT_PACKAGE_MAX_BYTES;
const LARGE_PASTE_CHARACTERS = 256 * 1024;

export function ImportAgentForm({
  projectId: sourceProjectId,
  engines,
  conversations: sourceConversations,
  initialConversationId,
  fixedConversationId,
  requireDestinationSelection = false,
  onCancel,
  onPendingChange,
  onSubmitted,
  stickyActions = false,
}: {
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  fixedConversationId?: string;
  requireDestinationSelection?: boolean;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
  onSubmitted?(): void;
  stickyActions?: boolean;
}): JSX.Element {
  const notify = useMutationNotification();
  const [createdChat,setCreatedChat]=useState<ConversationDto>();
  const projectId=createdChat?.projectId??sourceProjectId;
  const conversations=createdChat?[createdChat]:sourceConversations;
  const [newChatLabel,setNewChatLabel]=useState('');
  const [newFolderName,setNewFolderName]=useState('');
  const [newChatEngine,setNewChatEngine]=useState('');
  const createChatRequestId=useRef(createClientId());
  const [creationAttempt,setCreationAttempt]=useState<ChatCreationAttempt>();
  const creationAttemptRef=useRef<ChatCreationAttempt>();
  const product=currentProductScope();
  const [activateWorkingFiles,setActivateWorkingFiles]=useState(false);
  const [confirmSharedRoot,setConfirmSharedRoot]=useState(false);
  const createDestination=useMutation({mutationFn:async()=>{
    let attempt=creationAttemptRef.current;
    if(!attempt){
      const engine=engines.find(item=>item.id===newChatEngine&&engineIsAvailable(item));
      if(!engine||!newChatLabel.trim()||!newFolderName.trim())throw new Error('Choose a name, new managed folder name and available engine.');
      const selected=conversations.find(chat=>chat.id===conversationId);
      if(product==='branches'&&(!selected?.branchId||selected.executionId))throw new Error('Choose a persistent Branch Chat to identify the destination workflow.');
      if(product==='dev'&&selected?.branchId)throw new Error('Choose a Chat in this product.');
      const owner=product==='branches'?{product:'branches' as const,branchId:selected!.branchId!}:undefined;
      const input={label:newChatLabel.trim(),createFolderName:newFolderName.trim(),defaultEngine:engine.id};
      // On a reopened form, the same explicit request retries its durable key.
      const journal=readDurableChatAttempts();
      const previous=journal.filter(item=>item.origin==='import_destination'&&!item.chat&&sameCreationOwner(item.owner,owner)&&JSON.stringify(item.input)===JSON.stringify(input));
      if(previous.length>1)throw Error('Multiple earlier destination requests have these details. Recover the original request before continuing.');
      attempt=previous[0]??{key:createChatRequestId.current,origin:'import_destination',...(owner?{owner}:{}),input};
      if(previous.length ? !mayRetryCreationAttempt(journal,attempt) : journal.some(item=>sameCreationAttempt(item,attempt!)))
        throw Error('Saved destination request changed or has a receipt; it remains preserved.');
      if(!ensureCreationAttemptPersisted(attempt))throw new Error('Browser storage is unavailable. No destination was created.');
      creationAttemptRef.current=attempt;setCreationAttempt(attempt);
    }else {
      if(!mayRetryCreationAttempt(readDurableChatAttempts(),attempt))throw new Error('Saved destination request changed or has a receipt; it remains preserved.');
      if(!ensureCreationAttemptPersisted(attempt))throw new Error('Browser storage is unavailable. The original destination request is retained.');
    }
    const chat=await submitCreationAttempt(attempt);
    if(!chat.id||!chat.projectId||(attempt.owner ? chat.branchId!==attempt.owner.branchId||Boolean(chat.executionId) : Boolean(chat.branchId)))
      throw new Error('Destination receipt does not match the requested product and workflow.');
    return {chat,attempt};
  },onSuccess:({chat,attempt})=>{
    let saved=false,matchingEvidence=false;
    try{
      const journal=readDurableChatAttempts();
      if(mayRecordCreationReceipt(journal,attempt,chat)){
        matchingEvidence=true;
        saved=saveCreationAttempts([...journal.filter(item=>!sameCreationAttempt(item,attempt)),{...attempt,chat:{id:chat.id,projectId:chat.projectId}}]);
      }
    }catch{/* Keep the original evidence when the journal cannot be read. */}
    if(!matchingEvidence){setError('Destination receipt conflicts with saved information, or the saved information is unavailable. The original evidence is retained.');return;}
    setError(saved?undefined:'Destination was created, but its local receipt could not be saved. The original request is retained for recovery.');
    creationAttemptRef.current=undefined;setCreationAttempt(undefined);setCreatedChat(chat);setConversationId(chat.id);setConfirmSharedRoot(false);
  },onError:cause=>{
    // Even a 4xx can follow a committed Chat or an earlier lost response.
    // Retain its exact identity; only an explicit retry may submit it again.
    const attempt=creationAttemptRef.current;
    const message=cause instanceof Error?cause.message:'Destination creation failed.';
    setError(attempt?`${message} Destination creation is unconfirmed. Retry the same request, or close to correct the details. The original request is retained.`:message);
  },onSettled:()=>{pendingRef.current=false;onPendingChange?.(false);}});

  const [packageBlob, setPackageBlob] = useState<Blob>();
  const [importResult,setImportResult]=useState<import('@ponderosa/core').ImportAgentPackageResponse>();
  const [completedImport,setCompletedImport]=useState<PendingAgentImport>();
  const [failedImport,setFailedImport]=useState<PendingAgentImport>();
  const [partialResult,setPartialResult]=useState<import('@ponderosa/core').ImportAgentPackageResponse>();
  const [roleOperation,setRoleOperation]=useState<import('@ponderosa/core').AgentImportOperationDto>();
  const [operationProjectId,setOperationProjectId]=useState<string>();
  const [recoveryReview,setRecoveryReview]=useState<import('@ponderosa/core').OutputRoleImportReviewDto>();
  const [lifecycleOperationId,setLifecycleOperationId]=useState<string>();
  const operationQuery=useQuery({queryKey:['role-import-operation',operationProjectId??projectId,roleOperation?.id],queryFn:()=>api.getAgentImportOperation(operationProjectId??projectId,roleOperation!.id),enabled:Boolean(roleOperation),refetchInterval:q=>q.state.data?.status==='completed'||q.state.data?.status==='failed'?false:500});
  const [roleReview,setRoleReview]=useState<import('@ponderosa/core').OutputRoleImportReviewDto>();
  const [accessReview,setAccessReview]=useState<import('@ponderosa/core').AgentAccessImportReviewDto>();
  const [accessAction,setAccessAction]=useState<''|'keep_destination'|'use_source'>('');

  const [packagePreview, setPackagePreview] = useState<PortableAgentPreview>();
  const sourceAgentNames=useMemo(()=>{
    const identities=packagePreview?.agentIdentities??[],counts=new Map<string,number>();
    for(const {title} of identities)counts.set(title,(counts.get(title)??0)+1);
    return new Map(identities.map(({ref,title})=>[ref,title==="Imported Agent"||(counts.get(title)??0)>1?`${title} (${ref})`:title]));
  },[packagePreview]);
  const [inspecting, setInspecting] = useState(false);
  const [inspectionPhase, setInspectionPhase] = useState<string>();
  const [fileName, setFileName] = useState<string>();
  const [jsonText, setJsonText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [workingFilesDestination,setWorkingFilesDestination]=useState('');
  const [workingRootDestinations,setWorkingRootDestinations]=useState<Record<string,string>>({});
  const [workingCopyMode,setWorkingCopyMode]=useState<''|'shared'|'separate_git'>('');
  const [nativeChoices,setNativeChoices]=useState<NativeImportChoices>({});

  const [engineMapping, setEngineMapping] = useState<Record<string, string>>({});
  useEffect(()=>{setRoleReview(undefined);},[packageBlob,conversationId,engineMapping]);
  const [acknowledgeElevatedPermissions, setAcknowledgeElevatedPermissions] = useState(false);
  const [instructionsAction, setInstructionsAction] = useState<ChatInstructionsAction>("");
  const sourceInstructions = packagePreview?.sourceProjectInstructions;
  const destinationInstructions = conversations.find(chat => chat.id === conversationId)?.instructions ?? "";
  const instructionsConflict = Boolean(sourceInstructions && destinationInstructions && sourceInstructions !== destinationInstructions);
  useEffect(() => { setInstructionsAction(""); importRequestId.current = createClientId(); }, [sourceInstructions, destinationInstructions, conversationId]);
  const [error, setError] = useState<string>();
  useEffect(()=>{setAccessReview(undefined);setAccessAction('');importRequestId.current=createClientId();},[packageBlob,projectId,conversationId,engineMapping,workingFilesDestination,workingCopyMode,instructionsAction,workingRootDestinations,activateWorkingFiles,confirmSharedRoot,nativeChoices]);
  const destinationAgentsQuery = useQuery<AgentDto[]>({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId),
    enabled: Boolean(packagePreview && conversationId),
  });
  const normalizeName = (value: string) => value.trim().normalize("NFKC").toLocaleLowerCase();
  const importedTitles = packagePreview?.agentTitles ?? [];
  const existingTitles = new Set((destinationAgentsQuery.data ?? [])
    .filter(agent => agentBelongsToConversation(agent, conversationId))
    .map(agent => normalizeName(agent.title)));
  const overlappingTitles = [...new Set(importedTitles.filter(title => existingTitles.has(normalizeName(title))))];
  const seenTitles = new Set<string>();
  const repeatedTitles = [...new Set(importedTitles.filter(title => {
    const key = normalizeName(title);
    if (seenTitles.has(key)) return true;
    seenTitles.add(key);
    return false;
  }))];
  const previewWorker = useRef<Worker>();
  const previewRequestId = useRef(0);
  const importRequestId = useRef(createClientId());
  const pendingRef = useRef(false);
  const savedIntentRef=useRef<PendingAgentImport>();
  const submittedBlobRef=useRef<{requestId:string;blob:Blob}>();
  const readSaved=useCallback(()=>{
    try{return {items:listPendingAgentImports(product)} as {items:PendingAgentImport[];error?:string};}
    catch{return {items:[],error:'Saved import information is unavailable. Preserve browser data and reload before starting another import.'};}
  },[product]);
  const [savedImports,setSavedImports]=useState(readSaved);
  const refreshSaved=useCallback(()=>setSavedImports(readSaved()),[readSaved]);
  useEffect(()=>{refreshSaved();const changed=()=>refreshSaved();window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[refreshSaved]);
  const acceptSaved=(entry:PendingAgentImport,operation:import('@ponderosa/core').AgentImportOperationDto)=>{
    if(!agentImportOperationMatches(operation,entry))throw Error('The import status does not match the saved request.');
    setOperationProjectId(entry.projectId);setLifecycleOperationId(operation.id);
    if(operation.result)setPartialResult(operation.result);
    // Keep the small request record while work is pending, so a reload can
    // reconnect and recover a final or partial result without submitting again.
    if(operation.status==='pending'){setRoleOperation(operation);return;}
    if(operation.status==='completed'){
      if(!operation.result)throw Error('Import completed without a result receipt. Its saved request is retained so you can check again.');
      setRoleOperation(undefined);setError(undefined);setCompletedImport(entry);setImportResult(operation.result);return;
    }
    // A failed import may include partial writes. Keep its identity across
    // reloads until the user has reviewed the result and explicitly dismisses it.
    setRoleOperation(undefined);setFailedImport(entry);setError(operation.error??'Import failed');
  };
  useEffect(()=>{
    if(!operationQuery.isError)return;
    // A lost owner or a transient read failure is never a successful import.
    // Return to the exact saved request so its scoped status can be checked.
    setRoleOperation(undefined);setError('Import status could not be read. Check the saved request before trying again.');refreshSaved();
  },[operationQuery.errorUpdatedAt]);
  useEffect(()=>{
    const current=operationQuery.data;if(!current)return;
    const saved=savedImports.items.find(entry=>entry.requestId===current.requestId&&entry.projectId===current.projectId);
    if(!saved||!agentImportOperationMatches(current,saved)){
      setRoleOperation(undefined);setError('The import status does not match its saved request.');return;
    }
    if(current.status==='pending'){setRoleOperation(current);if(current.result)setPartialResult(current.result);if(current.error)setError(current.error);return;}
    try{acceptSaved(saved,current);}
    catch(error){setRoleOperation(undefined);setError(error instanceof Error?error.message:'Import status could not be saved.');refreshSaved();}
  },[operationQuery.dataUpdatedAt]);

  const cancelInspection = useCallback(() => {
    previewWorker.current?.terminate();
    previewWorker.current = undefined;
    previewRequestId.current += 1;
  }, []);

  const clearPackageDraft = useCallback(() => {
    cancelInspection();
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setInspectionPhase(undefined);
    setFileName(undefined);
    setJsonText("");
    setWorkingFilesDestination('');setWorkingCopyMode('');setWorkingRootDestinations({});setNativeChoices({});setActivateWorkingFiles(false);setConfirmSharedRoot(false);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
    importRequestId.current = createClientId();
  }, [cancelInspection]);

  const closeForm = () => {
    if (pendingRef.current) return;
    clearPackageDraft();
    setConversationId("");
    onCancel();
  };

  useEffect(() => () => cancelInspection(), [cancelInspection]);

  useEffect(() => {
    setConversationId(current =>
      !createdChat && fixedConversationId && conversations.some(conversation => conversation.id === fixedConversationId)
        ? fixedConversationId
        : conversations.some(conversation => conversation.id === current)
        ? current
        : initialConversationId && conversations.some(conversation => conversation.id === initialConversationId)
          ? initialConversationId
          : requireDestinationSelection && conversations.length > 1
            ? ""
            : conversations[0]?.id ?? "",
    );
  }, [sourceConversations, createdChat, fixedConversationId, initialConversationId, requireDestinationSelection]);

  const invalidPermissionShape = packagePreview?.invalidPermissionShape ?? false;
  const elevatedAgents = invalidPermissionShape
    ? []
    : packagePreview?.elevatedAgentRefs ?? [];
  const sourceEngines = packagePreview?.sourceEngines ?? [];
  useEffect(() => {
    const automatic = soleAvailableEngineId(engines);
    if (!automatic || sourceEngines.length === 0) return;
    setEngineMapping(current => Object.fromEntries(sourceEngines.map(source => {
      const selected = engines.find(engine => engine.id === current[source]);
      return [source, selected && engineIsAvailable(selected) ? selected.id : automatic];
    })));
  }, [engines, sourceEngines.join("\0")]);
  const workingRoots=packagePreview?.workingRoots??[];
  const rootDestinations=Object.fromEntries(workingRoots.map(root=>[root.ref,workingRootDestinations[root.ref]?.trim()??'']));
  const validRootDestinations=validWorkingRootDestinations(workingRoots.map(root=>root.ref),rootDestinations);
  const activationAllowed=!activateWorkingFiles||Boolean(packagePreview?.mode==='full'&&packagePreview.hasWorkingFiles&&(createdChat?confirmSharedRoot&&createdChat.workingDirectory:workingCopyMode==='separate_git'));
  const workingFilesActivation=activateWorkingFiles?(createdChat?{sharedRoot:createdChat.workingDirectory}:{}):undefined;
  const importAgents = useMutation({
    mutationFn: async () => {
      setError(undefined);
      if(nativeImportChoiceError(nativeChoices,packagePreview?.nativeData))throw new Error(nativeImportChoiceError(nativeChoices,packagePreview?.nativeData));
      if(!validRootDestinations)throw new Error('Choose distinct, nonnested absolute folders for every working root.');
      if(!activationAllowed)throw new Error('Confirm the new managed working folder, or select Separate Git copy for an existing Git workspace.');
      const reviewedRequestId=importRequestId.current;
      if(!accessReview){const review=await api.previewAgentAccess(projectId,packageBlob!,{conversationId,engineMapping,...nativeChoices,...(workingFilesActivation?{workingFilesActivation}:{}),...(workingRoots.length?{workingRootDestinations:rootDestinations}:workingFilesDestination.trim()?{workingFilesDestination:workingFilesDestination.trim()}:{}),...(workingCopyMode?{workingCopyMode}:{})});if(importRequestId.current===reviewedRequestId)setAccessReview(review);return;}
      if(!accessAction)throw new Error('Choose which capability restrictions to use.');
      if(packagePreview?.hasOutputRoles&&!roleReview){const review=await api.previewAgentOutputRoles(projectId,packageBlob!,{conversationId,engineMapping});if(importRequestId.current===reviewedRequestId)setRoleReview(review);return;}
      const requestId=importRequestId.current,blob=packageBlob!;
      const metadata=JSON.parse(JSON.stringify({
        conversationId, engineMapping,...nativeChoices,
        ...(workingFilesActivation?{workingFilesActivation}:{}),
        accessSettingsResolution:{action:accessAction,reviewSha256:accessReview.reviewSha256},
        ...(workingRoots.length?{workingRootDestinations:rootDestinations}:workingFilesDestination.trim()?{workingFilesDestination:workingFilesDestination.trim()}:{}),
        ...(workingCopyMode?{workingCopyMode}:{}),
        ...(roleReview?{outputRoleReviewId:roleReview.id}:{}),
        chatInstructionsResolution: await chatInstructionsResolution(instructionsAction, destinationInstructions),
        ...(elevatedAgents.length > 0 ? { acknowledgeElevatedManagementPermissions: acknowledgeElevatedPermissions } : {}),
      })) as AgentImportMetadata;
      const body=new Blob([JSON.stringify(metadata)+'\n',blob],{type:'application/vnd.ponderosa.agent-import'});
      const fingerprint=await fingerprintAgentImport(body);
      if(requestId!==importRequestId.current)throw Error('Import settings changed. Review them again; no import was sent.');
      const entry:PendingAgentImport={version:1,requestId,projectId,conversationId,product,metadata,fingerprint};
      try{retainPendingAgentImport(entry);}catch{throw Error('Could not save the import request in this browser. No import was sent.');}
      savedIntentRef.current=entry;submittedBlobRef.current={requestId,blob};refreshSaved();
      const operation=await api.startAgentPackageImport(projectId,blob,metadata,requestId,agentImportFingerprintHeader(fingerprint));
      acceptSaved(entry,operation);
      return undefined;
    },
    onError: (reason) => {
      if(savedIntentRef.current){refreshSaved();setError('The original import is unconfirmed. Check its status or retry the exact same package.');return;}
      setAccessReview(undefined);setAccessAction('');importRequestId.current=createClientId();refreshSaved();setError(reason instanceof Error ? reason.message : "Import failed");
    },
    onSettled: () => {
      pendingRef.current = false;
      onPendingChange?.(false);
    },
  });
  const inspectPackage = useCallback((blob: Blob, sourceName?: string) => {
    cancelInspection();
    importRequestId.current = createClientId();
    if (blob.size > MAX_IMPORT_FILE_BYTES) {
      setPackageBlob(undefined);
      setPackagePreview(undefined);
      setInspecting(false);
      setInspectionPhase(undefined);
      setFileName(sourceName);
      setEngineMapping({});
      setAcknowledgeElevatedPermissions(false);
      setError(`This Agent package is larger than the ${AGENT_PACKAGE_LIMIT_LABEL} import limit.`);
      return;
    }
    const id = ++previewRequestId.current;
    const worker = new Worker(
      new URL("./agent-package-preview.worker.ts", import.meta.url),
      { type: "module" },
    );
    previewWorker.current = worker;
    worker.onmessage = (event: MessageEvent<{
      id: number;
      phase?: string;
      preview?: PortableAgentPreview;
      error?: string;
    }>) => {
      if (event.data.id !== previewRequestId.current) return;
      if (event.data.phase) {
        setInspectionPhase(event.data.phase);
        return;
      }
      setInspecting(false);
      setInspectionPhase(event.data.preview ? "Ready to import" : undefined);
      setPackagePreview(event.data.preview);
      setError(event.data.error);
      worker.terminate();
      if (previewWorker.current === worker) previewWorker.current = undefined;
    };
    worker.onerror = () => {
      if (id !== previewRequestId.current) return;
      setInspecting(false);
      setInspectionPhase(undefined);
      setPackagePreview(undefined);
      setError("Ponderosa could not inspect that package.");
      worker.terminate();
      if (previewWorker.current === worker) previewWorker.current = undefined;
    };
    setNativeChoices({});setPartialResult(undefined);
    setPackageBlob(blob);
    setPackagePreview(undefined);
    setInspecting(true);
    setInspectionPhase("Reading import");
    setFileName(sourceName);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
    worker.postMessage({ id, blob });
  }, [cancelInspection]);

  const loadFile = async (file: File) => {
    setJsonText("");
    inspectPackage(file, file.name);
  };

  useEffect(() => {
    if (!jsonText.trim()) return;
    const timer = window.setTimeout(() => {
      inspectPackage(
        new Blob([jsonText], { type: "application/json" }),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [inspectPackage, jsonText]);

  const updateJsonText = (value: string) => {
    cancelInspection();
    setNativeChoices({});
    setJsonText(value);
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setInspectionPhase(undefined);
    setFileName(undefined);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
  };

  const copyExternalPrompt = async () => {
    try {
      await copyText(externalAgentImportPrompt(new Date().toISOString()));
      notify({ key: "copy-import-prompt", message: "Copied" });
    } catch {
      notify({ key: "copy-import-prompt", message: "Could not copy the prompt. Check clipboard access and try again.", severity: "error" });
    }
  };

  if(importResult)return <Stack spacing={2}>{error&&<Alert severity="error">{error}</Alert>}<PostImportAccessReview result={importResult} projectId={operationProjectId??projectId} onDone={()=>{
    try{if(completedImport)releasePendingAgentImport(completedImport);}catch{setError('The import completed, but its saved record could not be updated. Keep browser data and try again.');return;}
    if(savedIntentRef.current?.requestId===completedImport?.requestId)savedIntentRef.current=undefined;
    setCompletedImport(undefined);setImportResult(undefined);clearPackageDraft();(onSubmitted??onCancel)();
  }}/></Stack>;
  if(failedImport)return <Stack spacing={2}>
    <Alert severity="warning">Partial files or changes may remain after the import stopped; review before dismissing, which does not remove or repeat changes.</Alert>
    {error&&<Alert severity="error">{error}</Alert>}
    {partialResult&&<NativeApplications result={partialResult}/>}
    {lifecycleOperationId&&<LifecycleReview key={lifecycleOperationId} kind="import" id={lifecycleOperationId}/>}
    <Button onClick={()=>{
      try{releasePendingAgentImport(failedImport);}catch{setError('The import result was found, but its saved record could not be updated. Keep browser data and try again.');return;}
      if(savedIntentRef.current?.requestId===failedImport.requestId)savedIntentRef.current=undefined;
      setFailedImport(undefined);setPartialResult(undefined);setLifecycleOperationId(undefined);setError(undefined);
      importRequestId.current=createClientId();refreshSaved();clearPackageDraft();
    }}>Finish reviewing</Button>
    <Button onClick={closeForm}>Close</Button>
  </Stack>;
  if(savedImports.error)return <Stack spacing={2}><Alert severity="error">{savedImports.error}</Alert><Button onClick={closeForm}>Close</Button></Stack>;
  const dismissSavedNotice=(entry:PendingAgentImport)=>{
    releasePendingAgentImport(entry);
    if(savedIntentRef.current?.requestId===entry.requestId)savedIntentRef.current=undefined;
    importRequestId.current=createClientId();setError(undefined);refreshSaved();clearPackageDraft();
  };
  const untrackedImports=savedImports.items.filter(entry=>!roleOperation||!agentImportOperationMatches(roleOperation,entry));
  if(untrackedImports.length)return <Stack spacing={2}>
    {untrackedImports.map(entry=><PendingAgentImportRecovery key={entry.requestId} entry={entry} initialBlob={submittedBlobRef.current?.requestId===entry.requestId?submittedBlobRef.current.blob:undefined} disabled={importAgents.isPending} onAccepted={acceptSaved} onRetired={dismissSavedNotice} onDeleted={dismissSavedNotice}/>)}
    <Button disabled={pendingRef.current} onClick={closeForm}>Close</Button>
  </Stack>;
  return <Stack spacing={2}>
    {roleOperation&&<Alert severity="info" role="status">Import in progress; you can close this view and check later.</Alert>}
    {partialResult&&<NativeApplications result={partialResult}/>}
    {lifecycleOperationId&&<LifecycleReview key={lifecycleOperationId} kind="import" id={lifecycleOperationId}/>}
      <Alert severity="info">History stays private; credentials are excluded.</Alert>
      <Paper component="section" variant="outlined" aria-label="Import an external AI chat" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }} justifyContent="space-between">
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">Import a Codex or Claude chat</Typography>
            <Typography variant="body2" color="text.secondary">
              Give prompt to Agent → paste or upload resulting JSON
            </Typography>
          </Stack>
          <Button size="small" variant="outlined" startIcon={<ContentCopyOutlinedIcon />} onClick={() => void copyExternalPrompt()} sx={{ flexShrink: 0 }}>
            Copy conversion prompt
          </Button>
        </Stack>
      </Paper>
      <Typography variant="body2" color="text.secondary">Agent and organization packages: up to {AGENT_PACKAGE_LIMIT_LABEL}, with up to {AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL} embedded artifacts · large imports: choose file</Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
        <Button component="label" variant="outlined" startIcon={<UploadFileOutlinedIcon />}>
          Choose JSON File
          <input hidden type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void loadFile(file);
          }} />
        </Button>
        {fileName && packageBlob && !jsonText ? <Paper
          role="group"
          aria-label="Selected JSON package"
          variant="outlined"
          sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5, minWidth: 0, maxWidth: "100%", flex: 1 }}
        >
          <InsertDriveFileOutlinedIcon fontSize="small" color="action" />
          <Stack sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap>{fileName}</Typography>
            <Typography variant="caption" color="text.secondary" aria-live="polite">
              {packageBlob.size >= 1_000_000
                ? `${(packageBlob.size / 1_000_000).toFixed(1)} MB`
                : `${Math.ceil(packageBlob.size / 1_000)} KB`}
              {" · "}
              {inspecting ? inspectionPhase ?? "Inspecting" : packagePreview ? "Ready to import" : error ? "Could not inspect" : "Selected"}
            </Typography>
          </Stack>
          <Button size="small" color="inherit" onClick={clearPackageDraft}>Remove</Button>
        </Paper> : <>
          <Typography variant="body2" color="text.secondary">{fileName ?? "No file selected"}</Typography>
          {fileName && !jsonText ? <Button size="small" color="inherit" onClick={clearPackageDraft}>Clear</Button> : null}
        </>}
      </Stack>
      <TextField
        label="Or paste Agent JSON"
        placeholder="Paste exported JSON here"
        value={jsonText}
        onPasteCapture={(event) => {
          const field = event.target;
          if (!(field instanceof HTMLTextAreaElement)) return;
          const pasted = event.clipboardData?.getData("text/plain");
          if (!pasted) return;
          const before = field.value.slice(0, field.selectionStart);
          const after = field.value.slice(field.selectionEnd);
          const nextLength = before.length + pasted.length + after.length;
          if (nextLength < LARGE_PASTE_CHARACTERS) return;
          event.preventDefault();
          setJsonText("");
          const blob = new Blob([before, pasted, after], { type: "application/json" });
          inspectPackage(blob, "pasted-agent-package.json");
        }}
        onChange={(event) => updateJsonText(event.target.value)}
        multiline
        minRows={3}
        maxRows={8}
        fullWidth
      />
      {inspecting && !fileName ? <Alert severity="info">{inspectionPhase ?? "Inspecting package off the main thread…"}</Alert> : null}
      {packagePreview ? <Alert severity="success">
        <Typography variant="body2">
          {packagePreview.agentCount} Agent{packagePreview.agentCount === 1 ? "" : "s"} · {packagePreview.mode === "template" ? "template" : "full"} · {packagePreview.artifactCount} artifact{packagePreview.artifactCount === 1 ? "" : "s"} · {packagePreview.historyMessageCount} history message{packagePreview.historyMessageCount === 1 ? "" : "s"}
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          Will import: {packagePreview.kind === "organization" ? "the Agent and its included descendants" : "one Agent"}, setup{packagePreview.mode === "full" ? ", private history, managed artifacts, and source Chat instructions when present" : " only"}.
        </Typography>
        <Typography variant="body2">Will not import: credentials.</Typography>
        <Typography variant="caption" color="text.secondary">{packagePreview.sourceLabel}</Typography>
      </Alert> : !inspecting && !error ? <Typography variant="body2" color="text.secondary">
        Choose or paste Agent / organization package
      </Typography> : null}
      {!fixedConversationId&&!createdChat&&<Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
        <Typography variant="subtitle1">Import into a new Chat and workspace</Typography>
        <Typography variant="body2">Create new empty managed folder · retained if import canceled</Typography>
        <TextField disabled={createDestination.isPending||Boolean(creationAttempt)} label="New Chat name" value={newChatLabel} onChange={event=>{setNewChatLabel(event.target.value);createChatRequestId.current=createClientId();}}/>
        <TextField disabled={createDestination.isPending||Boolean(creationAttempt)} label="New managed folder name" value={newFolderName} onChange={event=>{setNewFolderName(event.target.value);createChatRequestId.current=createClientId();}}/>
        <TextField select disabled={createDestination.isPending||Boolean(creationAttempt)} label="New Chat engine" value={newChatEngine} onChange={event=>{setNewChatEngine(event.target.value);createChatRequestId.current=createClientId();}}>{engines.map(engine=><MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}</MenuItem>)}</TextField>
        <Button disabled={createDestination.isPending||importAgents.isPending||Boolean(roleOperation)||!newChatLabel.trim()||!newFolderName.trim()||!newChatEngine} onClick={()=>{if(pendingRef.current)return;pendingRef.current=true;onPendingChange?.(true);createDestination.mutate();}}>{creationAttempt?"Retry destination creation":"Create new destination"}</Button>
      </Stack></Paper>}
      {createdChat&&<Alert severity="info">New destination created: {createdChat.title} · {createdChat.workingDirectory} · Chat/workspace retained if import canceled</Alert>}
      {conversations.length === 0 ? <Alert severity="warning">No destination Chats · create above or choose another workspace</Alert> : fixedConversationId || conversations.length === 1 ? <Typography variant="body2" color="text.secondary">
        Destination chat: {conversations.find(conversation => conversation.id === fixedConversationId)?.title ?? conversations[0]!.title}
      </Typography> : <FormControl fullWidth>
        <InputLabel id="import-chat-label">Destination chat</InputLabel>
        <Select labelId="import-chat-label" label="Destination chat" value={conversationId} disabled={Boolean(creationAttempt)||createDestination.isPending} onChange={(event: SelectChangeEvent) => {importRequestId.current=createClientId();setConversationId(event.target.value);}}>
          {conversations.map((conversation) => <MenuItem key={conversation.id} value={conversation.id}>{conversation.title}</MenuItem>)}
        </Select>
      </FormControl>}
      {workingRoots.length>0?<><Typography>Recovery · one new folder per shared source root · live population: explicit activation required</Typography>{workingRoots.map(root=><TextField key={root.ref} label={`New folder: ${root.agents.join(', ')}`} value={workingRootDestinations[root.ref]??''} onChange={event=>{importRequestId.current=createClientId();setWorkingRootDestinations(current=>({...current,[root.ref]:event.target.value}));}} helperText="New absolute host path; distinct from and outside every other destination."/>)}</>:<TextField label="New folder for included working files" value={workingFilesDestination} onChange={event=>{setWorkingFilesDestination(event.target.value);importRequestId.current=createClientId();}} helperText="Included files: new absolute host folder · no existing-folder overwrite"/>}
      <TextField select label="Working folder mode" value={workingCopyMode} onChange={event=>{setWorkingCopyMode(event.target.value as typeof workingCopyMode);importRequestId.current=createClientId();}}><MenuItem value="">Keep source mode</MenuItem><MenuItem value="shared">Shared folder</MenuItem><MenuItem value="separate_git">Separate Git copy</MenuItem></TextField>
      <FormControlLabel control={<Checkbox checked={activateWorkingFiles} disabled={packagePreview?.mode!=='full'||!packagePreview.hasWorkingFiles||importAgents.isPending||Boolean(roleOperation)} onChange={event=>{importRequestId.current=createClientId();setActivateWorkingFiles(event.target.checked);}}/>} label="Use restored files in live Agent working folders"/>
      {activateWorkingFiles&&(createdChat?<FormControlLabel control={<Checkbox checked={confirmSharedRoot} onChange={event=>{importRequestId.current=createClientId();setConfirmSharedRoot(event.target.checked);}}/>} label={`Confirm new workspace folder: ${createdChat.workingDirectory??'unavailable'}`}/>:<Alert severity="info"><Stack spacing={0.5}><Typography>Existing workspace · Separate Git copy only · existing Git repository required</Typography><Typography>Shared activation · new managed destination required</Typography></Stack></Alert>)}
      {activateWorkingFiles&&<Stack spacing={0.5}><Typography>Recovery folders · required + separate from live folder · retained on failure</Typography><Typography>Credentials and source runtime ownership remain excluded</Typography><Typography>Root membership · server validation required</Typography></Stack>}
      <NativePortableImportChoices summary={packagePreview?.nativeData} value={nativeChoices} onChange={value=>{importRequestId.current=createClientId();setNativeChoices(value);}} disabled={importAgents.isPending||Boolean(roleOperation)} destinations={rootDestinations}/>
      <ChatInstructionsImportChoice source={sourceInstructions} destination={destinationInstructions}
        value={instructionsAction} onChange={value => { setInstructionsAction(value); importRequestId.current = createClientId(); }} />
      {packagePreview && repeatedTitles.length ? <Alert severity="warning">
        Repeated within this package: {repeatedTitles.slice(0, 5).join(", ")}{repeatedTitles.length > 5 ? ` and ${repeatedTitles.length - 5} more` : ""} · creates separate Agents with identical names
      </Alert> : null}
      {packagePreview && conversationId ? (
        destinationAgentsQuery.isFetching ? <Typography role="status" variant="body2" color="text.secondary">Checking names in the destination chat…</Typography>
          : destinationAgentsQuery.isError ? <Alert severity="warning">Agent name check unavailable · import creates new Agents without replacing existing Agents</Alert>
          : overlappingTitles.length ? <Alert severity="warning">
            {overlappingTitles.length ? <Typography variant="body2">Already in this chat: {overlappingTitles.slice(0, 5).join(", ")}{overlappingTitles.length > 5 ? ` and ${overlappingTitles.length - 5} more` : ""}.</Typography> : null}
            <Typography variant="body2">Import creates separate Agents; it will not overwrite existing ones.</Typography>
          </Alert> : <Typography variant="body2" color="text.secondary">No matching Agent names in the destination chat.</Typography>
      ) : null}
      {sourceEngines.map((source) => {
        const label = sourceEngines.length === 1
          ? "Default Engine"
          : `Engine for ${source}`;
        return <FormControl key={source} fullWidth>
          <InputLabel id={`engine-map-${source}`}>{label}</InputLabel>
          <Select labelId={`engine-map-${source}`} label={label} value={engineMapping[source] ?? ""} onChange={(event: SelectChangeEvent) => {importRequestId.current=createClientId();setEngineMapping((current) => ({ ...current, [source]: event.target.value }));}}>
            {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}{engineIsAvailable(engine) ? "" : ` — ${engineUnavailableReason(engine)}`}</MenuItem>)}
          </Select>
        </FormControl>;
      })}
      {invalidPermissionShape ? <Alert severity="error">
        Invalid management permissions · both values must be true/false
      </Alert> : null}
      {elevatedAgents.length > 0 ? <Alert severity="warning">
        <Typography variant="body2" sx={{ mb: 1 }}>
          {elevatedAgents.length} imported Agent{elevatedAgents.length === 1 ? "" : "s"} will be allowed to autonomously delete descendants or rearrange their organization.
        </Typography>
        <FormControlLabel
          control={<Checkbox checked={acknowledgeElevatedPermissions} onChange={(event) => {importRequestId.current=createClientId();setAcknowledgeElevatedPermissions(event.target.checked);}} />}
          label="Import these elevated management permissions"
        />
      </Alert> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {accessReview&&<Paper variant="outlined" sx={{p:2}}><Typography component="h3" variant="subtitle1">Capability restrictions</Typography>
        {accessReview.source.map(item=><Typography key={item.ref} variant="body2" sx={{overflowWrap:"anywhere"}}>{sourceAgentNames.get(item.ref)??`Imported Agent (${item.ref})`}: {item.settings?.restrictedCapabilityIds?.join(', ')||'No source restrictions'}</Typography>)}
        <Typography variant="body2" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>Current destination policy: {accessReview.destination.restrictedCapabilityIds.join(', ')||'No capability restrictions'}</Typography>
        <TextField select fullWidth label="Restrictions for imported Agents" value={accessAction} onChange={event=>{setAccessAction(event.target.value as typeof accessAction);importRequestId.current=createClientId();}} sx={{mt:1}}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions to new Agents</MenuItem></TextField>
        <Typography variant="body2">Memory and saved-browser access require separate choices in Settings.</Typography>
      </Paper>}
      {roleReview?.warning&&<Alert severity="warning">{roleReview.warning}</Alert>}
      <Stack direction="row" spacing={1} sx={{
        flexWrap:"wrap",gap:1,
        justifyContent: "flex-end",
        ...(stickyActions ? {
          position: "absolute",
          zIndex: 2,
          bottom: 0,
          left: 0,
          right: 0,
          px: { xs: 2, sm: 3 },
          py: 1.5,
          bgcolor: "background.paper",
          borderTop: 1,
          borderColor: "divider",
        } : {}),
      }}>
      {roleOperation?.outputRoleRecoveryId&&<><Button onClick={async()=>{try{const result=await api.recoverAgentOutputRoles(operationProjectId??projectId,roleOperation.outputRoleRecoveryId!);if('id'in result)setRecoveryReview(result);void operationQuery.refetch();}catch(cause){setError((cause as Error).message);}}}>Review output roles again</Button>{recoveryReview&&<><Alert severity="warning">{recoveryReview.warning??'Apply the reviewed output roles.'}</Alert><Button onClick={async()=>{try{await api.recoverAgentOutputRoles(operationProjectId??projectId,roleOperation.outputRoleRecoveryId!,recoveryReview.id);setRecoveryReview(undefined);void operationQuery.refetch();}catch(cause){setError((cause as Error).message);}}}>Confirm output roles</Button></>}</>}

      <Button disabled={createDestination.isPending||importAgents.isPending} onClick={closeForm}>Cancel</Button>
      <Button variant="contained" disabled={Boolean(nativeImportChoiceError(nativeChoices,packagePreview?.nativeData))||!activationAllowed||createDestination.isPending||!validRootDestinations||Boolean(accessReview&&!accessAction)||Boolean(roleOperation)||!packageBlob || !packagePreview || inspecting || destinationAgentsQuery.isFetching || (instructionsConflict && !instructionsAction) || invalidPermissionShape || !conversationId || sourceEngines.some((source) => {
        const target = engines.find(engine => engine.id === engineMapping[source]);
        return !engineIsAvailable(target);
      }) || (elevatedAgents.length > 0 && !acknowledgeElevatedPermissions) || importAgents.isPending} onClick={() => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        onPendingChange?.(true);
        importAgents.mutate();
      }}>
        {importAgents.isPending ? "Importing…" : !accessReview ? "Review access settings" : packagePreview?.hasOutputRoles&&!roleReview ? "Review output roles" : "Import"}
      </Button>
      </Stack>
  </Stack>;
}

export function ImportAgentDialog({
  open,
  projectId,
  projects = [],
  initialProjectId,
  engines,
  conversations,
  initialConversationId,
  onClose,
}: {
  open: boolean;
  projectId?: string;
  projects?: ProjectDto[];
  initialProjectId?: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onClose(): void;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? "");
  useEffect(() => {
    if (open && !projectId) setSelectedProjectId(initialProjectId ?? "");
  }, [open, projectId, initialProjectId]);
  const destinationProjectId = projectId ?? selectedProjectId;
  const destinationConversations = useQuery({
    queryKey: queryKeys.conversations.project(destinationProjectId),
    queryFn: () => api.listConversations(destinationProjectId),
    enabled: open && !projectId && Boolean(destinationProjectId),
  });
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const openRef = useRef(false);
  if (open && !openRef.current) generationRef.current += 1;
  openRef.current = open;
  const generation = generationRef.current;
  useEffect(() => () => {
    generationRef.current += 1;
    openRef.current = false;
  }, []);
  const updatePending = (nextPending: boolean) => {
    pendingRef.current = nextPending;
    setPending(nextPending);
  };
  const close = () => {
    if (!pendingRef.current) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      disableEscapeKeyDown={pending}
      fullWidth
      maxWidth="md"
      slotProps={{ paper: { "aria-busy": pending || undefined } }}
    >
      <DialogTitle>Import Agent package</DialogTitle>
      <DialogContent sx={{ pt: "12px !important" }}>
        {!projectId ? (
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel id="import-package-project-label">Destination workspace</InputLabel>
            <Select
              labelId="import-package-project-label"
              label="Destination workspace"
              value={selectedProjectId}
              disabled={pending}
              onChange={event => setSelectedProjectId(event.target.value)}
            >
              {projects.map(project => (
                <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        {!projectId && destinationConversations.isPending && destinationProjectId ? (
          <Typography variant="body2" color="text.secondary">Loading destination chats…</Typography>
        ) : null}
        {!projectId && destinationConversations.isError ? (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void destinationConversations.refetch()}>Retry</Button>}>Could not load destination chats.</Alert>
        ) : null}
        {!destinationProjectId ? (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">Choose the workspace that owns the destination chat.</Typography>
            <Button onClick={close} sx={{ alignSelf: "flex-end" }}>Cancel</Button>
          </Stack>
        ) : null}
        {open && destinationProjectId && (projectId || destinationConversations.isSuccess) ? (
          <ImportAgentForm
            key={destinationProjectId}
            projectId={destinationProjectId}
            engines={engines}
            conversations={projectId ? conversations : destinationConversations.data?.filter(chat => !chat.deletedAt) ?? []}
            initialConversationId={projectId ? initialConversationId : undefined}
            requireDestinationSelection={!projectId}
            onCancel={close}
            onPendingChange={nextPending => {
              if (
                openRef.current &&
                generationRef.current === generation
              ) updatePending(nextPending);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
