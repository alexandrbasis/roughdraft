import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { initializeTheme } from "./theme";
import "./style.css";

initializeTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <ThemeSwitcher />
    </TooltipProvider>
  </StrictMode>,
);
