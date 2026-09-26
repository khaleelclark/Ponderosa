# Ponderosa Local Browser — experimental window connection (0.4.1)

Connect one explicitly chosen Chrome/Edge desktop window to a Ponderosa Chat.
Existing and subsequently added HTTPS application tabs in that window are included.
Use a dedicated window containing only the work you want Ponderosa to access.
Other windows are outside the grant. This is an unpacked extension, not a store release.

## Install and connect

1. Keep the extracted extension folder somewhere permanent. Open
   `chrome://extensions` or `edge://extensions`, enable Developer mode, then
   **Load unpacked** and select the folder containing `manifest.json`.
   For an upgrade, disconnect the old extension and replace it with this version.
   Chrome may ask you to approve the added tabs permission.
2. In Ponderosa's Browser choose **… → Connect local browser** and create a code.
   The private code expires after five minutes; a connected window has no fixed
   five-minute lifetime.
3. Open a dedicated normal browser window. Connect before or after signing in,
   even on a sign-in/new-tab page. Leave unrelated personal tabs in another window.
4. From that window, open the extension. Enter the Ponderosa
   HTTPS origin and pairing code, confirm the window-wide grant, and choose
   **Connect this window**. Approve server-hostname access if requested.
5. Back in Ponderosa select the connected window. Use the normal tab strip to
   view, switch, create, and close tabs. Give a running Agent control using the
   existing Browser options when ready.

## Boundaries

- One connected window, up to 50 HTTPS application tabs. Blank tabs created by
  Ponderosa are supported; Chrome/Edge settings/new-tab pages are not automated.
- The extension uses the tabs permission to enumerate the selected window and
  debugger permission to interact with its tabs. No arbitrary remote JavaScript
  or CDP commands are accepted. Credentials, cookies and profiles are not copied.
- New tabs inside the connected window are included. Popup windows are **not**
  automatically included. Moving a tab out removes access. Closing the window
  ends the connection. Watching another tab does not change the Agent's work target.
- **Pause for manual control** detaches all controlled tabs but keeps the pairing.
  Known sign-in URLs or encountered password/OTP forms automatically pause access.
  Finish signing in directly in Chrome/Edge, then explicitly choose **Resume browser
  access** in the extension. No new code is needed. Paused commands and screenshots
  are blocked, and interrupted commands are never replayed. **Disconnect window**
  ends the pairing without closing tabs. Network failures and browser/server
  restarts still require a new pairing; these are distinct from an authentication pause.
- Agents can attach authorized chat artifacts (PDF, DOCX, or text, up to 10 MiB)
  to a selected file input. Bytes are transferred in memory; no access to arbitrary
  local paths is granted. With multiple file inputs, supply an explicit selector.
  Embedded cross-origin frame upload controls are not supported yet. Attachment
  verification confirms the file input, not a successful final site submission.
  Downloads remain manual. Resizing Ponderosa does not resize Chrome.
- A short-lived, non-interactive Agent cursor marks click, fill, typing, and
  scroll actions in the connected tab. It is hidden from Agent inspection and
  screenshots and cleared when browser control pauses or disconnects. Agent
  tools issue discrete actions, so the cursor marks action targets rather than
  pretending to track continuous mouse motion.
- Google/iCIMS compatibility is not guaranteed. This does not bypass CAPTCHA or
  authentication restrictions. Manual Chrome/Edge consent and real sign-in testing
  remain user qualification.

Build: `pnpm --filter @ponderosa/browser-extension build`. Load `dist`, not `src`.
Tests: `pnpm --filter @ponderosa/browser-extension test:built`; set
`PONDEROSA_PLAYWRIGHT_PATH` and `PONDEROSA_CHROMIUM_PATH` for the real DOM/input
check. `test/extension-load.check.mjs` additionally loads the actual MV3 package
using `PONDEROSA_EXTENSION_CHROMIUM_PATH` (extension-capable Chromium).
