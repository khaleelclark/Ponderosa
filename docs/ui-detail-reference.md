# UI detail reference

Short labels and contextual hints stay in the interface. Detailed behavior is documented here.

## Add or duplicate Agents

Duplicate creates a separate Agent in a chat. Import accepts a portable JSON package.

Choose the source Agent here; the next step lets you select scope, contents, destination chat, and the new root name.

## Change a manager

This changes which Agent delegates work to this Agent. Its Run and message history remain attached to the same Agent.

## Working folders and browser profiles

Shared is best when Agents need to see each other's changes immediately. Separate Git gives this Agent its own branch and folder for code work.

Disposable profiles start clean. Trusted profiles retain cookies, logins, and site storage on this Ponderosa host and are leased to only one browser at a time.

## Tool permission changes

Ponderosa-hosted tools check current restrictions when called. Provider-native filesystem and connector changes apply on the next Run, using a fresh session when its tool contract changes. This does not cancel work already running or make other allowed tools read-only. Actual tool calls remain in Activity.

## Team Chat

Team Chat shows how Agents coordinate. It is read-only; to talk to an Agent, use Chat and mention them.

## Import history

Imported history remains private historical context and does not appear as new chat messages. Agent packages do not include credentials.

## Provider status and usage

Ponderosa reports local configuration, sign-in, and runtime access. Supported providers expose account limits in Provider usage; Provider Activity shows individual Run telemetry, not billing.

## Notification settings

Saves immediately. Controls in-app notifications and browser push. Work, messages, and pending decisions are unchanged.

## Global settings

Applies to every Agent on the next fresh provider session. Chat and Agent instructions follow it. Behavioral preferences, such as preferred models, are guidance rather than guaranteed structural routing.

Applies to regular Ponderosa Chats and their Agents. Chat and Agent settings may add restrictions; they cannot undo these defaults. Branches has its own policies.

Minimum 75,000. Fresh Ponderosa sessions already consume substantial context, so lower values can cause repeated rollover. Default 150,000.

Applies only to providers that report a window size (Codex does; Claude does not). Catches sessions configured with a small window, where the token ceiling above would never be reached.

Choose which Agent updates appear in Notifications and browser push. Chat and Agent notification settings can further limit these alerts, including those that need attention.

No specific versions are pinned by the environment. Set ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_FABLE_MODEL, or ANTHROPIC_CUSTOM_MODEL_OPTION to add host-managed choices.

Choose which provider appears in the usage button by default. Agent pages can temporarily show that Agent's active provider.

Latest aliases follow future Claude upgrades. Pinned exact IDs stay on the selected version.

`#` identifies people and Agents; `@` references files. Historical mentions continue to follow your stable identity.

## Files and results

No files or results yet. Generated files, diffs, and test reports appear here; command output is available in the Chat's Work log and Technical details.

## Browse a Chat folder

Live files in this chat’s folder. Browsing does not import files or add them to agent context.

## Call drafts and retry

Read and type in Chat anytime. Calls require a visible foreground page. End stops browser audio and discards unsent words; accepted work continues. An unconfirmed send keeps its full private words only in this mounted call for deliberate retry. This tab stores only an identity marker. End, reopening or reload drops the call’s retry payload and requires Chat review; markers cannot reconstruct words. Retry expires after 24 hours, without promising physical browser or network memory erasure.

## Chat instructions

Applies to this chat and its agents only. Folder membership does not share these instructions.

Existing working-folder associations are preserved. This is not a filesystem sandbox.

## Generated files

No files or results yet. Anything created by an Agent in this Chat will appear here.

## Message delivery evidence

Eligible Team and participant Agent timelines. Visibility does not grant other Agents access to this message.

Linked canonical Request and Join records are shown below. This visible copy is not a second delivery or evidence of leader resumption.

Recorded activation delivery statuses are shown below.

No linked Request or input evidence is available for this visible copy.

A visible handle does not establish delivery, reading, or understanding.

## Recorded changes

Recorded changes from this response, not the current working folder. Each preview shows the latest recorded change for that file in this response.

Agent change history. This working folder is not a Git repository, so no Git diff is available.


## Browser controls and saved browsers

Use the tabs, address bar and page controls in the browser panel. Browser controls & sign-in temporarily disconnects Agent access and shows Chrome itself for private sign-in or Chrome-only prompts. Done signing in returns to the same tabs in Ponderosa. Native hosted desktop and private sign-in controls require Linux; macOS and Windows use the in-app controls. Agents only receive access when you choose Agent. Closing a panel keeps its browser running.

Saving transfers browser ownership from the Chat to the installation. All authorized operators can access its retained tabs and sign-ins. Agents still need explicit permission. Remember sign-ins must already be enabled. Independently supervised browsers survive application restarts, but ending the browser or restarting its host closes tabs. Other browsers close live tabs on application restart.

## Agent package contents

Setup-only packages exclude history and artifacts. Full packages include available Agent history, managed artifacts, and project instructions. Credentials are excluded.

## Capability inheritance

Capabilities are available by default. Broader restrictions remain in effect; each narrower scope may add restrictions.

## Runtime concurrency

The Run concurrency limit applies across Ponderosa immediately. Active Runs finish normally; queued work keeps its scheduler order. Technical byte, page, time and process stability limits remain system-managed.

## Error notices

Filled notices select black or white text to keep at least 4.5:1 contrast for their severity background in both themes.
