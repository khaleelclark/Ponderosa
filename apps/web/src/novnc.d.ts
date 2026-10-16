declare module "@novnc/novnc/lib/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    qualityLevel: number;
    compressionLevel: number;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    disconnect(): void;
  }
}
