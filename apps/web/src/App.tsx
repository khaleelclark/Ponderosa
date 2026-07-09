import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

// Chunk A placeholder. The four-pane PWA (SPEC §12) lands in Chunk G.
export default function App(): JSX.Element {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Typography variant="h3" component="h1">
        Ponderosa
      </Typography>
    </Box>
  );
}
