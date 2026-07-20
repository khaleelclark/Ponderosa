import AddReactionOutlinedIcon from "@mui/icons-material/AddReactionOutlined";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { lazy, Suspense, useState } from "react";
import type { MessageReactionDto } from "@ponderosa/core";

const EmojiPalette = lazy(() => import("./EmojiPalette"));

export function userReactionMessage(emoji: string): string {
  return `the user reacted with ${emoji}`;
}

/** Accept one emoji grapheme, including flags, skin tones, and ZWJ sequences. */
export function isSingleEmoji(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u.test(value);
}

export function MessageReactions({ reactions = [] }: { reactions?: MessageReactionDto[] }): JSX.Element | null {
  if (reactions.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" aria-label="Message reactions" sx={{ mt: 0.75 }}>
      {reactions.map((reaction) => (
        <Tooltip key={reaction.emoji} title="You">
          <Chip size="small" label={reaction.count > 1 ? `${reaction.emoji} ${reaction.count}` : reaction.emoji} />
        </Tooltip>
      ))}
    </Stack>
  );
}

export function EmojiReactionPicker({
  recipientName,
  onReact,
}: {
  recipientName: string;
  onReact(emoji: string): Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  const send = async (candidate: string) => {
    const emoji = candidate.trim();
    if (!isSingleEmoji(emoji)) {
      setError("Enter one emoji.");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await onReact(emoji);
      setOpen(false);
      setCustomEmoji("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reaction could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Tooltip title={`React to ${recipientName}`}>
        <IconButton
          size="small"
          color="inherit"
          aria-label={`React to ${recipientName} with an emoji`}
          onClick={() => {
            setError(undefined);
            setOpen(true);
          }}
        >
          <AddReactionOutlinedIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => !sending && setOpen(false)} fullWidth maxWidth="xs" aria-labelledby="emoji-reaction-title">
        <DialogTitle id="emoji-reaction-title">React to {recipientName}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            This adds the emoji to the message and privately notifies {recipientName} with the original message attached.
          </Typography>
          <Suspense fallback={<Typography sx={{ py: 4, textAlign: "center" }}>Loading emoji…</Typography>}>
            <EmojiPalette onSelect={(emoji) => void send(emoji)} />
          </Suspense>
          <TextField
            fullWidth
            label="Any emoji"
            value={customEmoji}
            disabled={sending}
            error={Boolean(customEmoji) && !isSingleEmoji(customEmoji)}
            helperText="Type or paste one emoji, including a flag or combined emoji."
            onChange={(event) => setCustomEmoji(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(customEmoji);
              }
            }}
          />
          {error ? <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={sending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={sending || !isSingleEmoji(customEmoji)} onClick={() => void send(customEmoji)}>
            {sending ? "Sending…" : "Send Reaction"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
