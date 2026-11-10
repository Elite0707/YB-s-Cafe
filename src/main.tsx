import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./shared/ErrorBoundary";
import { initializeTheme } from "./shared/ThemeToggle";
import "./styles.css";

initializeTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary><BrowserRouter><App /></BrowserRouter></ErrorBoundary>
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed", error);
    });
  });
}
