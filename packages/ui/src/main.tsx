import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { applyTheme, getThemePreference, watchSystemTheme } from "./lib/theme";
import "./styles/global.css";

// Apply theme before first paint (also set in index.html boot script when present)
applyTheme(getThemePreference());
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
