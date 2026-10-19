import { Box, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import type { RichMessageBlock } from "@ponderosa/core";
import type { ReactNode } from "react";
import { ScrollableMessageTable } from "./ScrollableMessageTable";

const tones = { neutral: "default", positive: "success", caution: "warning", negative: "error" } as const;
const axisLabel = (value: number) => String(value).length > 7 ? value.toExponential(1) : String(value);
const shortLabel = (value: string) => [...value].slice(0, 20).join("") + ([...value].length > 20 ? "…" : "");

export function RichMessageDisplay({ block }: { block: RichMessageBlock }): JSX.Element {
  let content: ReactNode;
  if (block.type === "metrics") {
    content = <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1, "@container (max-width: 360px)": { gridTemplateColumns: "1fr" } }}>
      {block.items.map((item, index) => <Box key={index} sx={{ p: 1.25, borderRadius: 1.5, bgcolor: "action.hover", minWidth: 0 }}>
        <Typography component="div" variant="body2" color="text.secondary">{item.label}</Typography>
        <Typography component="div" sx={{ fontSize: "1.35rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {item.value}{item.unit ? <Typography component="span" variant="body2" color="text.secondary"> {item.unit}</Typography> : null}
        </Typography>
        {item.note ? <Typography component="div" variant="caption" color="text.secondary">{item.note}</Typography> : null}
      </Box>)}
    </Box>;
  } else if (block.type === "statuses") {
    content = <Stack spacing={1}>{block.items.map((item, index) => <Box key={index}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Typography component="div" variant="body2" fontWeight={600}>{item.label}</Typography>
        <Chip size="small" variant="outlined" label={item.value} color={tones[item.tone]} sx={{ maxWidth: "100%", height: "auto", minHeight: 24, "& .MuiChip-label": { whiteSpace: "normal", overflowWrap: "anywhere" } }} />
      </Box>
      {item.note ? <Typography component="div" variant="caption" color="text.secondary">{item.note}</Typography> : null}
    </Box>)}</Stack>;
  } else if (block.type === "meters") {
    content = <Stack spacing={1.5}>{block.items.map((item, index) => <Box key={index}>
      <Typography component="div" variant="body2" fontWeight={600}>{item.label} · {item.value} {item.unit}</Typography>
      <LinearProgress variant="determinate" value={(item.value - item.min) / (item.max - item.min) * 100}
        aria-label={item.label} aria-valuemin={item.min} aria-valuemax={item.max} aria-valuenow={item.value}
        aria-valuetext={`${item.value} ${item.unit}; range ${item.min}–${item.max} ${item.unit}`}
        sx={{ my: 0.75, height: 8, borderRadius: 1 }} />
      <Typography component="div" variant="caption" color="text.secondary">Range {item.min}–{item.max} {item.unit}{item.note ? ` · ${item.note}` : ""}</Typography>
    </Box>)}</Stack>;
  } else {
    const points = block.points, values = points.map(point => point.value);
    const min = Math.min(...values), max = Math.max(...values), span = max - min;
    const coordinates = points.map((point, index) => ({
      x: points.length === 1 ? 268 : 72 + index / (points.length - 1) * 392,
      y: span === 0 ? 80 : 144 - (point.value - min) / span * 128,
    }));
    content = <>
      <Typography component="div" variant="caption" color="text.secondary">{block.unit}</Typography>
      {block.type === "bar" ? <Stack component="ul" spacing={1} sx={{ my: 1, "&&": { pl: 0 }, listStyle: "none" }}>
        {points.map((point, index) => <Box component="li" key={index}>
          <Typography component="div" variant="body2">{point.label} · {point.value} {block.unit}</Typography>
          <Box sx={{ height: 10, bgcolor: "action.hover", borderRadius: 1, overflow: "hidden" }}>
            <Box sx={{ height: "100%", width: `${max === 0 ? 0 : point.value / max * 100}%`, bgcolor: "primary.main" }} />
          </Box>
        </Box>)}
      </Stack> : <Box sx={{ color: "primary.main" }}>
        <svg viewBox="0 0 480 180" role="img" aria-label={`${block.title} (${block.unit}); values follow the table order`} style={{ display: "block", width: "100%", height: "auto" }}>
          <title>{`${block.title} (${block.unit})`}</title>
          <path d="M72 16V144H464" stroke="currentColor" opacity="0.3" fill="none" />
          <text x="0" y="24" fill="currentColor" fontSize="11">{axisLabel(max)}</text>
          {span > 0 ? <text x="0" y="144" fill="currentColor" fontSize="11">{axisLabel(min)}</text> : null}
          <polyline points={coordinates.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
          {coordinates.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="3" fill="currentColor" />)}
          <text x="72" y="172" fill="currentColor" fontSize="11">{shortLabel(points[0]!.label)}</text>
          {points.length > 1 ? <text x="464" y="172" textAnchor="end" fill="currentColor" fontSize="11">{shortLabel(points.at(-1)!.label)}</text> : null}
        </svg>
      </Box>}
      {block.type === "line" ? <ScrollableMessageTable aria-label={`${block.title} data`}><thead><tr><th scope="col">Label</th><th scope="col" style={{ textAlign: "right" }}>Value ({block.unit})</th></tr></thead>
          <tbody>{points.map((point, index) => <tr key={index}><td>{point.label}</td><td style={{ textAlign: "right" }}>{point.value}</td></tr>)}</tbody>
      </ScrollableMessageTable> : null}
    </>;
  }
  return <Box component="figure" data-ponderosa-rich={block.type} aria-label={block.title ?? block.type} sx={{ containerType: "inline-size", mx: 0, my: 1, p: 1.5, maxWidth: "100%", minWidth: 0, border: 1, borderColor: "divider", borderRadius: 2, overflowWrap: "anywhere" }}>
    {block.title ? <Typography component="figcaption" variant="body1" fontWeight={700} sx={{ mb: 1 }}>{block.title}</Typography> : null}
    {content}
  </Box>;
}
