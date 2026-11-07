# Notification defaults

New installations keep ordinary Agent responses and Project broadcasts quiet: both notification settings default to off. Activity still appears in Chat history. Separate durable unread metadata makes the Chat title bold without creating a notification badge or push. Reading visible messages clears their quiet unread state, including across restart. Enable **Direct Agent responses** or **Project broadcasts** in notification settings to create those alerts. Existing saved choices are preserved across restart and upgrade; an absent preference defaults to off.

These switches control communication alerts. Decisions and operational failures retain their existing actionable notifications. Branches uses the same workspace preference defaults.

Unread state is recorded independently of global alert categories and Chat or Agent alert modes. Muted and attention-only Chats still show ordinary unread activity quietly. When an allowed alert represents that activity, it counts once; reading the visible Communication clears both forms, so changing alert modes does not revive already-read replies.

`POST /api/notifications/projection` also accepts up to 200 `branchIds`; the shared client batches larger workflow catalogs. The server resolves current Chat membership and returns `branches` counts through the same canonical projection and the request's Core/Branches product scope. Only requested Chat/folder summaries are returned, without exposing a workflow's full membership. Visible-message acknowledgments clear the same canonical Communication identities and refresh both workflow and Chat projections.
