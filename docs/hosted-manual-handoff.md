# Hosted manual handoff: implementation checkpoint

Experimental only. No development/production promotion is authorized.

## Evidence

- Baseline deployment: `70d0768b6e63eeac268d501034a78fd53cb6f474`.
- User successfully signed into Google in ordinary Chrome 152 on Pine through an isolated Xvfb/noVNC test, with no automation connection at launch.
- After the user enabled Chrome's supported remote-debugging approval flow, a test attached to that same Chrome process, created a new blank tab, inserted and verified fixture text, then detached. Existing signed-in pages were not inspected. No browser restart or cookie transfer occurred.
- This proves a same-process manual-to-automation handoff. It does not prove iCIMS OAuth, continuing authenticated employer workflows, repeated takeover cycles, or Google acceptance while automation is attached.

## Implemented foundation

`ApprovedChromeConnection` connects only to Chrome's loopback endpoint published inside a caller-owned, already leased profile. It supports bounded approval, cancellation, protocol events, and disconnect. Disconnect discards pending commands and does not issue `Browser.close`. Endpoint capabilities and raw Chrome errors are not surfaced in failure messages. The existing driver now accepts the common protocol interface.

Control ownership changes no longer clear attached files or their staging. Navigation/session teardown retain their existing cleanup responsibilities. A regression proves both handoff directions preserve an attached draft file and teardown removes staging.

The internal native-manual driver now launches ordinary Chrome with an isolated Xvfb display and x11vnc listening only on a private Unix socket (no VNC TCP listener). All three processes share the existing published termination authority. Missing native display dependencies fail visibly. Manual actions are not routed through CDP, and automation methods reject while manual control is active.

The session manager supports explicit pause/resume, fences stale automation and desktop access, requires operator ownership for Resume, and disallows destructive reconnect for native-manual sessions. Reattachment uses the existing Chrome process; a failed approval leaves it running in manual mode.

Qualification added: a real Chrome/Xvfb/x11vnc check verifies the Unix socket's RFB handshake and permissions, rejected automation, failed resume preserving the process, and confirmed cleanup of every process. A manager regression verifies explicit resume, stale epoch rejection, agent-control exclusion, and no browser replacement. Run the native check with `PONDEROSA_TEST_NATIVE_BROWSER=1` on a host with Chrome, Xvfb and x11vnc installed.

The application now offers **Open hosted sign-in browser** for an empty shared browser session. The native view is delivered through the application origin using noVNC and a single-use, 30-second connection capability issued only through operator-authenticated routes. The capability binds the exact session, control epoch and origin; live input and display access are revoked when those change. Neither desktop paths nor CDP endpoints reach the client. VNC traffic is not logged or retained. The existing WebSocket dependency carries the desktop stream; noVNC 1.5.0 is the narrowly scoped client dependency (the 1.6.0 published CommonJS artifact failed the production build).

**Resume automation** waits for Chrome's own connection approval. **Sign in / take over manually** detaches automation without ending Chrome. Closing the panel leaves the browser running; **End browser session** terminates it. The manual view has Fit/Actual size controls. This does not prove physical mobile keyboard/touch support or OAuth success on employer sites.

## Using the experimental flow

1. End an existing hosted browser explicitly before selecting **Open hosted sign-in browser**. This creates a new browser; it does not import the temporary SSH/noVNC probe's signed-in profile.
2. Sign in directly in the native Chrome view. The agent is paused and cannot inspect or type in this mode.
3. Enable Chrome's supported remote debugging option at `chrome://inspect/#remote-debugging`, then click **Resume automation** in Ponderosa and approve Chrome's prompt. No browser restart or cookie transfer is involved.
4. In the browser menu, use **Allow [agent] next run** before sending the retry message. This one-use authorization binds when that agent's next run starts and is consumed by its browser tool; it cannot transfer to another agent, run or conversation. It expires when that run ends, even if unused. **Cancel next-run access** revokes it before use. Running agents still have the immediate **Give control** option. Use **Sign in / take over manually** whenever another private sign-in is needed.

Both browser views now have a **Keyboard** button backed by a real editable control so mobile browsers can open their system keyboard. Native Unicode and backspace delivery are exercised against Chrome; physical iOS/Android keyboards still need user qualification. Automated view capture uses 2x device pixels while pointer coordinates stay in CSS pixels. Native Chrome now uses a 2560×1440 display with 2x UI density; its desktop transport requests maximum image quality and retains Actual size for avoiding fit-mode downscaling.

Real browser qualification covers direct native typing/navigation, the authenticated desktop path, failed resume preserving the open form, cancellation fencing, and desktop/mobile-width layout. The prior one-off Google success is not proof of this complete product flow. A fresh user Google/iCIMS sign-in and approved Resume test is still required.

## Remaining qualification checklist

1. Repeat real Google and iCIMS sign-in, Chrome approval and agent continuation with the user; no CAPTCHA bypass or hidden approval is implemented.
2. Qualify process crashes and repeated takeover cycles with retained draft attachments. Do not claim restart recovery preserves unsaved forms.
3. Complete the 30-tab admission work and qualify ten open drafts before endorsing the full application workflow. Native resume currently refuses over-capacity sessions instead of deleting existing tabs.

## Other confirmed workflow gaps

- Hosted tab cap is still eight; local cap is fifty. Target is thirty, with explicit capacity handling rather than silently closing unexpected popups.
- UI new-tab exists; the agent tool contract still lacks an explicit new-tab operation and coordinate/scroll actions.
- Manual input has an ordered queue. The old silent-drop finding is stale, but slow-link/failure qualification remains necessary.
- Playwright navigation waits for DOM readiness; the fallback CDP path still has a fixed delay.
- Site-retained field values, embedded-frame targeting, and site-accepted upload/draft verification remain incomplete.
