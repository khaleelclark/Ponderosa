# Message timestamps

Chat messages show an absolute, viewer-local date and time in both master chats
and agent conversations. Each label is a native HTML `<time>` element whose
`datetime` value is the normalized ISO 8601 instant received from the server.
The tooltip expands the label to include the weekday, seconds, and timezone.

Absolute labels are intentional: they remain correct while a page is left open,
and they expose calendar and year boundaries that relative labels can hide.
Invalid date values are omitted rather than announced as misleading times.

The timestamp is contained by its message bubble and may wrap in long locales,
so it does not introduce horizontal scrolling on phone layouts. Formatting uses
the browser's locale and timezone; therefore screenshots and spoken labels vary
appropriately with the operator's device settings.
