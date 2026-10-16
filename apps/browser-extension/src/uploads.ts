type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const references = new Map<string, { pageId: string; objectId: string }>();
const MAX_BYTES = 10 * 1024 * 1024;

/** Fixed browser operations only; file bytes come from an authorized managed artifact. */
export async function upload(send: Send, pageId: string, args: Record<string, unknown>): Promise<unknown> {
  const { name, type, size, base64, uploadId, selector } = args;
  if (typeof uploadId !== "string" || uploadId.length > 100 || typeof name !== "string" || !name || name.length > 240 || /[\\/\x00-\x1f]/.test(name)
    || typeof type !== "string" || !["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"].includes(type)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES
    || typeof base64 !== "string" || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    || (selector !== undefined && (typeof selector !== "string" || !selector || selector.length > 2000))) throw new Error("Invalid managed upload");
  if (atob(base64).length !== size) throw new Error("Upload size mismatch");
  const selected = await send("Runtime.evaluate", {
    expression: `(() => { const selector=${JSON.stringify(selector ?? null)}; const nodes=selector ? document.querySelectorAll(selector) : document.querySelectorAll('input[type="file"]'); if(nodes.length!==1) throw new Error('Choose one file input'); return nodes[0]; })()`,
    returnByValue: false,
  });
  const objectId = (selected.result as { objectId?: string } | undefined)?.objectId;
  if (selected.exceptionDetails || !objectId) throw new Error("Choose one file input using its selector");
  references.set(uploadId, { pageId, objectId });
  const result = await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(name,type,size,base64) {
      if(!(this instanceof HTMLInputElement) || this.type!=='file' || this.disabled || this.multiple || !this.isConnected) throw new Error('Unsupported file input');
      const extension='.'+name.split('.').pop().toLowerCase();
      if(this.accept && !this.accept.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).some(x=>x.startsWith('.') ? x===extension : x.endsWith('/*') ? type.startsWith(x.slice(0,-1)) : x===type)) throw new Error('File type not accepted');
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      if(bytes.length!==size) throw new Error('Size mismatch');
      const transfer=new DataTransfer(); transfer.items.add(new File([bytes],name,{type})); this.files=transfer.files;
      this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
      const file=this.files?.[0];
      return {name:file?.name,size:file?.size,type:file?.type,count:this.files?.length};
    }`,
    arguments: [name, type, size, base64].map(value => ({ value })), returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("File attachment failed");
  return (result.result as { value?: unknown } | undefined)?.value;
}

export async function clearUploads(send: Send, pageId: string, uploadId?: string): Promise<void> {
  for (const [id, reference] of references) {
    if (reference.pageId !== pageId || (uploadId !== undefined && uploadId !== id)) continue;
    try {
      const result = await send("Runtime.callFunctionOn", { objectId: reference.objectId, functionDeclaration: "function(){ if(this instanceof HTMLInputElement && this.type==='file') this.value=''; }", returnByValue: true });
      if (result.exceptionDetails) throw new Error("File cleanup failed");
    } catch (error) {
      if (!(error instanceof Error) || !/Cannot find context|Cannot find object|Could not find object|Execution context was destroyed/.test(error.message)) throw error;
    }
    references.delete(id);
  }
}
