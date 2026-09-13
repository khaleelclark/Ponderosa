# iOS composer follow-up

The operator reported continued focus displacement in Safari and installed PWA
on iPhone 17, plus toolbar wrapping with reply/model/dictation controls.

## Changes

- The existing viewport owner now supplies iOS visual height and origin
  independently. The mobile iOS root is fixed to that frame. Android retains
  its previous viewport calculation. Pinch zoom does not repeatedly resize the
  app to the magnified viewport.
- Mobile toolbar controls cannot wrap. Send/Steer/Queue/cancel remain outside
  the horizontally scrollable overflow area. Reply/New Agent becomes a labelled
  icon on mobile; dictation status remains available to screen readers, with
  errors still visible. Desktop presentation and routing remain unchanged.
- Existing desktop Project-chat dictation enablement remains part of PR 486.

## Verification

Web typecheck and full production build passed. The isolated Chromium browser
matrix passed all six iPhone/Android/desktop and mention/no-mention profiles.
It now includes the real runtime selector, mocked active speech recognition,
320/390/412px toolbar geometry, and independent visual height/pan offset changes
through repeated open/close sequences. Existing newline, IME, send, long-draft,
attachment-menu, and rotation/reduced-height checks remain. The 390px active
dictation screenshot was visually inspected: chip row plus one controls row.
No real microphones, messages, providers, or user projects were used.

## Remaining qualification

Synthetic viewport events and mocked speech recognition are not a physical
iPhone keyboard reproduction. Safari and installed PWA still need device
verification: repeated focus/dismiss, long drafts, rotation, dictation, and
visible caret/Send. The operator's exact iOS version is not yet known. No
physical Android, native microphone, or screen-reader certification is claimed.
Deployment remains pending approval.
