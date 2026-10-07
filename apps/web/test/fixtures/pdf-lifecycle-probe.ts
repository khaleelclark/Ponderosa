// Qualification-only wrapper: real PDF.js parsing and painting, with explicit
// gates at asynchronous boundaries. Never included in the application build.
import { getDocument as load, GlobalWorkerOptions } from "@qualification-real-pdfjs";
export { GlobalWorkerOptions };

const probe = (window as any).pdfLifecycle = {
  mode: "normal", renders: 0, cancelled: 0, activeRenders: 0, destroyed: 0,
  activeDocuments: 0, textReaders: 0, textCancelled: 0, delayedPages: [] as Array<() => void>,
  delayPage: 0, delayDocument: false, delayedDocuments: [] as Array<() => void>, options: [] as unknown[],
  releasePages() { this.delayedPages.splice(0).forEach(release => release()); },
  releaseDocuments() { this.delayedDocuments.splice(0).forEach(release => release()); },
};
export function getDocument(options: any): any {
  probe.options.push({ enableXfa: options.enableXfa, maxImageSize: options.maxImageSize,
    stopAtErrors: options.stopAtErrors, useWasm: options.useWasm });
  const task = load(options); probe.activeDocuments++;
  let destroyed = false;
  return {
    promise: task.promise.then(async (pdf: any) => {
      if (probe.delayDocument) await new Promise<void>(resolve => probe.delayedDocuments.push(resolve));
      return { numPages: pdf.numPages, async getPage(number: number) {
      const page = await pdf.getPage(number);
      if (probe.delayPage === number) await new Promise<void>(resolve => probe.delayedPages.push(resolve));
      return { getViewport: page.getViewport.bind(page), render(options: any) {
        probe.renders++; probe.activeRenders++;
        const render = page.render(options), mode = probe.mode;
        let rejectGate: (error: Error) => void = () => {};
        const gate = mode === "stall" ? new Promise<void>((_resolve, reject) => { rejectGate = reject; }) : undefined;
        // A cancellation may precede PDF.js finishing its own render.
        void gate?.catch(() => {});
        const promise = render.promise.then(() => {
          if (mode === "fail") throw Error("Disposable render failure");
          return mode === "stall" ? gate : undefined;
        }).finally(() => { probe.activeRenders--; });
        return { promise, cancel() {
          probe.cancelled++; render.cancel();
          const error = new Error("Qualification render cancelled"); error.name = "RenderingCancelledException";
          rejectGate(error);
        } };
      }, streamTextContent() {
        if (probe.mode !== "text-stall") return page.streamTextContent();
        probe.textReaders++;
        return new ReadableStream({ cancel() { probe.textReaders--; probe.textCancelled++; } });
      } };
    } }; }),
    destroy() {
      if (!destroyed) { destroyed = true; probe.destroyed++; probe.activeDocuments--; }
      return task.destroy();
    },
  };
}
