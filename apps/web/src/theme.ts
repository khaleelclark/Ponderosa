import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#245c53",
      dark: "#173f39",
      light: "#5f8f85",
    },
    secondary: {
      main: "#8f4b2e",
    },
    background: {
      default: "#f6f7f4",
      paper: "#ffffff",
    },
    success: {
      main: "#277a46",
    },
    warning: {
      main: "#a86f1b",
    },
    error: {
      main: "#b23b45",
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { letterSpacing: 0 },
    h2: { letterSpacing: 0 },
    h3: { letterSpacing: 0 },
    h4: { letterSpacing: 0 },
    h5: { letterSpacing: 0 },
    h6: { letterSpacing: 0 },
    button: { textTransform: "none", fontWeight: 700, letterSpacing: 0 },
  },
  components: {
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true,
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          minHeight: 40,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          minWidth: 44,
          minHeight: 44,
        },
      },
    },
  },
});
