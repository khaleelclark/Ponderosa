import { projectBrowserAdapter, agentBrowserAdapter } from '../src/components/browser/browserAdapters';
import { productApiPath } from '../src/api/productScope';
import { createBrowserBinaryFrameParser, parseBrowserFrameEvent } from '../src/browserInteraction';

(window as any).streamProbe = { projectBrowserAdapter, agentBrowserAdapter, productApiPath,
  createBrowserBinaryFrameParser, parseBrowserFrameEvent };
