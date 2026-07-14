import { Box, CircularProgress, Typography } from "@mui/material";
import { EmojiPicker } from "frimousse";

export default function EmojiPalette({ onSelect }: { onSelect(emoji: string): void }): JSX.Element {
  return (
    <EmojiPicker.Root
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
      columns={8}
      style={{ width: "100%" }}
    >
      <EmojiPicker.Search
        aria-label="Search emoji"
        autoFocus
        style={{ width: "100%", minHeight: 44, padding: "8px 12px", borderRadius: 8, border: "1px solid currentColor" }}
      />
      <EmojiPicker.Viewport style={{ height: 300, marginTop: 8 }}>
        <EmojiPicker.Loading>
          <Box sx={{ display: "grid", placeItems: "center", height: 120 }}><CircularProgress size={24} /></Box>
        </EmojiPicker.Loading>
        <EmojiPicker.Empty><Typography sx={{ p: 2 }}>No emoji found.</Typography></EmojiPicker.Empty>
        <EmojiPicker.List
          components={{
            CategoryHeader: ({ category, ...props }) => <div {...props} className="emoji-category">{category.label}</div>,
            Row: (props) => <div {...props} className="emoji-row" />,
            Emoji: ({ emoji, ...props }) => <button type="button" {...props} className={emoji.isActive ? "emoji-cell emoji-cell-active" : "emoji-cell"}>{emoji.emoji}</button>,
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
