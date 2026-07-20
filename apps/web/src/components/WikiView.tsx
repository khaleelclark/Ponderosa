import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert, Box, Chip, CircularProgress, Divider, InputAdornment, Link, List,
  ListItemButton, ListItemText, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import type { WikiArticleSummaryDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { Route } from "../routing";

function headingId(children: unknown): string {
  return String(children).toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function articleIdFromRef(ref: string): string {
  return ref.slice("ponderosa://docs/".length);
}

export function WikiView({ articleId, navigate }: { articleId?: string; navigate(route: Route): void }): JSX.Element {
  const [search, setSearch] = useState("");
  const index = useQuery({ queryKey: ["wiki", "index"], queryFn: () => api.getWikiIndex(), staleTime: 60_000 });
  const articles = useMemo(() => index.data?.sections.flatMap((section) => section.articles) ?? [], [index.data]);
  const activeId = articleId ?? articles[0]?.id;
  const article = useQuery({
    queryKey: ["wiki", "article", activeId], queryFn: () => api.getWikiArticle(activeId!), enabled: Boolean(activeId), staleTime: 60_000,
  });
  const normalizedSearch = search.trim();
  const results = useQuery({
    queryKey: ["wiki", "search", normalizedSearch], queryFn: () => api.searchWiki(normalizedSearch, 20),
    enabled: normalizedSearch.length >= 2, staleTime: 30_000,
  });
  const open = (candidate: WikiArticleSummaryDto) => {
    setSearch("");
    navigate({ kind: "wiki", articleId: candidate.id });
  };

  return <Box sx={{ minHeight: 0, height: "100%", overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
    <Paper square elevation={0} sx={{ px: { xs: 2, md: 3 }, py: 1.5, borderBottom: 1, borderColor: "divider", zIndex: 2 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: { sm: 230 } }}>
          <MenuBookOutlinedIcon color="primary" />
          <Box><Typography variant="h6" component="h1" fontWeight={850}>Ponderosa Wiki</Typography><Typography variant="caption" color="text.secondary">Version-controlled product guide</Typography></Box>
        </Stack>
        <Box sx={{ position: "relative", flex: 1, maxWidth: 720 }}>
          <TextField fullWidth size="small" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product documentation" inputProps={{ "aria-label": "Search product documentation" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }} />
          {normalizedSearch.length >= 2 ? <Paper role="listbox" aria-label="Wiki search results" elevation={6} sx={{ position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, maxHeight: 360, overflow: "auto", zIndex: 10, border: 1, borderColor: "divider" }}>
            {results.isLoading ? <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: "center" }}><CircularProgress size={18} /><Typography variant="body2">Searching…</Typography></Stack> : null}
            {results.data?.results.map((result) => <ListItemButton key={result.article.id} role="option" onClick={() => open(result.article)} sx={{ alignItems: "flex-start" }}><ListItemText primary={result.article.title} secondary={result.snippet} primaryTypographyProps={{ fontWeight: 750 }} secondaryTypographyProps={{ sx: { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }} /></ListItemButton>)}
            {results.data && results.data.results.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No documentation matches “{normalizedSearch}”.</Typography> : null}
          </Paper> : null}
        </Box>
      </Stack>
    </Paper>

    <Box sx={{ minHeight: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "250px minmax(0, 1fr)", xl: "270px minmax(0, 820px) 280px" }, justifyContent: "center", overflow: "hidden" }}>
      <Box component="nav" aria-label="Wiki navigation" className="ponderosa-scroll" sx={{ display: { xs: "none", md: "block" }, overflowY: "auto", borderRight: 1, borderColor: "divider", p: 1.5, bgcolor: "background.paper" }}>
        {index.isError ? <Alert severity="error">Wiki navigation could not be loaded.</Alert> : null}
        {index.data?.sections.map((section) => <Box component="section" key={section.id} sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>{section.title}</Typography><List dense disablePadding>{section.articles.map((candidate) => <ListItemButton key={candidate.id} selected={candidate.id === activeId} onClick={() => open(candidate)} sx={{ borderRadius: 1.25, mb: .25 }}><ListItemText primary={candidate.title} primaryTypographyProps={{ fontSize: 13, fontWeight: candidate.id === activeId ? 800 : 600 }} /></ListItemButton>)}</List></Box>)}
      </Box>

      <Box component="article" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: { xs: 2, sm: 4, lg: 6 }, py: { xs: 2.5, md: 4 }, scrollBehavior: "smooth" }}>
        <TextField select fullWidth size="small" label="Wiki article" value={activeId ?? ""} onChange={(event) => {
          const selected = articles.find((candidate) => candidate.id === event.target.value);
          if (selected) open(selected);
        }} sx={{ display: { md: "none" }, mb: 3 }}>{index.data?.sections.flatMap((section) => [
          <MenuItem key={`section:${section.id}`} disabled sx={{ fontWeight: 800 }}>{section.title}</MenuItem>,
          ...section.articles.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.title}</MenuItem>),
        ])}</TextField>
        {article.isLoading || (!activeId && index.isLoading) ? <Box sx={{ display: "grid", placeItems: "center", minHeight: 260 }}><CircularProgress aria-label="Loading wiki article" /></Box> : null}
        {article.isError ? <Alert severity="error">This wiki article could not be loaded.</Alert> : null}
        {article.data ? <>
          <Typography variant="overline" color="primary.main">{article.data.section}</Typography>
          <Typography variant="h3" component="h1" sx={{ mt: .5, mb: 1.5, fontSize: { xs: 34, md: 44 }, lineHeight: 1.08, fontWeight: 880 }}>{article.data.title}</Typography>
          <Typography variant="h6" color="text.secondary" sx={{ fontWeight: 450, lineHeight: 1.5, mb: 3 }}>{article.data.summary}</Typography>
          <Divider sx={{ mb: 3 }} />
          <Box className="wiki-markdown" sx={{ color: "text.primary", lineHeight: 1.75, "& h2": { mt: 4, mb: 1.25, fontSize: 27 }, "& h3": { mt: 3, mb: 1, fontSize: 21 }, "& p": { mb: 2 }, "& li": { mb: .75 }, "& img": { display: "block", width: "100%", maxHeight: 520, objectFit: "contain", my: 3, borderRadius: 2, border: 1, borderColor: "divider", bgcolor: "background.paper" }, "& code": { px: .5, py: .2, borderRadius: .75, bgcolor: "action.hover", fontSize: ".9em" }, "& pre": { overflowX: "auto", p: 2, borderRadius: 2, bgcolor: "action.hover" } }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
              h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
              a: ({ href, children }) => <Link href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel={href?.startsWith("http") ? "noreferrer" : undefined}>{children}</Link>,
              img: ({ src, alt }) => src?.startsWith("/api/wiki/assets/") ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null,
            }}>{article.data.markdown}</ReactMarkdown>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: "divider" }}>
            <Typography variant="subtitle2" sx={{ width: "100%" }}>Related articles</Typography>
            {article.data.relatedRefs.map((ref) => {
              const related = articles.find((candidate) => candidate.id === articleIdFromRef(ref));
              return related ? <Chip key={ref} clickable icon={<ArticleOutlinedIcon />} label={related.title} onClick={() => open(related)} /> : null;
            })}
          </Stack>
        </> : null}
      </Box>

      <Box component="aside" aria-label="Article contents and code links" className="ponderosa-scroll" sx={{ display: { xs: "none", xl: "block" }, overflowY: "auto", borderLeft: 1, borderColor: "divider", p: 2.5, bgcolor: "background.paper" }}>
        {article.data ? <Stack spacing={2.5}>
          <Box><Typography variant="overline" color="text.secondary">On this page</Typography><List dense disablePadding>{article.data.headings.map((heading) => <ListItemButton key={heading.id} component="a" href={`#${heading.id}`} sx={{ borderRadius: 1, pl: heading.depth === 3 ? 2.5 : 1 }}><ListItemText primary={heading.text} primaryTypographyProps={{ fontSize: 12.5 }} /></ListItemButton>)}</List></Box>
          <Divider />
          <Box><Typography variant="overline" color="text.secondary">Code links</Typography><Stack spacing={1} sx={{ mt: 1 }}>{article.data.codeLinks.map((link) => <Link key={link.path} href={link.url} target="_blank" rel="noreferrer" underline="hover" sx={{ display: "flex", alignItems: "flex-start", gap: 1, fontSize: 13 }}><CodeOutlinedIcon sx={{ fontSize: 17, mt: .1 }} /><span>{link.label}<Typography component="span" display="block" variant="caption" color="text.secondary" sx={{ wordBreak: "break-word" }}>{link.path}</Typography></span></Link>)}</Stack></Box>
          <Divider />
          <Box><Typography variant="overline" color="text.secondary">Agent reference</Typography><Typography variant="caption" component="code" sx={{ display: "block", mt: 1, wordBreak: "break-all" }}>{article.data.ref}</Typography></Box>
        </Stack> : null}
      </Box>
    </Box>
  </Box>;
}
