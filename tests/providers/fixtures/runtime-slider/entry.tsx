import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { ComposerRuntimeSelector } from "../../../../apps/web/src/components/ComposerRuntimeSelector";
import { createPonderosaTheme } from "../../../../apps/web/src/theme";

// Real React/MUI/native input; no transport. A listener registered after MUI's
// drag listener checks whether this event's thumb position is already painted
// into the DOM. No fixture state update runs during mousemove and masks a lag.
const efforts = ["Low", "Medium", "High", "Extra High"].map(label => ({ id: label, label }));
function App() {
  const [effort, setEffort] = useState("Low"), [report, setReport] = useState("Drag the slider, then inspect the trace.");
  const commits = useRef(0), traces = useRef<{ samples: { expected: number; actual: number; current: boolean }[]; stale: number }[]>([]);
  useEffect(() => {
    let move: ((event: MouseEvent) => void) | undefined, end: (() => void) | undefined;
    const start = (event: MouseEvent) => {
      const slider = (event.target as Element).closest<HTMLElement>(".MuiSlider-root");
      if (!slider) return;
      const thumb = slider.querySelector<HTMLElement>(".MuiSlider-thumb")!;
      const samples: { expected: number; actual: number; current: boolean }[] = [];
      move = event => {
        if (!event.buttons) return;
        const bounds = slider.getBoundingClientRect();
        const expected = Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (efforts.length - 1));
        const actual = Math.round(parseFloat(thumb.style.left) / 100 * (efforts.length - 1));
        samples.push({ expected, actual, current: expected === actual });
      };
      end = () => {
        document.removeEventListener("mousemove", move!);
        requestAnimationFrame(() => {
          traces.current.push({ samples, stale: samples.filter(sample => !sample.current).length });
          setReport(JSON.stringify({ stalePositions: traces.current.reduce((sum, trace) => sum + trace.stale, 0), samples: traces.current.reduce((sum, trace) => sum + trace.samples.length, 0), commits: commits.current, traces: traces.current }, null, 2));
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end, { once: true });
    };
    document.addEventListener("mousedown", start);
    return () => { document.removeEventListener("mousedown", start); if (move) document.removeEventListener("mousemove", move); if (end) document.removeEventListener("mouseup", end); };
  }, []);
  const inspectTouch = () => {
    document.getElementById("coarse-replay")?.remove();
    // Replay the actual generated coarse-pointer declarations, in cascade
    // order. This isolates touch CSS on a Mac; it is not a physical phone test.
    const rules = (items: CSSRuleList): string[] => Array.from(items).flatMap(rule =>
      rule instanceof CSSMediaRule && rule.conditionText === "(pointer: coarse)" ? Array.from(rule.cssRules, rule => rule.cssText)
        : "cssRules" in rule ? rules((rule as CSSGroupingRule).cssRules) : []);
    const style = document.createElement("style"); style.id = "coarse-replay";
    style.textContent = Array.from(document.styleSheets).flatMap(sheet => rules(sheet.cssRules)).join("\n");
    document.head.append(style);
    const slider = document.querySelector<HTMLElement>(".MuiSlider-root")!, thumb = slider.querySelector(".MuiSlider-thumb")!.getBoundingClientRect();
    const fill = document.querySelector(".runtime-effort-fill")!.getBoundingClientRect();
    setReport(JSON.stringify({ coarseCssReplayed: true, thumbTrackCenterDifference: Math.abs((thumb.top + thumb.bottom - fill.top - fill.bottom) / 2), sliderHeight: slider.getBoundingClientRect().height, paddingTop: getComputedStyle(slider).paddingTop }, null, 2));
  };
  const replayDrag = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const slider = document.querySelector<HTMLElement>(".MuiSlider-root")!, bounds = slider.getBoundingClientRect();
    const input = slider.querySelector("input")!, from = Number(input.value) / (efforts.length - 1), to = from < 0.5 ? 1 : 0;
    const send = (type: string, fraction: number, target: EventTarget = document) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: bounds.left + bounds.width * fraction, clientY: bounds.top + bounds.height / 2 }));
    send("mousedown", from, slider);
    for (let i = 1; i <= 8; i++) { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); send("mousemove", from + (to - from) * i / 8); }
    send("mouseup", to);
  };
  return <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <main style={{ padding: 24, paddingTop: 340 }}>
      <p>Native drag regression: stale positions must be zero. Touch center difference must be at most 1px; hit height at least 44px.</p>
      <ComposerRuntimeSelector engine="fixture" engines={[{ id: "fixture", label: "Fixture" }]} model="model" models={[{ id: "model", label: "Model" }]} effort={effort} efforts={efforts} selectionKey="fixture" scopeLabel="Native input Next Run"
        onModelChange={() => {}} onEffortChange={value => { commits.current++; setEffort(value); }} onReset={() => setEffort("Low")} />
      <button onClick={inspectTouch}>Inspect touch geometry</button>
      <button onClick={event => { void replayDrag(event).catch(error => setReport(String(error))); }}>Replay drag events</button>
      <pre role="status">{report}</pre>
    </main>
  </ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
