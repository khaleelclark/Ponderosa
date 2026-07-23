import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { Button, IconButton, Tooltip } from "@mui/material";

export const CHAT_BOTTOM_THRESHOLD = 48;

export function isChatNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= CHAT_BOTTOM_THRESHOLD;
}

export function scrollChatToBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop">): void {
  element.scrollTop = element.scrollHeight;
}

export function ScrollToLatestButton({ visible, onClick, label = "Jump to latest message" }: { visible: boolean; onClick(): void; label?: string }): JSX.Element | null {
  if (!visible) return null;
  const sharedSx = {
    position: "absolute",
    right: { xs: 12, sm: 20 },
    bottom: 14,
    zIndex: 2,
    boxShadow: 3,
  } as const;
  if (label === "Jump to latest message") return <Tooltip title="Jump to Latest Message">
    <IconButton
      aria-label="Jump to latest message"
      onClick={onClick}
      sx={{
        ...sharedSx,
        width: 36,
        height: 36,
        color: "primary.light",
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.selected" },
      }}
    ><KeyboardArrowDownIcon /></IconButton>
  </Tooltip>;
  return <Tooltip title={label}>
    <Button
      aria-label={label}
      size="small"
      variant="contained"
      onClick={onClick}
      startIcon={<KeyboardArrowDownIcon />}
      sx={sharedSx}
    >{label}</Button>
  </Tooltip>;
}

const scrollActivityTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function revealChatScrollbar(element: HTMLElement): void {
  element.classList.add("is-scrolling");
  const activeTimer = scrollActivityTimers.get(element);
  if (activeTimer) clearTimeout(activeTimer);
  const timer = setTimeout(() => {
    element.classList.remove("is-scrolling");
    scrollActivityTimers.delete(element);
  }, 700);
  scrollActivityTimers.set(element, timer);
}
