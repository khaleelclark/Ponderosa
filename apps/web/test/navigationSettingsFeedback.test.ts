import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/components/WorkspaceOverview.tsx", import.meta.url), "utf8");
const wiki = readFileSync(new URL("../src/components/WikiView.tsx", import.meta.url), "utf8");
const globalSearch = readFileSync(new URL("../src/components/GlobalChatSearch.tsx", import.meta.url), "utf8");

describe("navigation and settings feedback", () => {
  it("keeps Project import exact, icon-backed, and available from Project settings", () => {
    expect(app).toContain('startIcon={<FileUploadOutlinedIcon />}');
    expect(app).toContain(">Import Agent or Organization</Button>");
    expect(app).not.toContain("Import Agent or Organization…");
  });

  it("keeps keyboard helpers out of local Project-chat search and mobile navigation", () => {
    const projectSearch = sidebar.slice(sidebar.indexOf('placeholder="Search Project Chats"'), sidebar.indexOf("New Project Chat"));
    expect(projectSearch).not.toContain("component=\"kbd\"");
    expect(sidebar).toContain('<SearchIcon /></RailButton>');
    expect(sidebar).toContain("globalSearchShortcutAccessibleLabel()");
    expect(sidebar).not.toContain('component="kbd"');
    expect(sidebar).not.toContain("Search All Chats</Box>");
    expect(globalSearch).toContain('display: { xs: "none", md: "inline-flex" }');
    expect(globalSearch).toContain('aria-label="Escape"');
    expect(globalSearch).not.toContain("Navigate</Typography>");
    expect(globalSearch).not.toContain("Open in new tab</Typography>");
  });

  it("allows Project titles and Wiki content to consume their available width", () => {
    expect(sidebar).toContain('overflowWrap: "anywhere"');
    expect(overview).toContain('primaryTypographyProps={{ fontWeight: 750, sx: { overflowWrap: "anywhere" } }}');
    expect(wiki).toContain('xl: "270px minmax(0, 1fr) 280px"');
    expect(wiki).not.toContain('minmax(0, 820px)');
  });

  it("keeps drag handles available before custom sort is selected", () => {
    expect(overview).toContain('<Tooltip title={`Drag to reorder ${snapshot.project.label}`}>');
    expect(overview).not.toContain('preferences.projectSort === "custom" ? <Tooltip title={`Drag to reorder');
  });

  it("uploads Operator pictures to the managed API without browser storage or base64", () => {
    expect(app).toContain("api.uploadOperatorAvatar(file)");
    expect(app).toContain('OPERATOR_PROFILE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif"');
    expect(app).toContain("OPERATOR_PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024");
    expect(app).toContain("HEIC is not accepted");
    const profileDialog = app.slice(app.indexOf("<Dialog open={operatorProfileOpen}"), app.indexOf("<Dialog open={projectSettingsOpen}"));
    expect(profileDialog).not.toContain("localStorage");
    expect(profileDialog).not.toContain("base64");
  });

  it("keeps mobile drawer dismissal both gestural and explicit", () => {
    expect(app).toContain("<SwipeableDrawer");
    expect(app).toContain("onClose={() => setMobileNavOpen(false)}");
    expect(app).toContain('aria-label="Close workspace navigation"');
    expect(app).toContain('right: 8, minWidth: 44, minHeight: 44');
  });
});
